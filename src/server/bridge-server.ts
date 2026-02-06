import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnClaude } from './claude-spawner';
import { spawnCodex } from './codex-spawner';
import { parseMultipart } from './multipart';
import { buildPrompt, buildReplyPrompt, formatFeedbackContext, parseQuestion, parseResolutions } from './prompt-builder';
import { JobQueue } from './queue';
import { ThreadFileStore } from './thread-store';
import type { BridgeServerHandle, BridgeServerOptions, FeedbackPayload, Job, Provider, SSEClient, SSEEvent } from './types';

const DEFAULT_PORT = 1111;
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
const CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_FILE_AGE_MS = 60 * 60 * 1000; // 1 hour

function isLocalhostOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function setCors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (isLocalhostOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function ansiColor(hex: string | undefined, text: string): string {
  if (!hex) return text;
  const m = hex.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return text;
  const [, r, g, b] = m;
  return `\x1b[38;2;${parseInt(r!, 16)};${parseInt(g!, 16)};${parseInt(b!, 16)}m${text}\x1b[0m`;
}

function sendSSE(client: SSEClient, event: SSEEvent) {
  try {
    client.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  } catch {
    // Client disconnected
  }
}

export async function createBridgeServer(
  options: BridgeServerOptions = {},
): Promise<BridgeServerHandle> {
  const port = options.port ?? DEFAULT_PORT;
  const projectRoot = options.projectRoot ?? process.cwd();
  const tempDir = options.tempDir ?? join(tmpdir(), 'popmelt-bridge');
  const maxTurns = options.maxTurns ?? 10;
  const maxBudgetUsd = options.maxBudgetUsd ?? 1.0;
  const allowedTools = options.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const claudePath = options.claudePath ?? 'claude';
  const defaultProvider: Provider = options.provider ?? 'claude';

  // Ensure temp dir exists
  await mkdir(tempDir, { recursive: true });

  // Cleanup old files on startup
  cleanupTempDir(tempDir).catch(() => {});

  const queue = new JobQueue();
  const sseClients: Set<SSEClient> = new Set();
  const threadStore = new ThreadFileStore(projectRoot);

  // Wire up SSE broadcasting from queue
  queue.addListener((event: SSEEvent, _jobId: string) => {
    for (const client of sseClients) {
      sendSSE(client, event);
    }
  });

  // Set up the job processor
  queue.setProcessor(async (job: Job) => {
    // Use pre-built reply prompt if available (from POST /reply)
    const replyPrompt = (job as Job & { _replyPrompt?: string })._replyPrompt;
    const provider = job.provider ?? defaultProvider;

    // Load thread history if this job has a threadId (and no reply prompt)
    const threadHistory = !replyPrompt && job.threadId
      ? await threadStore.getThreadHistory(job.threadId)
      : undefined;

    const prompt = replyPrompt ?? buildPrompt(job.screenshotPath, job.feedback, {
      threadHistory: threadHistory && threadHistory.length > 0 ? threadHistory : undefined,
      provider,
    });
    const tag = ansiColor(job.color, `[⊹ ${port}:${job.id}]`);
    console.log(`${tag} Reviewing feedback ${job.screenshotPath} (provider: ${provider})${job.threadId ? ` (thread: ${job.threadId})` : ''}`);
    console.log(`${tag} Prompt includes question instruction: ${prompt.includes('## Questions')}`);

    const onEvent = (event: SSEEvent, jobId: string) => {
      queue.broadcast(event, jobId);
    };

    const { process: proc, result } = provider === 'codex'
      ? spawnCodex(job.id, {
          prompt,
          projectRoot,
          screenshotPath: job.screenshotPath,
          onEvent,
        })
      : spawnClaude(job.id, {
          prompt,
          projectRoot,
          maxTurns,
          maxBudgetUsd,
          allowedTools,
          claudePath,
          onEvent,
        });

    queue.setActiveProcess(proc);

    const spawnResult = await result;
    job.result = spawnResult.text;

    if (spawnResult.success) {
      console.log(`${tag} Iteration complete`);
      job.status = 'done';

      // Parse both questions and resolutions (Claude may resolve some and ask about others)
      const question = parseQuestion(spawnResult.text);
      let resolutions = parseResolutions(spawnResult.text);

      // Diagnostic logging for question detection
      const hasQuestionTag = spawnResult.text.includes('<question>');
      console.log(`${tag} Response analysis: hasQuestionTag=${hasQuestionTag}, parsedQuestion=${question ? `"${question.slice(0, 80)}"` : 'null'}, resolutions=${resolutions.length}, responseLength=${spawnResult.text.length}`);
      if (!hasQuestionTag) {
        // Log tail of response to see what Claude actually said
        const tail = spawnResult.text.slice(-300).replace(/\n/g, '\\n');
        console.log(`${tag} Response tail: ${tail}`);
      }

      // Remap resolution annotationIds when Claude uses IDs that don't match actual annotations.
      // This happens when Claude invents IDs instead of using the ones from the prompt.
      if (resolutions.length > 0 && job.annotationIds && job.annotationIds.length > 0) {
        const realIdSet = new Set(job.annotationIds);
        const allMatch = resolutions.every(r => realIdSet.has(r.annotationId));
        if (!allMatch) {
          console.log(`${tag} Remapping resolution IDs: Claude used [${resolutions.map(r => r.annotationId).join(', ')}] but real IDs are [${job.annotationIds.join(', ')}]`);
          resolutions = resolutions.map((r, i) => ({
            ...r,
            annotationId: job.annotationIds![i % job.annotationIds!.length]!,
          }));
        }
      }

      // Append assistant message to thread store
      if (job.threadId) {
        await threadStore.appendMessage(job.threadId, {
          role: 'assistant',
          timestamp: Date.now(),
          jobId: job.id,
          responseText: spawnResult.text,
          resolutions: resolutions.length > 0 ? resolutions : undefined,
          question: question ?? undefined,
          sessionId: spawnResult.sessionId,
        });
      }

      // Broadcast question event if Claude asked one
      if (question) {
        console.log(`${tag} 💬 Question detected: "${question.slice(0, 120)}" → broadcasting to ${sseClients.size} SSE clients (threadId=${job.threadId ?? job.id}, annotationIds=${job.annotationIds?.join(',') ?? 'none'})`);
        queue.broadcast(
          { type: 'question', jobId: job.id, threadId: job.threadId ?? job.id, question, annotationIds: job.annotationIds },
          job.id,
        );
      }

      queue.broadcast(
        { type: 'done', jobId: job.id, success: true, resolutions: resolutions.length > 0 ? resolutions : undefined, responseText: spawnResult.text, threadId: job.threadId },
        job.id,
      );
    } else {
      console.error(`${tag} Error: ${spawnResult.error}`);
      job.status = 'error';
      job.error = spawnResult.error;
      queue.broadcast(
        {
          type: 'error',
          jobId: job.id,
          message: spawnResult.error || 'Unknown error',
        },
        job.id,
      );
    }
  });

  const server = createServer(async (req, res) => {
    setCors(req, res);

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const path = url.pathname;

    try {
      if (req.method === 'POST' && path === '/send') {
        await handleSend(req, res);
      } else if (req.method === 'GET' && path === '/events') {
        handleEvents(req, res);
      } else if (req.method === 'GET' && path === '/status') {
        handleStatus(res);
      } else if (req.method === 'POST' && path === '/reply') {
        await handleReply(req, res);
      } else if (req.method === 'POST' && path === '/cancel') {
        handleCancel(res);
      } else {
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      console.error('[Bridge] Request error:', err);
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Internal error',
      });
    }
  });

  async function handleSend(req: IncomingMessage, res: ServerResponse) {
    const { screenshot, feedback: feedbackStr, color, provider: providerStr } = await parseMultipart(req);

    let feedback: FeedbackPayload;
    try {
      feedback = JSON.parse(feedbackStr);
    } catch {
      sendJson(res, 400, { error: 'Invalid feedback JSON' });
      return;
    }

    // Write screenshot to temp dir
    const jobId = randomUUID().slice(0, 8);
    const screenshotPath = join(tempDir, `screenshot-${jobId}.png`);
    await writeFile(screenshotPath, screenshot);

    // Extract linkedSelector values for thread matching
    const linkedSelectors = feedback.annotations
      .map(a => a.linkedSelector)
      .filter((s): s is string => !!s);

    // Find or create thread
    let threadId: string | undefined;
    if (linkedSelectors.length > 0) {
      const existingThread = await threadStore.findContinuationThread(linkedSelectors);
      if (existingThread) {
        threadId = existingThread.id;
        // Add any new selectors
        await threadStore.addElementIdentifiers(threadId, linkedSelectors);
      } else {
        const newThread = await threadStore.createThread(jobId, linkedSelectors);
        threadId = newThread.id;
      }
    }

    const annotationIds = feedback.annotations.map(a => a.id);

    const job: Job = {
      id: jobId,
      status: 'queued',
      screenshotPath,
      feedback,
      createdAt: Date.now(),
      color,
      threadId,
      annotationIds,
      provider: (providerStr === 'claude' || providerStr === 'codex') ? providerStr : undefined,
    };

    // Append human message to thread
    if (threadId) {
      const feedbackSummary = feedback.annotations
        .map(a => a.instruction || `[${a.type}]`)
        .join('; ');
      const feedbackContext = formatFeedbackContext(feedback);

      await threadStore.appendMessage(threadId, {
        role: 'human',
        timestamp: Date.now(),
        jobId,
        screenshotPath,
        annotationIds,
        feedbackSummary,
        feedbackContext: feedbackContext || undefined,
      });
    }

    const position = queue.enqueue(job);

    sendJson(res, 200, { jobId, position, threadId });
  }

  async function handleReply(req: IncomingMessage, res: ServerResponse) {
    // Read JSON body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks).toString('utf-8');

    let parsed: { threadId?: string; reply?: string; color?: string; provider?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { threadId, reply, color, provider: providerStr } = parsed;
    if (!threadId || !reply) {
      sendJson(res, 400, { error: 'Missing threadId or reply' });
      return;
    }

    // Validate thread exists
    const thread = await threadStore.getThread(threadId);
    if (!thread) {
      sendJson(res, 404, { error: 'Thread not found' });
      return;
    }

    const jobId = randomUUID().slice(0, 8);

    // Use last screenshot from thread history
    let screenshotPath = '';
    {
      const history = await threadStore.getThreadHistory(threadId);
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]!.screenshotPath) {
          screenshotPath = history[i]!.screenshotPath!;
          break;
        }
      }
    }

    if (!screenshotPath) {
      sendJson(res, 400, { error: 'No screenshot available' });
      return;
    }

    // Append human reply message to thread
    await threadStore.appendMessage(threadId, {
      role: 'human',
      timestamp: Date.now(),
      jobId,
      replyToQuestion: reply,
      screenshotPath,
    });

    // Get full thread history (including the reply we just appended)
    const history = await threadStore.getThreadHistory(threadId);

    // Collect annotation IDs from thread history (for question targeting on follow-ups)
    const annotationIds: string[] = [];
    for (const msg of history) {
      if (msg.annotationIds) {
        for (const id of msg.annotationIds) {
          if (!annotationIds.includes(id)) annotationIds.push(id);
        }
      }
    }

    // Build reply prompt
    const replyProvider = (providerStr === 'claude' || providerStr === 'codex') ? providerStr : undefined;
    const prompt = buildReplyPrompt(screenshotPath, history, replyProvider);

    // Create a minimal job — no new screenshot or feedback needed
    const job: Job = {
      id: jobId,
      status: 'queued',
      screenshotPath,
      feedback: { timestamp: new Date().toISOString(), url: '', viewport: { width: 0, height: 0 }, scrollPosition: { x: 0, y: 0 }, annotations: [], styleModifications: [] },
      createdAt: Date.now(),
      color,
      threadId,
      annotationIds: annotationIds.length > 0 ? annotationIds : undefined,
      provider: replyProvider,
    };

    // Override the job processor prompt for this job by storing it
    (job as Job & { _replyPrompt?: string })._replyPrompt = prompt;

    const position = queue.enqueue(job);
    sendJson(res, 200, { jobId, position, threadId });
  }

  function handleEvents(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // Send initial connection event
    res.write(`event: connected\ndata: {"status":"connected"}\n\n`);

    const client: SSEClient = { id: randomUUID().slice(0, 8), res };
    sseClients.add(client);

    req.on('close', () => {
      sseClients.delete(client);
    });
  }

  function handleStatus(res: ServerResponse) {
    sendJson(res, 200, {
      ok: true,
      activeJob: queue.active
        ? { id: queue.active.id, status: queue.active.status }
        : null,
      queueDepth: queue.depth,
    });
  }

  function handleCancel(res: ServerResponse) {
    const cancelled = queue.cancelActive();
    sendJson(res, 200, { cancelled });
  }

  // Periodic cleanup
  const cleanupTimer = setInterval(() => {
    cleanupTempDir(tempDir).catch(() => {});
  }, CLEANUP_INTERVAL_MS);

  return new Promise<BridgeServerHandle>((resolve, reject) => {
    server.on('error', (err) => {
      // If port is in use, the server is likely already running — treat as success
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.log(`[⊹ already watching :${port}]`);
        resolve({
          port,
          close: async () => {},
        });
        return;
      }
      reject(err);
    });

    server.listen(port, '127.0.0.1', () => {
      console.log(`[⊹ is watching :${port}]`);

      resolve({
        port,
        close: async () => {
          clearInterval(cleanupTimer);
          queue.destroy();

          for (const client of sseClients) {
            try {
              client.res.end();
            } catch {}
          }
          sseClients.clear();

          return new Promise<void>((res) => {
            server.close(() => res());
          });
        },
      });
    });
  });
}

async function cleanupTempDir(tempDir: string) {
  try {
    const files = await readdir(tempDir);
    const now = Date.now();

    for (const file of files) {
      const filePath = join(tempDir, file);
      try {
        const stats = await stat(filePath);
        if (now - stats.mtimeMs > MAX_FILE_AGE_MS) {
          await unlink(filePath);
        }
      } catch {
        // Skip files we can't stat
      }
    }
  } catch {
    // Dir doesn't exist yet, that's fine
  }
}
