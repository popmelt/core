import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCanvasHtml } from './canvas-html';
import { spawnClaude } from './claude-spawner';
import { spawnCodex } from './codex-spawner';
import { DecisionStore } from './decision-store';
import { Materializer } from './materializer';
import { detectClaudeMcp, detectCodexMcp } from './mcp-detect';
import { installClaudeMcp, installCodexMcp } from './mcp-install';
import { parseMultipart } from './multipart';
import { buildPrompt, buildReplyPrompt, formatFeedbackContext, parseNovelPatterns, parseQuestion, parseResolutions } from './prompt-builder';
import { JobQueue } from './queue';
import { ThreadFileStore } from './thread-store';
import type { McpDetection, PopmeltHandle, PopmeltOptions, FeedbackPayload, Job, PersistedSegment, Provider, SSEClient, SSEEvent } from './types';
import { VERSION } from '../version';

const DEFAULT_PORT = 1111;
const DEFAULT_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'Bash(curl:*)'];
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

/** Build chronological PersistedSegment[] from buffered SSE events */
function buildPersistedSegments(events: Array<SSEEvent & { seq: number }>): PersistedSegment[] {
  const segments: PersistedSegment[] = [];
  for (const e of events) {
    if (e.type === 'delta') {
      const text = e.text;
      if (!text) continue;
      const last = segments[segments.length - 1];
      if (last && last.kind === 'text') {
        last.text += text;
      } else {
        segments.push({ kind: 'text', text });
      }
    } else if (e.type === 'tool_use') {
      const tool = e.tool || '';
      const file = e.file ?? undefined;
      const content = e.content ?? undefined;
      const basename = file ? file.split('/').pop() ?? file : undefined;
      let label: string;
      switch (tool) {
        case 'Read': label = basename ? `Reading ${basename}` : 'Reading file'; break;
        case 'Edit': label = basename ? `Editing ${basename}` : 'Editing file'; break;
        case 'Write': label = basename ? `Writing ${basename}` : 'Writing file'; break;
        case 'Bash': label = content ? content.split('\n')[0]!.trim().slice(0, 60) : 'Running command'; break;
        case 'Glob': label = 'Searching files'; break;
        case 'Grep': label = 'Searching code'; break;
        case 'WebFetch': label = 'Fetching page'; break;
        case 'WebSearch': label = 'Searching web'; break;
        default: label = tool ? `Using ${tool}` : 'tool'; break;
      }
      const detail = file ?? content ?? undefined;
      const last = segments[segments.length - 1];
      if (last && last.kind === 'tool_group' && last.tool === tool) {
        last.items.push({ label, detail });
      } else {
        segments.push({ kind: 'tool_group', tool, items: [{ label, detail }] });
      }
    }
    // Skip thinking, job_started, done, error, etc.
  }
  return segments;
}

