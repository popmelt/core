import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { SpawnOptions, SpawnResult } from './claude-spawner';
import type { SSEEvent } from './types';

export type CodexSpawnOptions = SpawnOptions & {
  screenshotPath?: string;
};

/**
 * Strip the `/bin/bash -lc "..."` wrapper that Codex adds around commands,
 * returning just the inner command for display purposes.
 */
function extractShellCommand(raw: string): string {
  // Codex wraps commands as: /bin/bash -lc "actual command here"
  const match = raw.match(/^\/bin\/(?:ba)?sh\s+-\w+\s+"(.*)"$/s);
  if (match) {
    // Unescape the inner command (Codex double-escapes quotes)
    return match[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return raw;
}

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
    env: { ...process.env, CLAUDECODE: undefined },
  });

  const result = new Promise<SpawnResult>((resolve) => {
    let capturedSessionId: string | undefined;
    const textChunks: string[] = [];
    const toolLabels: string[] = [];
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
        if ((eventType === 'item.agentMessage.delta' || eventType === 'item/agentMessage/delta') && parsed.delta?.text) {
          textChunks.push(parsed.delta.text);
          onEvent?.({ type: 'delta', jobId, text: parsed.delta.text }, jobId);
        }

        // Reasoning delta — map to thinking events
        if ((eventType === 'item.reasoning.delta' || eventType === 'item/reasoning/delta') && parsed.delta?.text) {
          onEvent?.({ type: 'thinking', jobId, text: parsed.delta.text }, jobId);
        }

        // Item started — detect tool use with rich detail
        if ((eventType === 'item.started' || eventType === 'item/started') && parsed.item) {
          const itemType = parsed.item.type;
          if (itemType === 'command_execution') {
            // Extract the shell command for display (e.g. "/bin/bash -lc \"sed -n '1,160p' file.ts\"")
            const rawCmd = parsed.item.command as string | undefined;
            const content = rawCmd ? extractShellCommand(rawCmd) : undefined;
            const label = content ? `Bash: ${content.split('\n')[0]!.slice(0, 80)}` : 'Bash';
            toolLabels.push(label);
            onEvent?.({ type: 'tool_use', jobId, tool: 'Bash', ...(content ? { content } : {}) }, jobId);
          } else if (itemType === 'file_change') {
            const file = parsed.item.filename || parsed.item.path;
            toolLabels.push(file ? `Edit ${file.split('/').pop()}` : 'Edit');
            onEvent?.({ type: 'tool_use', jobId, tool: 'Edit', ...(file ? { file } : {}) }, jobId);
          } else if (itemType === 'file_read') {
            const file = parsed.item.filename || parsed.item.path;
            toolLabels.push(file ? `Read ${file.split('/').pop()}` : 'Read');
            onEvent?.({ type: 'tool_use', jobId, tool: 'Read', ...(file ? { file } : {}) }, jobId);
          } else if (itemType === 'web_search') {
            toolLabels.push('WebSearch');
            onEvent?.({ type: 'tool_use', jobId, tool: 'WebSearch' }, jobId);
          } else if (itemType === 'mcp_tool_call') {
            const toolName = parsed.item.tool_name || parsed.item.name || 'MCP';
            toolLabels.push(toolName);
            onEvent?.({ type: 'tool_use', jobId, tool: toolName }, jobId);
          }
        }

        // Item completed — accumulate text, and enrich tool events with results
        if ((eventType === 'item.completed' || eventType === 'item/completed') && parsed.item) {
          if (parsed.item.type === 'agent_message') {
            const itemText = parsed.item.text;
            if (typeof itemText === 'string' && itemText) {
              textChunks.push(itemText);
              onEvent?.({ type: 'delta', jobId, text: itemText }, jobId);
            }
          } else if (parsed.item.type === 'reasoning') {
            const reasoningText = parsed.item.text;
            if (typeof reasoningText === 'string' && reasoningText) {
              onEvent?.({ type: 'thinking', jobId, text: reasoningText }, jobId);
            }
          } else if (parsed.item.type === 'file_change' && Array.isArray(parsed.item.changes)) {
            // Emit per-file events for each change
            for (const change of parsed.item.changes) {
              const file = change.path || change.filename;
              const tool = change.kind === 'add' ? 'Write' : 'Edit';
              if (file) {
                toolLabels.push(`${tool} ${file.split('/').pop()}`);
                onEvent?.({ type: 'tool_use', jobId, tool, file }, jobId);
              }
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

      // Diagnostic: log event types seen and whether text was captured
      if (textChunks.length === 0 && seenEventTypes.size > 0) {
        console.warn(`[Codex:${jobId}] No text captured. Event types seen: ${[...seenEventTypes].join(', ')}`);
      }

      if (code !== 0 && code !== null) {
        hadError = true;
        errorMessage = stderrChunks.join('') || `Codex process exited with code ${code}`;
      }

      resolve({
        sessionId: capturedSessionId,
        text: textChunks.join(''),
        success: !hadError,
        error: hadError ? errorMessage : undefined,
        toolsUsed: toolLabels.length > 0 ? toolLabels : undefined,
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
        toolsUsed: toolLabels.length > 0 ? toolLabels : undefined,
      });
    });
  });

  return { process: child, result };
}
