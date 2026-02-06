import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { SSEEvent } from './types';

export type SpawnOptions = {
  prompt: string;
  projectRoot: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  claudePath?: string;
  onEvent?: (event: SSEEvent, jobId: string) => void;
};

export type SpawnResult = {
  sessionId?: string;
  text: string;
  success: boolean;
  error?: string;
};

export function spawnClaude(
  jobId: string,
  options: SpawnOptions,
): { process: ChildProcess; result: Promise<SpawnResult> } {
  const {
    prompt,
    projectRoot,
    maxTurns = 10,
    maxBudgetUsd = 1.0,
    allowedTools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
    claudePath = 'claude',
    onEvent,
  } = options;

  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(maxTurns),
    '--max-budget-usd', String(maxBudgetUsd),
  ];

  for (const tool of allowedTools) {
    args.push('--allowedTools', tool);
  }

  const child = spawn(claudePath, args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
  });

  const result = new Promise<SpawnResult>((resolve) => {
    let capturedSessionId: string | undefined;
    const textChunks: string[] = [];
    let hadError = false;
    let errorMessage = '';

    const rl = createInterface({ input: child.stdout! });
    const seenEventTypes = new Set<string>();

    rl.on('line', (line) => {
      if (!line.trim()) return;

      try {
        const parsed = JSON.parse(line);

        // Extract session_id from any event
        if (parsed.session_id && !capturedSessionId) {
          capturedSessionId = parsed.session_id;
        }

        // Log top-level keys we see (for debugging event structure)
        const topType = parsed.type ?? (parsed.event?.type ? `event.${parsed.event.type}` : 'unknown');
        if (!seenEventTypes.has(topType)) {
          seenEventTypes.add(topType);
          console.log(`[spawner:${jobId}] New event type: ${topType}`);
        }

        // Capture text from top-level result message (Claude Code may emit final result this way)
        if (parsed.type === 'result' && parsed.result) {
          const resultText = typeof parsed.result === 'string' ? parsed.result : '';
          if (resultText) {
            textChunks.push(resultText);
            onEvent?.({ type: 'delta', text: resultText }, jobId);
          }
          // Also check for nested content blocks in result
          const content = parsed.result?.content ?? parsed.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                textChunks.push(block.text);
                onEvent?.({ type: 'delta', text: block.text }, jobId);
              }
            }
          }
        }

        // Capture text from assistant message content blocks
        // Stream-json format: {"type":"assistant","message":{"content":[...]}}
        if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              textChunks.push(block.text);
              onEvent?.({ type: 'delta', text: block.text }, jobId);
            }
          }
        }

        const event = parsed.event;
        if (!event) return;

        // Text delta
        if (
          event.type === 'content_block_delta' &&
          event.delta?.type === 'text_delta' &&
          event.delta.text
        ) {
          textChunks.push(event.delta.text);
          onEvent?.({ type: 'delta', text: event.delta.text }, jobId);
        }

        // Tool use
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          const toolName = event.content_block.name || 'unknown';
          onEvent?.({ type: 'tool_use', tool: toolName }, jobId);
        }

        // Tool result with file path (for Edit/Write)
        if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta') {
          // We could parse partial JSON for file paths but it's noisy; skip for now
        }
      } catch {
        // Non-JSON line, ignore
      }
    });

    // Capture stderr
    const stderrChunks: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    child.on('close', (code) => {
      rl.close();

      console.log(`[spawner:${jobId}] Process closed (code=${code}). Event types seen: ${[...seenEventTypes].join(', ')}. Text chunks: ${textChunks.length}, total chars: ${textChunks.join('').length}`);

      if (code !== 0 && code !== null) {
        hadError = true;
        errorMessage = stderrChunks.join('') || `Claude process exited with code ${code}`;
      }

      resolve({
        sessionId: capturedSessionId,
        text: textChunks.join(''),
        success: !hadError,
        error: hadError ? errorMessage : undefined,
      });
    });

    child.on('error', (err) => {
      hadError = true;
      errorMessage = err.message;
      resolve({
        sessionId: capturedSessionId,
        text: textChunks.join(''),
        success: false,
        error: errorMessage,
      });
    });
  });

  return { process: child, result };
}