function setCors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (isLocalhostOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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

/** Probe a running bridge at the given port. Returns parsed /status JSON or null. */
export async function probeBridge(port: number): Promise<Record<string, unknown> | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Try to bind an http.Server to a port. Resolves on success, rejects on error. */
function listenOnPort(server: import('node:http').Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => { server.removeListener('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

export async function createPopmelt(
  options: PopmeltOptions = {},
): Promise<PopmeltHandle> {
  const basePort = options.port ?? DEFAULT_PORT;
  const projectRoot = options.projectRoot ?? process.cwd();
  const projectId = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);
  let devOrigin: string | null = options.devOrigin
    ?? (process.env.PORT ? `http://localhost:${process.env.PORT}` : null);
  const tempDir = options.tempDir ?? join(tmpdir(), 'popmelt-bridge');
  const maxTurns = options.maxTurns ?? 40;
  const maxBudgetUsd = options.maxBudgetUsd ?? 1.0;
  const allowedTools = [...(options.allowedTools ?? DEFAULT_ALLOWED_TOOLS)];
  const claudePath = options.claudePath ?? 'claude';
  const defaultProvider: Provider = options.provider ?? 'claude';
  const timeoutMs = options.timeoutMs;

  // `port` is set after binding — all closures below capture via `boundPort`
  let boundPort = basePort;

  // Probe for installed CLI providers
  type ProviderCapability = { available: boolean; path: string | null; mcp?: McpDetection };
  const capabilities: Record<string, ProviderCapability> = {};
  for (const cli of ['claude', 'codex']) {
    try {
      const cliPath = execFileSync('which', [cli], { encoding: 'utf-8' }).trim();
      capabilities[cli] = { available: true, path: cliPath };
    } catch {
      capabilities[cli] = { available: false, path: null };
    }
  }

  /** Fire --version to prime OS file/binary caches. No API calls, no side effects. */
  function warmUpCli(cli: string, cliPath: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(cliPath, ['--version'], {
        stdio: ['ignore', 'ignore', 'ignore'],
      });

      let resolved = false;
      const done = (value: boolean) => { if (!resolved) { resolved = true; resolve(value); } };

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        done(true);
      }, 5_000);

      child.on('error', () => { clearTimeout(timeout); done(false); });
      child.on('close', (code) => { clearTimeout(timeout); done(code === 0); });
    });
  }

  // Detect MCP server configuration for each provider
  const [claudeMcp, codexMcp] = await Promise.all([
    detectClaudeMcp(projectRoot),
    detectCodexMcp(projectRoot),
  ]);
  if (capabilities.claude) capabilities.claude.mcp = claudeMcp;
  if (capabilities.codex) capabilities.codex.mcp = codexMcp;

  // Allow spawned CLIs to use detected MCP tools without interactive permission prompts
  if (claudeMcp.found && claudeMcp.name) {
    allowedTools.push(`mcp__${claudeMcp.name}__*`);
  }

  // Ensure temp dir exists
  await mkdir(tempDir, { recursive: true });

  // Cleanup old files on startup
  cleanupTempDir(tempDir).catch(() => {});

  const queue = new JobQueue(1);
  const sseClients: Set<SSEClient> = new Set();
  const threadStore = new ThreadFileStore(projectRoot);
  const decisionStore = new DecisionStore(projectRoot);
  const materializer = new Materializer(projectRoot, decisionStore, {
    claudePath,
    onEvent: (event) => {
      // Materializer events are global — send to all clients
      for (const client of sseClients) {
        sendSSE(client, event);
      }
    },
  });
  // Recent completed jobs (for reconnect state recovery)
  const RECENT_JOBS_MAX = 20;
  const RECENT_JOBS_TTL_MS = 5 * 60 * 1000; // 5 minutes
  type RecentJob = { id: string; status: 'done' | 'error'; completedAt: number; error?: string; threadId?: string; annotationIds?: string[] };
  const recentJobs: RecentJob[] = [];

  // Canvas manifest cache (5-second TTL)
  let manifestCache: { data: unknown; expires: number } | null = null;
  let renderHash: string | undefined;

  // Wire up SSE broadcasting from queue (sourceId filtering)
  queue.addListener((event: SSEEvent, _jobId: string, sourceId?: string) => {
    for (const client of sseClients) {
      // No sourceId on event → global event, send to all
      // No sourceId on client → legacy client, send all
      // Both present → must match
      if (!sourceId || !client.sourceId || client.sourceId === sourceId) {
        sendSSE(client, event);
      }
    }
  });

  // Set up the job processor
  queue.setProcessor(async (job: Job) => {
    // Use pre-built reply prompt if available (from POST /reply)
    const replyPrompt = (job as Job & { _replyPrompt?: string })._replyPrompt;
    const replyImagePaths = (job as Job & { _replyImagePaths?: string[] })._replyImagePaths;
    const provider = job.provider ?? defaultProvider;

    // Look up the last session ID from the thread for resume mode
    let resumeSessionId: string | undefined;
    if (job.threadId) {
      const thread = await threadStore.getThread(job.threadId);
      if (thread) {
        // Find the last assistant message with a sessionId
        for (let i = thread.messages.length - 1; i >= 0; i--) {
          if (thread.messages[i]!.sessionId) {
            resumeSessionId = thread.messages[i]!.sessionId;
            break;
          }
        }
      }
    }

    // Build the prompt — use a lightweight prompt when resuming, full prompt otherwise
    let prompt: string;
    if (resumeSessionId && replyPrompt) {
      // Resuming with a reply: just send the reply text, the session has full context
      const lastReply = (await threadStore.getThread(job.threadId!))
        ?.messages.filter(m => m.role === 'human').pop();
      const replyText = lastReply?.replyToQuestion || lastReply?.feedbackSummary || '';
      prompt = replyText;
      if (replyImagePaths && replyImagePaths.length > 0) {
        prompt += '\n\nThe developer attached reference images with their reply:';
        for (const imgPath of replyImagePaths) {
          prompt += `\nAttached image: use the Read tool to view the image at: ${imgPath}`;
        }
      }
      prompt += '\n\nAfter completing work, output a <resolution> block with declaredScope and inferredScope. If the developer corrected scope, set finalScope. If unclear, output a <question> block.';
    } else if (resumeSessionId) {
      // Resuming with new annotations: send the new feedback context
      prompt = formatFeedbackContext(job.feedback, job.imagePaths)
        + "\n\nFollow the developer's instructions. If they ask for changes, apply them to the source files."
        + '\n\nAfter completing work, output a <resolution> block with declaredScope and inferredScope. If unclear, output a <question> block.'
        + (provider !== 'codex' ? `\n\nIMPORTANT: First, use the Read tool to view the updated screenshot at: ${job.screenshotPath}` : '');
    } else {
      // No session to resume — build full prompt with thread history
      const threadHistory = !replyPrompt && job.threadId
        ? await threadStore.getThreadHistory(job.threadId)
        : undefined;

      // Load local design model for enforcement (best-effort)
      const designModel = !replyPrompt ? await materializer.loadModel() : null;

      prompt = replyPrompt ?? buildPrompt(job.screenshotPath, job.feedback, {
        threadHistory: threadHistory && threadHistory.length > 0 ? threadHistory : undefined,
        provider,
        imagePaths: job.imagePaths,
        designModel: designModel ?? undefined,
        screenshotPaths: job.screenshotPaths,
      });
    }

    const tag = ansiColor(job.color, `[⊹ ${boundPort}:${job.id}]`);
    const screenshotInfo = job.screenshotPaths && Object.keys(job.screenshotPaths).length > 0
      ? `${Object.keys(job.screenshotPaths).length} pages [${Object.keys(job.screenshotPaths).join(', ')}]`
      : job.screenshotPath;
    console.log(`${tag} Reviewing ${screenshotInfo} (provider: ${provider})${job.threadId ? ` (thread: ${job.threadId})` : ''}${resumeSessionId ? ` (resuming: ${resumeSessionId.slice(0, 8)})` : ''}`);

    const onEvent = (event: SSEEvent, jobId: string) => {
      // Accumulate text server-side for reconnect backfill
      if (event.type === 'delta' && 'text' in event) {
        queue.accumulateText(jobId, 'response', event.text);
      } else if (event.type === 'thinking' && 'text' in event) {
        queue.accumulateText(jobId, 'thinking', event.text);
      }
      queue.broadcast(event, jobId, job.sourceId);
    };

    const { process: proc, result } = provider === 'codex'
      ? spawnCodex(job.id, {
          prompt,
          projectRoot,
          screenshotPath: job.screenshotPath,
          resumeSessionId,
          model: job.model,
          onEvent,
        })
      : spawnClaude(job.id, {
          prompt,
          projectRoot,
          maxTurns,
          maxBudgetUsd,
          allowedTools,
          claudePath,
          resumeSessionId,
          model: job.model,
          timeoutMs,
          onEvent,
        });

    queue.setActiveProcess(job.id, proc);

    const spawnResult = await result;
    job.result = spawnResult.text;

    if (spawnResult.success) {
      console.log(`${tag} Iteration complete`);
      if (spawnResult.fileEdits && spawnResult.fileEdits.length > 0) {
        console.log(`${tag} Captured ${spawnResult.fileEdits.length} file edit(s): ${spawnResult.fileEdits.map(e => `${e.tool} ${e.file_path}`).join(', ')}`);
      }
      job.status = 'done';

      // Parse both questions and resolutions (Claude may resolve some and ask about others)
      const question = parseQuestion(spawnResult.text);
      let resolutions = parseResolutions(spawnResult.text);

      // Remap resolution annotationIds when Claude uses IDs that don't match actual annotations.
      // This happens when Claude invents IDs instead of using the ones from the prompt.
      if (resolutions.length > 0 && job.annotationIds && job.annotationIds.length > 0) {
        const realIdSet = new Set(job.annotationIds);
        const allMatch = resolutions.every(r => realIdSet.has(r.annotationId));
        if (!allMatch) {
          resolutions = resolutions.map((r, i) => ({
            ...r,
            annotationId: job.annotationIds![i % job.annotationIds!.length]!,
          }));
        }
      }

      // Derive toolsUsed from file edits (Claude) or spawner-collected labels (Codex)
      const toolsUsed = spawnResult.fileEdits && spawnResult.fileEdits.length > 0
        ? spawnResult.fileEdits.map(e => `${e.tool} ${e.file_path.split('/').pop()}`)
        : spawnResult.toolsUsed;

      // Build chronological segments from buffered events
      const buffered = queue.getBufferedEvents(job.id);
      const segments = buffered ? buildPersistedSegments(buffered.events) : undefined;

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
          toolsUsed,
          segments: segments && segments.length > 0 ? segments : undefined,
          model: job.model,
          provider: job.provider,
        });
      }

      // Persist decision record (best-effort, non-blocking)
      decisionStore.captureGitDiff(projectRoot).then(async (gitDiff) => {
        const completedAt = Date.now();
        const tempImagePaths = job.imagePaths
          ? Object.values(job.imagePaths).flat()
          : [];
        // Build relative pasted image paths for the record
        const pastedImagePaths: string[] = [];
        if (job.imagePaths) {
          for (const [annId, paths] of Object.entries(job.imagePaths)) {
            for (let i = 0; i < paths.length; i++) {
              pastedImagePaths.push(`screenshots/p-${job.id}-${annId}-${i}.png`);
            }
          }
        }
        await decisionStore.persist(
          {
            version: 1,
            id: job.id,
            createdAt: job.createdAt,
            completedAt,
            durationMs: completedAt - job.createdAt,
            url: job.feedback.url,
            viewport: job.feedback.viewport,
            screenshotPath: `screenshots/s-${job.id}.png`,
            pastedImagePaths,
            annotations: job.feedback.annotations,
            styleModifications: job.feedback.styleModifications,
            inspectedElement: job.feedback.inspectedElement,
            provider: job.provider,
            model: job.model,
            sessionId: spawnResult.sessionId,
            threadId: job.threadId,
            responseText: spawnResult.text,
            resolutions: resolutions.length > 0 ? resolutions : [],
            question: question ?? undefined,
            fileEdits: spawnResult.fileEdits ?? [],
            toolsUsed,
            gitDiff,
          },
          job.screenshotPath,
          tempImagePaths,
        );
      }).catch(() => {}); // Best-effort — never block

      // If this job has pattern-scoped resolutions, materialize into local model
      if (resolutions.length > 0) {
        const hasPatternScope = resolutions.some(r => {
          const scope = r.finalScope ?? r.inferredScope;
          return scope?.breadth === 'pattern';
        });
        if (hasPatternScope) {
          materializer.run().catch(() => {}); // fire-and-forget
        }
      }

      // Broadcast question event if Claude asked one
      if (question) {
        console.log(`${tag} 💬 Question detected: "${question.slice(0, 120)}" → broadcasting to ${sseClients.size} SSE clients (threadId=${job.threadId ?? job.id}, annotationIds=${job.annotationIds?.join(',') ?? 'none'})`);
        queue.broadcast(
          { type: 'question', jobId: job.id, threadId: job.threadId ?? job.id, question, annotationIds: job.annotationIds },
          job.id,
          job.sourceId,
        );
      }

      // Broadcast novel patterns if Claude flagged any
      const novelPatterns = parseNovelPatterns(spawnResult.text);
      if (novelPatterns.length > 0) {
        console.log(`${tag} Novel pattern(s): ${novelPatterns.map(p => `${p.category}/${p.element}`).join(', ')}`);
        queue.broadcast(
          { type: 'novel_patterns', jobId: job.id, patterns: novelPatterns, threadId: job.threadId },
          job.id,
          job.sourceId,
        );
      }

      queue.broadcast(
        { type: 'done', jobId: job.id, success: true, resolutions: resolutions.length > 0 ? resolutions : undefined, responseText: spawnResult.text, threadId: job.threadId },
        job.id,
        job.sourceId,
      );

      // Track for reconnect recovery
      recentJobs.push({ id: job.id, status: 'done', completedAt: Date.now(), threadId: job.threadId, annotationIds: job.annotationIds });
    } else {
      console.error(`${tag} Error: ${spawnResult.error}`);
      job.status = 'error';
      job.error = spawnResult.error;

      // Persist error to thread so it appears in conversation history
      if (job.threadId) {
        await threadStore.appendMessage(job.threadId, {
          role: 'assistant',
          timestamp: Date.now(),
          jobId: job.id,
          error: spawnResult.error || 'Unknown error',
          model: job.model,
          provider: job.provider,
        });
      }

      queue.broadcast(
        {
          type: 'error',
          jobId: job.id,
          threadId: job.threadId,
          message: spawnResult.error || 'Unknown error',
        },
        job.id,
        job.sourceId,
      );

      // Track for reconnect recovery
      recentJobs.push({ id: job.id, status: 'error', completedAt: Date.now(), error: spawnResult.error, threadId: job.threadId, annotationIds: job.annotationIds });
    }

    // Prune old entries
    const cutoff = Date.now() - RECENT_JOBS_TTL_MS;
    while (recentJobs.length > 0 && (recentJobs[0]!.completedAt < cutoff || recentJobs.length > RECENT_JOBS_MAX)) {
      recentJobs.shift();
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

    const rawUrl = req.url || '/';
    const rawPath = rawUrl.split('?')[0]!; // preserves %2F encoding
    const url = new URL(rawUrl, `http://127.0.0.1:${boundPort}`);
    const path = url.pathname;

    try {
      if (req.method === 'POST' && path === '/send') {
        await handleSend(req, res);
      } else if (req.method === 'GET' && path === '/events') {
        handleEvents(req, res);
      } else if (req.method === 'GET' && path === '/status') {
        handleStatus(res);
      } else if (req.method === 'PATCH' && path === '/config') {
        await handlePatchConfig(req, res);
      } else if (req.method === 'POST' && path === '/shutdown') {
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 100);
      } else if (req.method === 'GET' && path === '/capabilities') {
        sendJson(res, 200, { providers: capabilities });
      } else if (req.method === 'POST' && path === '/mcp/install') {
        await handleMcpInstall(req, res);
      } else if (req.method === 'POST' && path === '/reply') {
        await handleReply(req, res);
      } else if (req.method === 'POST' && path === '/cancel') {
        handleCancel(req, res);
      } else if (req.method === 'POST' && path === '/materialize') {
        await handleMaterialize(res);
      } else if (req.method === 'POST' && path === '/model/component') {
        await handleAddComponent(req, res);
      } else if (req.method === 'DELETE' && path === '/model/component') {
        await handleRemoveComponent(req, res);
      } else if (req.method === 'PATCH' && path === '/model/token') {
        await handleUpdateToken(req, res);
      } else if (req.method === 'DELETE' && path === '/model/token') {
        await handleRemoveToken(req, res);
      } else if (req.method === 'GET' && path === '/model') {
        const model = await materializer.loadModel();
        sendJson(res, 200, { model });
      } else if (req.method === 'GET' && path.startsWith('/jobs/') && path.endsWith('/events')) {
        // GET /jobs/:id/events?afterSeq=-1
        const jobId = path.slice('/jobs/'.length, path.length - '/events'.length);
        const afterSeq = parseInt(url.searchParams.get('afterSeq') ?? '-1', 10);
        const backfill = queue.getBufferedEvents(jobId, isNaN(afterSeq) ? -1 : afterSeq);
        if (backfill) {
          sendJson(res, 200, backfill);
        } else {
          sendJson(res, 404, { error: 'Unknown job' });
        }
      } else if (req.method === 'GET' && rawPath.startsWith('/files/')) {
        await handleServeFile(rawPath.slice('/files/'.length), res);
      } else if (req.method === 'GET' && path === '/threads/recent') {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '5', 10) || 5, 1), 20);
        const recent = await threadStore.listRecent(limit);
        sendJson(res, 200, recent);
      } else if (req.method === 'GET' && path.startsWith('/thread/')) {
        const threadId = path.slice('/thread/'.length);
        await handleGetThread(threadId, res);
      } else if (req.method === 'GET' && (path === '/canvas' || path === '/canvas/')) {
        handleCanvasPage(req, res);
      } else if (req.method === 'GET' && path === '/canvas/manifest') {
        await handleCanvasManifest(res);
      } else if (req.method === 'GET' && path === '/canvas/app.mjs') {
        await handleCanvasAsset(res);
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
    const { screenshot, feedback: feedbackStr, color, provider: providerStr, model: modelStr, sourceId: sourceIdStr, pastedImages, pageScreenshots } = await parseMultipart(req);

    let feedback: FeedbackPayload;
    try {
      feedback = JSON.parse(feedbackStr);
    } catch {
      sendJson(res, 400, { error: 'Invalid feedback JSON' });
      return;
    }

    const jobId = randomUUID().slice(0, 8);

    // Write per-page screenshots to temp dir (keyed by pathname)
    const screenshotPaths: Record<string, string> = {};
    if (pageScreenshots.length > 0) {
      for (const ps of pageScreenshots) {
        const encoded = encodeURIComponent(ps.pathname);
        const path = join(tempDir, `screenshot-${jobId}-${encoded}.png`);
        await writeFile(path, ps.data);
        screenshotPaths[ps.pathname] = path;
      }
    }

    // Write fallback single screenshot (always present for backward compat)
    const screenshotPath = join(tempDir, `screenshot-${jobId}.png`);
    await writeFile(screenshotPath, screenshot);

    // Write pasted images to temp dir
    const imagePaths: Record<string, string[]> = {};
    if (pastedImages.length > 0) {
      for (const img of pastedImages) {
        const imgPath = join(tempDir, `pasted-${jobId}-${img.annotationId}-${img.index}.png`);
        await writeFile(imgPath, img.data);
        if (!imagePaths[img.annotationId]) imagePaths[img.annotationId] = [];
        imagePaths[img.annotationId]!.push(imgPath);
      }
    }

    // Extract linkedSelector values for thread matching, qualified with pathname
    const linkedSelectors = feedback.annotations
      .map(a => {
        if (!a.linkedSelector) return null;
        return a.pathname ? `${a.pathname}:${a.linkedSelector}` : a.linkedSelector;
      })
      .filter((s): s is string => !!s);

    // Find or create thread (always create one so the chip can open the thread panel)
    let threadId: string;
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
    } else {
      const newThread = await threadStore.createThread(jobId, []);
      threadId = newThread.id;
    }

    const annotationIds = feedback.annotations.map(a => a.id);
    const hasPageScreenshots = Object.keys(screenshotPaths).length > 0;

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
      model: modelStr || undefined,
      ...(Object.keys(imagePaths).length > 0 ? { imagePaths } : {}),
      sourceId: sourceIdStr || undefined,
      ...(hasPageScreenshots ? { screenshotPaths } : {}),
    };

    // Append human message to thread — group by page when multi-page
    const annotationPages = new Set(feedback.annotations.map(a => a.pathname).filter(Boolean));
    let feedbackSummary: string;
    if (annotationPages.size > 1) {
      const byPage = new Map<string, string[]>();
      for (const a of feedback.annotations) {
        const page = a.pathname || '(unknown)';
        if (!byPage.has(page)) byPage.set(page, []);
        byPage.get(page)!.push(a.instruction || `[${a.type}]`);
      }
      // Format as markdown: page as inline code heading, annotations as bullet list
      feedbackSummary = [...byPage.entries()]
        .map(([page, instructions]) =>
          `\`${page}\`\n${instructions.map(i => `- ${i}`).join('\n')}`)
        .join('\n');
    } else {
      feedbackSummary = feedback.annotations
        .map(a => a.instruction || `[${a.type}]`)
        .join('; ');
    }
    const feedbackContext = formatFeedbackContext(feedback, Object.keys(imagePaths).length > 0 ? imagePaths : undefined);

    await threadStore.appendMessage(threadId, {
      role: 'human',
      timestamp: Date.now(),
      jobId,
      screenshotPath,
      ...(hasPageScreenshots ? { screenshotPaths } : {}),
      ...(Object.keys(imagePaths).length > 0 ? { imagePaths } : {}),
      annotationIds,
      feedbackSummary,
      feedbackContext: feedbackContext || undefined,
    });

    const position = queue.enqueue(job);

    sendJson(res, 200, { jobId, position, threadId });
  }

  async function handleReply(req: IncomingMessage, res: ServerResponse) {
    const contentType = req.headers['content-type'] || '';
    let threadId: string | undefined;
    let reply: string | undefined;
    let color: string | undefined;
    let providerStr: string | undefined;
    let modelStr: string | undefined;
    let sourceIdStr: string | undefined;
    let replyImageBuffers: Buffer[] = [];

    if (contentType.includes('multipart/form-data')) {
      // Multipart: reply with attached images
      const parsed = await parseMultipart(req);
      // The "screenshot" field carries the first image; additional images are in pastedImages
      // But for replies we repurpose: "feedback" = JSON with threadId/reply/etc, images = reply-image-*
      const meta = parsed.feedback ? JSON.parse(parsed.feedback) : {};
      threadId = meta.threadId;
      reply = meta.reply;
      color = meta.color;
      providerStr = meta.provider;
      modelStr = meta.model;
      sourceIdStr = meta.sourceId || parsed.sourceId;
      // Collect images: the main "screenshot" field is reused as first image if present and non-empty
      // pastedImages carry reply-image-{index} fields
      for (const img of parsed.pastedImages) {
        replyImageBuffers.push(img.data);
      }
    } else {
      // JSON: reply without images (original path)
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      const body = Buffer.concat(chunks).toString('utf-8');
      let parsed: { threadId?: string; reply?: string; color?: string; provider?: string; model?: string; sourceId?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: 'Invalid JSON' });
        return;
      }
      threadId = parsed.threadId;
      reply = parsed.reply;
      color = parsed.color;
      providerStr = parsed.provider;
      modelStr = parsed.model;
      sourceIdStr = parsed.sourceId;
    }

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

    // Write reply images to temp dir
    const replyImagePaths: string[] = [];
    for (let i = 0; i < replyImageBuffers.length; i++) {
      const imgPath = join(tempDir, `reply-${jobId}-${i}.png`);
      await writeFile(imgPath, replyImageBuffers[i]!);
      replyImagePaths.push(imgPath);
    }

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
      ...(replyImagePaths.length > 0 ? { replyImagePaths } : {}),
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
    const prompt = buildReplyPrompt(
      screenshotPath, history, replyProvider,
      replyImagePaths.length > 0 ? replyImagePaths : undefined,
    );

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
      model: modelStr || undefined,
      sourceId: sourceIdStr || undefined,
    };

    // Override the job processor prompt for this job by storing it
    (job as Job & { _replyPrompt?: string; _replyImagePaths?: string[] })._replyPrompt = prompt;
    if (replyImagePaths.length > 0) {
      (job as Job & { _replyImagePaths?: string[] })._replyImagePaths = replyImagePaths;
    }

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

    // Infer/update devOrigin from SSE connection origin
    if (req.headers.origin && isLocalhostOrigin(req.headers.origin) && devOrigin !== req.headers.origin) {
      devOrigin = req.headers.origin;
    }

    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
    const sourceId = reqUrl.searchParams.get('sourceId') || undefined;
    const client: SSEClient = { id: randomUUID().slice(0, 8), res, sourceId };
    sseClients.add(client);

    req.on('close', () => {
      sseClients.delete(client);
    });
  }

  function handleStatus(res: ServerResponse) {
    const allActive = queue.allActive;
    sendJson(res, 200, {
      ok: true,
      version: VERSION,
      projectId,
      devOrigin,
      activeJob: allActive[0]
        ? { id: allActive[0].id, status: allActive[0].status }
        : null,
      activeJobs: allActive.map(j => ({ id: j.id, status: j.status, threadId: j.threadId, annotationIds: j.annotationIds, color: j.color })),
      queueDepth: queue.depth,
      recentJobs,
    });
  }

  async function handlePatchConfig(req: IncomingMessage, res: ServerResponse) {
    const body = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      req.on('end', () => resolve(data));
    });
    try {
      const config = JSON.parse(body);
      if (typeof config.devOrigin === 'string') {
        devOrigin = config.devOrigin || null;
      }
      sendJson(res, 200, { ok: true, devOrigin });
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
    }
  }

  async function handleCancel(req: IncomingMessage, res: ServerResponse) {
    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`);
    const jobId = reqUrl.searchParams.get('jobId');

    // Collect threadIds before cancelling (cancelJob deletes the job)
    const jobsToCancel = jobId
      ? queue.allActive.filter(j => j.id === jobId)
      : queue.allActive;
    const threadIds = jobsToCancel.map(j => j.threadId).filter(Boolean) as string[];

    const cancelled = jobId ? queue.cancelJob(jobId) : queue.cancelActive();

    // Append cancellation message to each affected thread
    for (const tid of threadIds) {
      await threadStore.appendMessage(tid, {
        role: 'assistant',
        timestamp: Date.now(),
        jobId: jobId || '',
        cancelled: true,
      });
    }

    sendJson(res, 200, { cancelled });
  }

  async function handleMaterialize(res: ServerResponse) {
    if (materializer.isRunning) {
      sendJson(res, 200, { skipped: true, reason: 'Already running' });
      return;
    }
    const pending = await materializer.getUnmaterializedPatternDecisions();
    if (pending.length === 0) {
      sendJson(res, 200, { skipped: true, reason: 'No unmaterialized pattern decisions' });
      return;
    }
    materializer.run().catch(() => {}); // fire-and-forget
    sendJson(res, 200, { started: true, decisionCount: pending.length, decisionIds: pending.map(d => d.id) });
  }

  async function handleMcpInstall(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    let serverUrl: string | undefined;
    if (chunks.length > 0) {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        serverUrl = body.serverUrl;
      } catch {
        // Empty or invalid body — use defaults
      }
    }

    const results = [];

    // Install for each available-but-unconfigured provider
    if (capabilities.claude?.available && capabilities.claude.mcp && !capabilities.claude.mcp.found) {
      results.push(await installClaudeMcp(serverUrl));
    }
    if (capabilities.codex?.available && capabilities.codex.mcp && !capabilities.codex.mcp.found) {
      results.push(await installCodexMcp(serverUrl));
    }

    // Re-detect to update capabilities in memory
    const [newClaudeMcp, newCodexMcp] = await Promise.all([
      detectClaudeMcp(projectRoot),
      detectCodexMcp(projectRoot),
    ]);
    if (capabilities.claude) capabilities.claude.mcp = newClaudeMcp;
    if (capabilities.codex) capabilities.codex.mcp = newCodexMcp;

    sendJson(res, 200, { results, capabilities: { providers: capabilities } });
  }

  async function handleAddComponent(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    let parsed: { name?: string };
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }
    if (!parsed.name || typeof parsed.name !== 'string') {
      sendJson(res, 400, { error: 'Missing or invalid name' });
      return;
    }
    const result = await materializer.addComponent(parsed.name);
    sendJson(res, 200, result);
  }

  async function handleRemoveComponent(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    let parsed: { name?: string };
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }
    if (!parsed.name || typeof parsed.name !== 'string') {
      sendJson(res, 400, { error: 'Missing or invalid name' });
      return;
    }
    const result = await materializer.removeComponent(parsed.name);
    sendJson(res, 200, result);
  }

  async function handleUpdateToken(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    let parsed: { path?: string; value?: string };
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }
    if (!parsed.path || typeof parsed.path !== 'string' || typeof parsed.value !== 'string') {
      sendJson(res, 400, { error: 'Missing or invalid path/value' });
      return;
    }
    const result = await materializer.updateToken(parsed.path, parsed.value);
    sendJson(res, 200, result);
  }

  async function handleRemoveToken(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    let parsed: { path?: string };
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }
    if (!parsed.path || typeof parsed.path !== 'string') {
      sendJson(res, 400, { error: 'Missing or invalid path' });
      return;
    }
    const result = await materializer.removeToken(parsed.path);
    sendJson(res, 200, result);
  }

  function handleCanvasPage(req: IncomingMessage, res: ServerResponse) {
    // Use outer devOrigin if available, otherwise infer from Referer/Origin header
    let canvasDevOrigin = devOrigin ?? 'http://localhost:3000';
    if (!devOrigin) {
      const referer = req.headers.referer || req.headers.origin;
      if (referer) {
        try {
          const u = new URL(typeof referer === 'string' ? referer : referer[0] || '');
          if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
            canvasDevOrigin = u.origin;
          }
        } catch {}
      }
    }

    const html = buildCanvasHtml(boundPort, canvasDevOrigin);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  async function handleCanvasManifest(res: ServerResponse) {
    const now = Date.now();
    if (manifestCache && now < manifestCache.expires) {
      sendJson(res, 200, manifestCache.data);
      return;
    }

    try {
      // Dynamic import to avoid requiring scanner at module load time
      const { scanForComponents } = await import('../scanner/react-scanner');
      const { generateRenderFiles } = await import('../scanner/render-generator');
      const manifest = await scanForComponents(projectRoot);
      manifestCache = { data: manifest, expires: now + 5000 };

      // Generate render files for route-less components (fire-and-forget)
      generateRenderFiles(manifest, projectRoot, renderHash)
        .then(hash => { renderHash = hash; })
        .catch(err => console.warn('[Bridge] Render generation failed:', err));

      sendJson(res, 200, manifest);
    } catch (err) {
      console.error('[Bridge] Scanner error:', err);
      sendJson(res, 500, { error: 'Failed to scan components' });
    }
  }

  async function handleCanvasAsset(res: ServerResponse) {
    // Try multiple locations since import.meta.url is unreliable in bundled contexts
    const candidates = [
      join(projectRoot, 'node_modules', '@popmelt.com', 'core', 'dist', 'canvas.mjs'),
      join(projectRoot, 'packages', 'popmelt', 'dist', 'canvas.mjs'),
    ];

    try {
      const thisFile = fileURLToPath(import.meta.url);
      candidates.unshift(join(dirname(thisFile), 'canvas.mjs'));
    } catch {}

    for (const bundlePath of candidates) {
      try {
        const content = await readFile(bundlePath, 'utf-8');
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(content);
        return;
      } catch {
        // Try next candidate
      }
    }

    console.error('[Bridge] Canvas bundle not found in:', candidates);
    sendJson(res, 404, { error: 'Canvas bundle not found' });
  }

  async function handleServeFile(filename: string, res: ServerResponse) {
    // Filename arrives raw (not URL-decoded) so %2F stays literal — matching what's on disk.
    // Security: reject if it contains a real slash or path traversal.
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      sendJson(res, 400, { error: 'Invalid filename' });
      return;
    }
    try {
      const data = await readFile(join(tempDir, filename));
      const ext = filename.split('.').pop()?.toLowerCase();
      const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: 'File not found' });
    }
  }

  /** Convert a filesystem path to a /files/ URL (basename only) */
  function toFileUrl(fsPath: string): string {
    return `/files/${basename(fsPath)}`;
  }

  async function handleGetThread(threadId: string, res: ServerResponse) {
    const thread = await threadStore.getThread(threadId);
    if (!thread) {
      sendJson(res, 404, { error: 'Thread not found' });
      return;
    }
    // Convert filesystem paths to /files/ URLs for client consumption
    const messages = thread.messages.map(({ screenshotPath, screenshotPaths, imagePaths, replyImagePaths, ...rest }) => ({
      ...rest,
      ...(screenshotPath ? { screenshotUrl: toFileUrl(screenshotPath) } : {}),
      ...(screenshotPaths ? { screenshotUrls: Object.fromEntries(
        Object.entries(screenshotPaths).map(([page, p]) => [page, toFileUrl(p)])
      ) } : {}),
      ...(imagePaths ? { imageUrls: Object.fromEntries(
        Object.entries(imagePaths).map(([annId, paths]) => [annId, paths.map(toFileUrl)])
      ) } : {}),
      ...(replyImagePaths ? { replyImageUrls: replyImagePaths.map(toFileUrl) } : {}),
    }));
    sendJson(res, 200, { id: thread.id, createdAt: thread.createdAt, messages });
  }

  // Try ports basePort..basePort+8, distinguishing "our bridge" from "another project's bridge"
  const MAX_PORT_ATTEMPTS = 9;
  let didBind = false;

  for (let tryPort = basePort; tryPort < basePort + MAX_PORT_ATTEMPTS; tryPort++) {
    try {
      await listenOnPort(server, tryPort);
      boundPort = tryPort;
      didBind = true;
      console.log(`[⊹ is watching :${boundPort}]`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        // Probe the occupant to check if it's our project or another one
        const occupant = await probeBridge(tryPort);
        if (occupant && occupant.projectId === projectId) {
          // Same project already running (HMR restart) — return no-op handle
          console.log(`[⊹ already watching :${tryPort}]`);
          return { port: tryPort, projectId, close: async () => {} };
        }
        // Another project's bridge — try next port
        continue;
      }
      // Non-EADDRINUSE error — fatal
      throw err;
    }
  }

  if (!didBind) {
    throw new Error(`[Bridge] All ports ${basePort}–${basePort + MAX_PORT_ATTEMPTS - 1} in use`);
  }

  // Fire-and-forget CLI warm-ups — primes OS caches, validates availability
  for (const [cli, cap] of Object.entries(capabilities)) {
    if (!cap.available || !cap.path) continue;
    warmUpCli(cli, cap.path).then((ok) => {
      if (!ok) {
        console.warn(`[Bridge] ${cli} warm-up failed — marking unavailable`);
        cap.available = false;
        cap.path = null;
        for (const client of sseClients) {
          sendSSE(client, { type: 'capabilities_changed', data: {} });
        }
      } else {
        console.log(`[Bridge] ${cli} warmed up`);
      }
    });
  }

  // Periodic cleanup (only after successful binding)
  const cleanupTimer = setInterval(() => {
    cleanupTempDir(tempDir).catch(() => {});
  }, CLEANUP_INTERVAL_MS);

  return {
    port: boundPort,
    projectId,
    close: async () => {
      clearInterval(cleanupTimer);
      await queue.destroyAsync();

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
  };
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
