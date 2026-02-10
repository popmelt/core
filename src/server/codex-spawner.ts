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
    resumeSessionId,
    model,
    onEvent,
  } = options;

  const args: string[] = [];

  if (resumeSessionId) {
    // Resume existing session
    args.push('exec', 'resume', resumeSessionId);
    if (model) args.push('-m', model);
    // Prompt must come before --image (variadic flag would consume it)
    args.push('--json', '--full-auto', prompt);
    if (screenshotPath) {
      args.push('--image', screenshotPath);
    }
  } else {
    args.push('exec', '--json', '--full-auto');
    if (model) args.push('-m', model);
    // Prompt must come before --image (variadic flag would consume it)
    args.push(prompt);
    if (screenshotPath) {
      args.push('--image', screenshotPath);
    }
  }

  const child = spawn('codex', args, {
    cwd: projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
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
        const eventType = parsed.type ?? 'unknown';

        seenEventTypes.add(eventType);

        // Capture thread_id from thread.started event
        if (eventType === 'thread.started' && parsed.thread_id && !capturedSessionId) {
          capturedSessionId = parsed.thread_id;
        }

        // Text delta from agent message streaming
        if (eventType === 'item/agentMessage/delta' && parsed.delta?.text) {
          textChunks.push(parsed.delta.text);
          onEvent?.({ type: 'delta', jobId, text: parsed.delta.text }, jobId);
        }

        // Reasoning delta — map to thinking events
        if (eventType === 'item/reasoning/delta' && parsed.delta?.text) {
          onEvent?.({ type: 'thinking', jobId, text: parsed.delta.text }, jobId);
        }

        // Item started — detect tool use
        if (eventType === 'item/started' && parsed.item) {
          const itemType = parsed.item.type;
          if (itemType === 'command_execution') {
            onEvent?.({ type: 'tool_use', jobId, tool: 'Bash' }, jobId);
          } else if (itemType === 'file_change') {
            const file = parsed.item.filename || parsed.item.path;
            onEvent?.({ type: 'tool_use', jobId, tool: 'Edit', ...(file ? { file } : {}) }, jobId);
          } else if (itemType === 'file_read') {
            const file = parsed.item.filename || parsed.item.path;
            onEvent?.({ type: 'tool_use', jobId, tool: 'Read', ...(file ? { file } : {}) }, jobId);
          } else if (itemType === 'web_search') {
            onEvent?.({ type: 'tool_use', jobId, tool: 'WebSearch' }, jobId);
          } else if (itemType === 'mcp_tool_call') {
            const toolName = parsed.item.tool_name || parsed.item.name || 'MCP';
            onEvent?.({ type: 'tool_use', jobId, tool: toolName }, jobId);
          }
        }

        // Item completed — accumulate full text from agent messages and reasoning
        if (eventType === 'item/completed' && parsed.item) {
          if (parsed.item.type === 'agent_message') {
            const itemText = parsed.item.text;
            if (typeof itemText === 'string' && itemText) {
              textChunks.push(itemText);
            }
          } else if (parsed.item.type === 'reasoning') {
            const reasoningText = parsed.item.text;
            if (typeof reasoningText === 'string' && reasoningText) {
              onEvent?.({ type: 'thinking', jobId, text: reasoningText }, jobId);
            }
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

      if (code !== 0 && code !== null) {
        hadError = true;
        errorMessage = stderrChunks.join('') || `Codex process exited with code ${code}`;
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
