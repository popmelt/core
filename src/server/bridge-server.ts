import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnClaude } from './claude-spawner';
import { spawnCodex } from './codex-spawner';
import { parseMultipart } from './multipart';
import { buildPlanExecutorPrompt, buildPlannerPrompt, buildPrompt, buildReplyPrompt, buildReviewerPrompt, formatFeedbackContext, parseAllResolutions, parsePlan, parseQuestion, parseResolutions, parseReview } from './prompt-builder';
import { JobQueue } from './queue';
import { ThreadFileStore } from './thread-store';
import type { PopmeltHandle, PopmeltOptions, FeedbackPayload, Job, JobGroup, Provider, SSEClient, SSEEvent } from './types';

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

export async function createPopmelt(
  options: PopmeltOptions = {},
): Promise<PopmeltHandle> {
  const port = options.port ?? DEFAULT_PORT;
  const projectRoot = options.projectRoot ?? process.cwd();
  const tempDir = options.tempDir ?? join(tmpdir(), 'popmelt-bridge');
  const maxTurns = options.maxTurns ?? 10;
  const maxBudgetUsd = options.maxBudgetUsd ?? 1.0;
  const allowedTools = options.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  const claudePath = options.claudePath ?? 'claude';
  const defaultProvider: Provider = options.provider ?? 'claude';

  // Probe for installed CLI providers
  type ProviderCapability = { available: boolean; path: string | null };
  const capabilities: Record<string, ProviderCapability> = {};
  for (const cli of ['claude', 'codex']) {
    try {
      const cliPath = execFileSync('which', [cli], { encoding: 'utf-8' }).trim();
      capabilities[cli] = { available: true, path: cliPath };
    } catch {
      capabilities[cli] = { available: false, path: null };
    }
  }

  // Ensure temp dir exists
  await mkdir(tempDir, { recursive: true });

  // Cleanup old files on startup
  cleanupTempDir(tempDir).catch(() => {});

  const queue = new JobQueue();
  const sseClients: Set<SSEClient> = new Set();
  const threadStore = new ThreadFileStore(projectRoot);
  const jobGroups = new Map<string, JobGroup>();

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
      prompt = replyText
        + '\n\nAfter completing work, output a <resolution> block. If unclear, output a <question> block.';
    } else if (resumeSessionId) {
      // Resuming with new annotations: send the new feedback context
      prompt = formatFeedbackContext(job.feedback)
        + "\n\nFollow the developer's instructions. If they ask for changes, apply them to the source files."
        + '\n\nAfter completing work, output a <resolution> block. If unclear, output a <question> block.'
        + (provider !== 'codex' ? `\n\nIMPORTANT: First, use the Read tool to view the updated screenshot at: ${job.screenshotPath}` : '');
    } else {
      // No session to resume — build full prompt with thread history
      const threadHistory = !replyPrompt && job.threadId
        ? await threadStore.getThreadHistory(job.threadId)
        : undefined;

      prompt = replyPrompt ?? buildPrompt(job.screenshotPath, job.feedback, {
        threadHistory: threadHistory && threadHistory.length > 0 ? threadHistory : undefined,
        provider,
      });
    }

    const tag = ansiColor(job.color, `[⊹ ${port}:${job.id}]`);
    console.log(`${tag} Reviewing feedback ${job.screenshotPath} (provider: ${provider})${job.threadId ? ` (thread: ${job.threadId})` : ''}${resumeSessionId ? ` (resuming: ${resumeSessionId.slice(0, 8)})` : ''}`);

    // Incremental resolution tracking for plan executor jobs
    const isPlanExecutor = !!(job as Job & { _isPlanExecutor?: boolean })._isPlanExecutor;
    let deltaBuffer = '';
    let lastResolutionCount = 0;

    const onEvent = (event: SSEEvent, jobId: string) => {
      queue.broadcast(event, jobId);

      // For plan executor jobs, accumulate delta text and check for new resolutions
      if (isPlanExecutor && event.type === 'delta' && 'text' in event) {
        deltaBuffer += event.text;
        const resolutions = parseAllResolutions(deltaBuffer);
        if (resolutions.length > lastResolutionCount) {
          const newResolutions = resolutions.slice(lastResolutionCount);
          lastResolutionCount = resolutions.length;
          queue.broadcast(
            { type: 'task_resolved', jobId, planId: job.planId!, resolutions: newResolutions, threadId: job.threadId },
            jobId,
          );
        }
      }
    };

    // Use per-job tool overrides (e.g. planner gets Read-only)
    const jobAllowedTools = (job as Job & { _allowedTools?: string[] })._allowedTools ?? allowedTools;

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
          allowedTools: jobAllowedTools,
          claudePath,
          resumeSessionId,
          model: job.model,
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

      // Planner completion: parse plan and broadcast plan_ready
      if (job.planId && !job.planTaskId) {
        const group = jobGroups.get(job.planId);
        if (group) {
          const plan = parsePlan(spawnResult.text);
          if (plan && plan.length > 0) {
            group.plan = plan;
            group.status = 'awaiting_approval';
            group.plannerThreadId = job.threadId;
            console.log(`${tag} Plan ready: ${plan.length} tasks for group ${job.planId}`);
            queue.broadcast(
              { type: 'plan_ready', jobId: job.id, planId: job.planId, tasks: plan, threadId: job.threadId },
              job.id,
            );
          } else if (!question) {
            // Plan parsing failed and no question — error
            group.status = 'error';
            console.error(`${tag} Failed to parse plan from planner response`);
          }
        }
      }

      // Review completion: parse review verdict
      if (job.planId && (job as Job & { _isReview?: boolean })._isReview) {
        const group = jobGroups.get(job.planId);
        if (group) {
          const review = parseReview(spawnResult.text);
          if (review) {
            group.status = review.verdict === 'pass' ? 'done' : 'executing';
            console.log(`${tag} Review verdict: ${review.verdict} — ${review.summary}`);
            queue.broadcast(
              { type: 'plan_review', planId: job.planId, verdict: review.verdict, summary: review.summary, issues: review.issues },
              job.id,
            );
          }
        }
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
      } else if (req.method === 'GET' && path === '/capabilities') {
        sendJson(res, 200, { providers: capabilities });
      } else if (req.method === 'POST' && path === '/reply') {
        await handleReply(req, res);
      } else if (req.method === 'POST' && path === '/cancel') {
        handleCancel(req, res);
      } else if (req.method === 'POST' && path === '/plan') {
        await handlePlan(req, res);
      } else if (req.method === 'POST' && path === '/plan/approve') {
        await handlePlanApprove(req, res);
      } else if (req.method === 'POST' && path === '/plan/execute') {
        await handlePlanExecute(req, res);
      } else if (req.method === 'POST' && path === '/plan/review') {
        await handlePlanReview(req, res);
      } else if (req.method === 'GET' && path.startsWith('/plan/')) {
        handleGetPlan(path.slice('/plan/'.length), res);
      } else if (req.method === 'GET' && path.startsWith('/thread/')) {
        const threadId = path.slice('/thread/'.length);
        await handleGetThread(threadId, res);
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
    const { screenshot, feedback: feedbackStr, color, provider: providerStr, model: modelStr } = await parseMultipart(req);

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
      model: modelStr || undefined,
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

    let parsed: { threadId?: string; reply?: string; color?: string; provider?: string; model?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { threadId, reply, color, provider: providerStr, model: modelStr } = parsed;
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
      model: modelStr || undefined,
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
    const allActive = queue.allActive;
    sendJson(res, 200, {
      ok: true,
      activeJob: allActive[0]
        ? { id: allActive[0].id, status: allActive[0].status }
        : null,
      activeJobs: allActive.map(j => ({ id: j.id, status: j.status })),
      queueDepth: queue.depth,
    });
  }

  function handleCancel(req: IncomingMessage, res: ServerResponse) {
    const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    const jobId = reqUrl.searchParams.get('jobId');
    const cancelled = jobId ? queue.cancelJob(jobId) : queue.cancelActive();
    sendJson(res, 200, { cancelled });
  }

  async function handlePlan(req: IncomingMessage, res: ServerResponse) {
    const { screenshot, feedback: feedbackStr, goal: goalStr, pageUrl: pageUrlStr, viewport: viewportStr, provider: providerStr, model: modelStr, manifest: manifestStr } = await parseMultipart(req);

    if (!screenshot || !goalStr) {
      sendJson(res, 400, { error: 'Missing screenshot or goal' });
      return;
    }

    const pageUrl = pageUrlStr || '';
    let viewport = { width: 1440, height: 900 };
    try {
      if (viewportStr) viewport = JSON.parse(viewportStr);
    } catch {}

    // Parse optional feedback context (annotations + style modifications from the canvas)
    let feedbackContext: string | undefined;
    if (feedbackStr) {
      try {
        const feedback: FeedbackPayload = JSON.parse(feedbackStr);
        const ctx = formatFeedbackContext(feedback);
        if (ctx) feedbackContext = ctx;
      } catch {
        // Invalid feedback JSON — skip
      }
    }

    const planId = randomUUID().slice(0, 8);
    const jobId = randomUUID().slice(0, 8);
    const screenshotPath = join(tempDir, `screenshot-plan-${planId}.png`);
    await writeFile(screenshotPath, screenshot);

    // Create thread for planner conversation
    const thread = await threadStore.createThread(jobId, []);
    const threadId = thread.id;

    // Create job group
    const group: JobGroup = {
      id: planId,
      goal: goalStr,
      status: 'planning',
      plannerJobId: jobId,
      plannerThreadId: threadId,
      workerJobIds: [],
      screenshotPath,
      pageUrl,
      viewport,
      createdAt: Date.now(),
    };
    jobGroups.set(planId, group);

    // Build planner prompt
    const prompt = buildPlannerPrompt(screenshotPath, goalStr, pageUrl, viewport, manifestStr, feedbackContext);

    // Append human message to thread
    await threadStore.appendMessage(threadId, {
      role: 'human',
      timestamp: Date.now(),
      jobId,
      screenshotPath,
      feedbackSummary: `Plan: ${goalStr}`,
      feedbackContext: `Goal: ${goalStr}\nPage: ${pageUrl}`,
    });

    const provider = (providerStr === 'claude' || providerStr === 'codex') ? providerStr : defaultProvider;
    const job: Job = {
      id: jobId,
      status: 'queued',
      screenshotPath,
      feedback: {
        timestamp: new Date().toISOString(),
        url: pageUrl,
        viewport,
        scrollPosition: { x: 0, y: 0 },
        annotations: [],
        styleModifications: [],
      },
      createdAt: Date.now(),
      threadId,
      provider,
      model: modelStr || undefined,
      planId,
    };

    // Override prompt and tools for planner (vision-only, no code changes)
    (job as Job & { _replyPrompt?: string })._replyPrompt = prompt;
    (job as Job & { _allowedTools?: string[] })._allowedTools = ['Read'];

    const position = queue.enqueue(job);
    sendJson(res, 200, { planId, jobId, position, threadId });
  }

  async function handlePlanApprove(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks).toString('utf-8');

    let parsed: { planId?: string; approvedTaskIds?: string[] };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON' });
      return;
    }

    const { planId, approvedTaskIds } = parsed;
    if (!planId) {
      sendJson(res, 400, { error: 'Missing planId' });
      return;
    }

    const group = jobGroups.get(planId);
    if (!group) {
      sendJson(res, 404, { error: 'Plan not found' });
      return;
    }

    if (!group.plan) {
      sendJson(res, 400, { error: 'Plan has no tasks' });
      return;
    }

    // Filter tasks if specific IDs were approved
    const tasks = approvedTaskIds
      ? group.plan.filter(t => approvedTaskIds.includes(t.id))
      : group.plan;

    group.status = 'executing';

    sendJson(res, 200, { planId, tasks, status: 'executing' });
  }

  async function handlePlanExecute(req: IncomingMessage, res: ServerResponse) {
    const { screenshot, planId: planIdStr, tasks: tasksStr, provider: providerStr, model: modelStr } = await parseMultipart(req);

    if (!planIdStr || !tasksStr || !screenshot) {
      sendJson(res, 400, { error: 'Missing planId, tasks, or screenshot' });
      return;
    }

    const group = jobGroups.get(planIdStr);
    if (!group) {
      sendJson(res, 404, { error: 'Plan not found' });
      return;
    }

    if (group.status !== 'executing') {
      sendJson(res, 400, { error: `Plan status is ${group.status}, expected executing` });
      return;
    }

    let tasks: Array<{
      planTaskId: string;
      annotationId: string;
      instruction: string;
      region: { x: number; y: number; width: number; height: number };
      linkedSelector?: string;
      elements?: Array<{ selector: string; reactComponent?: string }>;
    }>;
    try {
      tasks = JSON.parse(tasksStr);
    } catch {
      sendJson(res, 400, { error: 'Invalid tasks JSON' });
      return;
    }

    const jobId = randomUUID().slice(0, 8);
    const screenshotPath = join(tempDir, `screenshot-exec-${planIdStr}.png`);
    await writeFile(screenshotPath, screenshot);

    const provider = (providerStr === 'claude' || providerStr === 'codex') ? providerStr : defaultProvider;
    const prompt = buildPlanExecutorPrompt(screenshotPath, tasks, group.pageUrl, group.viewport, provider);

    // Collect all annotation IDs from tasks
    const annotationIds = tasks.map(t => t.annotationId);

    const job: Job = {
      id: jobId,
      status: 'queued',
      screenshotPath,
      feedback: {
        timestamp: new Date().toISOString(),
        url: group.pageUrl,
        viewport: group.viewport,
        scrollPosition: { x: 0, y: 0 },
        annotations: [],
        styleModifications: [],
      },
      createdAt: Date.now(),
      provider,
      model: modelStr || undefined,
      planId: planIdStr,
      annotationIds,
    };

    (job as Job & { _replyPrompt?: string })._replyPrompt = prompt;
    (job as Job & { _isPlanExecutor?: boolean })._isPlanExecutor = true;

    group.executorJobId = jobId;

    const position = queue.enqueue(job);
    sendJson(res, 200, { jobId, planId: planIdStr, position });
  }

  async function handlePlanReview(req: IncomingMessage, res: ServerResponse) {
    const { screenshot, planId: planIdStr, provider: providerStr, model: modelStr } = await parseMultipart(req);

    if (!planIdStr) {
      sendJson(res, 400, { error: 'Missing planId' });
      return;
    }

    const group = jobGroups.get(planIdStr);
    if (!group) {
      sendJson(res, 404, { error: 'Plan not found' });
      return;
    }

    group.status = 'reviewing';

    const jobId = randomUUID().slice(0, 8);
    let screenshotPath = group.screenshotPath;
    if (screenshot) {
      screenshotPath = join(tempDir, `screenshot-review-${planIdStr}.png`);
      await writeFile(screenshotPath, screenshot);
    }

    // Build completed tasks summary from worker results
    const completedTasks = (group.plan || []).map(t => ({
      id: t.id,
      instruction: t.instruction,
      summary: 'completed', // Workers will have set resolution summaries
    }));

    const prompt = buildReviewerPrompt(screenshotPath, group.goal, completedTasks);

    const provider = (providerStr === 'claude' || providerStr === 'codex') ? providerStr : defaultProvider;
    const job: Job = {
      id: jobId,
      status: 'queued',
      screenshotPath,
      feedback: {
        timestamp: new Date().toISOString(),
        url: group.pageUrl,
        viewport: group.viewport,
        scrollPosition: { x: 0, y: 0 },
        annotations: [],
        styleModifications: [],
      },
      createdAt: Date.now(),
      // Don't set threadId — avoids resuming planner session, which would discard the review prompt
      provider,
      model: modelStr || undefined,
      planId: planIdStr,
    };

    (job as Job & { _replyPrompt?: string })._replyPrompt = prompt;
    (job as Job & { _isReview?: boolean })._isReview = true;
    (job as Job & { _allowedTools?: string[] })._allowedTools = ['Read'];

    const position = queue.enqueue(job);
    sendJson(res, 200, { jobId, planId: planIdStr, position });
  }

  function handleGetPlan(planId: string, res: ServerResponse) {
    const group = jobGroups.get(planId);
    if (!group) {
      sendJson(res, 404, { error: 'Plan not found' });
      return;
    }
    sendJson(res, 200, group);
  }

  async function handleGetThread(threadId: string, res: ServerResponse) {
    const thread = await threadStore.getThread(threadId);
    if (!thread) {
      sendJson(res, 404, { error: 'Thread not found' });
      return;
    }
    // Strip screenshotPath from messages (local filesystem path)
    const messages = thread.messages.map(({ screenshotPath, ...rest }) => rest);
    sendJson(res, 200, { id: thread.id, createdAt: thread.createdAt, messages });
  }

  // Periodic cleanup
  const cleanupTimer = setInterval(() => {
    cleanupTempDir(tempDir).catch(() => {});
  }, CLEANUP_INTERVAL_MS);

  return new Promise<PopmeltHandle>((resolve, reject) => {
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
