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
  resumeSessionId?: string;
  model?: string;
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
    resumeSessionId,
    model,
    onEvent,
  } = options;

  const args: string[] = [];

  if (resumeSessionId) {
    // Resume existing session — context is already cached
    args.push('--resume', resumeSessionId, '-p', prompt);
  } else {
    args.push('-p', prompt);
  }

  args.push(
    '--output-format', 'stream-json',
    '--verbose',
    '--max-turns', String(maxTurns),
    '--max-budget-usd', String(maxBudgetUsd),
  );

  if (model) {
    args.push('--model', model);
  }

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

        // Capture text from result message — only as fallback if no text came from assistant messages
        if (parsed.type === 'result' && parsed.result && textChunks.length === 0) {
          const resultText = typeof parsed.result === 'string' ? parsed.result : '';
          if (resultText) {
            textChunks.push(resultText);
            onEvent?.({ type: 'delta', jobId, text: resultText }, jobId);
          }
        }

        // Stream-json format emits complete messages, not streaming deltas.
        // Each assistant message contains full content blocks: text, tool_use, thinking.
        if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
          for (const block of parsed.message.content) {
            if (block.type === 'text' && block.text) {
              textChunks.push(block.text);
              onEvent?.({ type: 'delta', jobId, text: block.text }, jobId);
            }
            if (block.type === 'tool_use' && block.name) {
              const file = block.input?.file_path || block.input?.path || undefined;
              onEvent?.({ type: 'tool_use', jobId, tool: block.name, ...(file ? { file } : {}) }, jobId);
            }
            if (block.type === 'thinking' && block.thinking) {
              onEvent?.({ type: 'thinking', jobId, text: block.thinking }, jobId);
            }
          }
        }

        // Also handle tool result messages — extract file path for display
        if (parsed.type === 'user' && parsed.tool_use_result?.file?.filePath) {
          // Emit a supplementary tool_use with file info (updates the last tool step label)
          onEvent?.({ type: 'tool_use', jobId, tool: 'Read', file: parsed.tool_use_result.file.filePath }, jobId);
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
