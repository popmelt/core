import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { SpawnOptions, SpawnResult } from './claude-spawner';
import type { SSEEvent } from './types';

export type CodexSpawnOptions = SpawnOptions & {
  screenshotPath?: string;
};

export function spawnCodex(
  jobId: string,
  options: CodexSpawnOptions,
): { process: ChildProcess; result: Promise<SpawnResult> } {
  const {
    prompt,
    projectRoot,
    screenshotPath,
    onEvent,
  } = options;

  const args = [
    'exec',
    '--json',
    '--full-auto',
  ];

  if (screenshotPath) {
    args.push('--image', screenshotPath);
  }

  args.push(prompt);

  const child = spawn('codex', args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  const result = new Promise<SpawnResult>((resolve) => {
    const textChunks: string[] = [];
    let hadError = false;
    let errorMessage = '';

    const rl = createInterface({ input: child.stdout! });
    const seenEventTypes = new Set<string>();

    rl.on('line', (line) => {
      if (!line.trim()) return;

      try {
        const parsed = JSON.parse(line);
        const eventType = parsed.type ?? 'unknown';

        if (!seenEventTypes.has(eventType)) {
          seenEventTypes.add(eventType);
          console.log(`[codex-spawner:${jobId}] New event type: ${eventType}`);
        }

        // Text delta from agent message streaming
        if (eventType === 'item/agentMessage/delta' && parsed.delta?.text) {
          textChunks.push(parsed.delta.text);
          onEvent?.({ type: 'delta', text: parsed.delta.text } as SSEEvent, jobId);
        }

        // Item started — detect tool use
        if (eventType === 'item/started' && parsed.item) {
          if (parsed.item.type === 'command_execution') {
            onEvent?.({ type: 'tool_use', tool: 'Bash' } as SSEEvent, jobId);
          } else if (parsed.item.type === 'file_change') {
            onEvent?.({ type: 'tool_use', tool: 'Edit' } as SSEEvent, jobId);
          }
        }

        // Item completed — accumulate full text from agent messages
        if (eventType === 'item/completed' && parsed.item?.type === 'agent_message') {
          const itemText = parsed.item.text;
          if (typeof itemText === 'string' && itemText) {
            textChunks.push(itemText);
          }
        }

        // Turn failed — flag error
        if (eventType === 'turn.failed') {
          hadError = true;
          errorMessage = parsed.error?.message || parsed.message || 'Turn failed';
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

      console.log(`[codex-spawner:${jobId}] Process closed (code=${code}). Event types seen: ${[...seenEventTypes].join(', ')}. Text chunks: ${textChunks.length}, total chars: ${textChunks.join('').length}`);

      if (code !== 0 && code !== null) {
        hadError = true;
        errorMessage = stderrChunks.join('') || `Codex process exited with code ${code}`;
      }

      resolve({
        text: textChunks.join(''),
        success: !hadError,
        error: hadError ? errorMessage : undefined,
      });
    });

    child.on('error', (err) => {
      hadError = true;
      errorMessage = err.message;
      resolve({
        text: textChunks.join(''),
        success: false,
        error: errorMessage,
      });
    });
  });

  return { process: child, result };
}
