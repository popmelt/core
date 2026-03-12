import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { FileEdit, SSEEvent } from './types';

export type { FileEdit };

export type SpawnOptions = {
  prompt: string;
  projectRoot: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  claudePath?: string;
  resumeSessionId?: string;
  model?: string;
  timeoutMs?: number;
  onEvent?: (event: SSEEvent, jobId: string) => void;
};

export type SpawnResult = {
  sessionId?: string;
  text: string;
  success: boolean;
  error?: string;
  fileEdits?: FileEdit[];
  toolsUsed?: string[];
};

const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.ts', '.tsx', '.js', '.jsx', '.css', '.scss',
  '.html', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.java', '.c',
  '.h', '.cpp', '.hpp', '.swift', '.kt', '.sql', '.graphql', '.svg',
  '.env', '.gitignore', '.prettierrc', '.eslintrc',
]);

const MAX_CONTENT_SIZE = 100_000; // 100KB cap

/** Extract text content from Write/Edit tool_use blocks for surfacing in the UI */
function getToolContent(block: { name: string; input?: Record<string, unknown> }): string | undefined {
  const file = (block.input?.file_path || block.input?.path) as string | undefined;
  if (!file) return undefined;

  const ext = file.includes('.') ? `.${file.split('.').pop()!.toLowerCase()}` : '';
  if (!TEXT_EXTENSIONS.has(ext)) return undefined;

  let raw: string | undefined;
  if (block.name === 'Write' && typeof block.input?.content === 'string') {
    raw = block.input.content;
  } else if (block.name === 'Edit' && typeof block.input?.new_string === 'string') {
    raw = block.input.new_string;
  }

  if (!raw) return undefined;
  if (raw.length > MAX_CONTENT_SIZE) return raw.slice(0, MAX_CONTENT_SIZE) + '\n…[truncated]';
  return raw;
}

export function spawnClaude(
  jobId: string,
  options: SpawnOptions,
): { process: ChildProcess; result: Promise<SpawnResult> } {
  const {
    prompt,
    projectRoot,
    maxTurns = 40,
    maxBudgetUsd = 1.0,
    allowedTools = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
    claudePath = 'claude',
    resumeSessionId,
    model,
    timeoutMs: TIMEOUT_MS = 300_000,
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
    env: { ...process.env, ANTHROPIC_API_KEY: undefined, CLAUDECODE: undefined },
  });

  const result = new Promise<SpawnResult>((resolve) => {
    let capturedSessionId: string | undefined;
    const textChunks: string[] = [];
    const fileEdits: FileEdit[] = [];
    let hadError = false;
    let errorMessage = '';

    // Process timeout — SIGTERM then SIGKILL escalation
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    }, TIMEOUT_MS);

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
        seenEventTypes.add(topType);

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
              const toolContent = getToolContent(block);
              onEvent?.({ type: 'tool_use', jobId, tool: block.name, ...(file ? { file } : {}), ...(toolContent ? { content: toolContent } : {}) }, jobId);
              if (block.name === 'Edit' && block.input?.file_path) {
                fileEdits.push({
                  tool: 'Edit',
                  file_path: block.input.file_path,
                  old_string: block.input.old_string,
                  new_string: block.input.new_string,
                  replace_all: block.input.replace_all,
                });
              } else if (block.name === 'Write' && block.input?.file_path) {
                fileEdits.push({
                  tool: 'Write',
                  file_path: block.input.file_path,
                  content: block.input.content,
                });
              }
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
      clearTimeout(timer);
      rl.close();

      // Diagnostic: log event types seen and whether text was captured
      if (textChunks.length === 0 && seenEventTypes.size > 0) {
        console.warn(`[Claude:${jobId}] No text captured. Event types seen: ${[...seenEventTypes].join(', ')}`);
      }

      if (timedOut) {
        hadError = true;
        errorMessage = `Timed out after ${Math.round(TIMEOUT_MS / 60000)} minutes`;
      } else if (code !== 0 && code !== null) {
        hadError = true;
        const stderr = stderrChunks.join('').trim();
        const noTextHint = textChunks.length === 0 && seenEventTypes.size > 0
          ? ` (no text captured, event types: ${[...seenEventTypes].join(', ')})`
          : '';
        errorMessage = stderr
          ? stderr
          : `Claude process exited with code ${code}${noTextHint}`;
      }

      resolve({
        sessionId: capturedSessionId,
        text: textChunks.join(''),
        success: !hadError,
        error: hadError ? errorMessage : undefined,
        fileEdits: fileEdits.length > 0 ? fileEdits : undefined,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      hadError = true;
      errorMessage = err.message;
      resolve({
        sessionId: capturedSessionId,
        text: textChunks.join(''),
        success: false,
        error: errorMessage,
        fileEdits: fileEdits.length > 0 ? fileEdits : undefined,
      });
    });
  });

  return { process: child, result };
}
