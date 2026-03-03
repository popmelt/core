import type { ChildProcess } from 'node:child_process';

import type { Job, SSEEvent } from './types';

export type QueueListener = (event: SSEEvent, jobId: string, sourceId?: string) => void;

export type BufferedEvent = SSEEvent & { seq: number };

export type BackfillResponse = {
  jobId: string;
  events: BufferedEvent[];
  currentSeq: number;
  accumulated: { response: string; thinking: string };
  jobActive: boolean;
};

const MAX_BUFFERED_EVENTS = 10_000;
const BUFFER_CLEANUP_DELAY_MS = 60_000;

export class JobQueue {
  private queue: Job[] = [];
  private activeJobs = new Map<string, Job>();
  private activeProcesses = new Map<string, ChildProcess>();
  private listeners: Set<QueueListener> = new Set();
  private processor: ((job: Job) => Promise<void>) | null = null;
  private maxConcurrency: number;

  // Per-job event buffer for reconnect backfill
  private eventBuffers = new Map<string, { events: BufferedEvent[]; nextSeq: number }>();
  private accumulators = new Map<string, { response: string; thinking: string }>();
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(maxConcurrency = 5) {
    this.maxConcurrency = maxConcurrency;
  }

  setProcessor(fn: (job: Job) => Promise<void>) {
    this.processor = fn;
  }

  /** First active job (backward compat for status endpoint) */
  get active(): Job | null {
    const first = this.activeJobs.values().next();
    return first.done ? null : first.value;
  }

  get allActive(): Job[] {
    return Array.from(this.activeJobs.values());
  }

  get activeCount() {
    return this.activeJobs.size;
  }

  get depth() {
    return this.queue.length;
  }

  get isRunning() {
    return this.activeJobs.size > 0;
  }

  setActiveProcess(jobId: string, proc: ChildProcess | null) {
    if (proc) {
      this.activeProcesses.set(jobId, proc);
    } else {
      this.activeProcesses.delete(jobId);
    }
  }

  enqueue(job: Job): number {
    this.queue.push(job);
    this.processNext();
    return this.queue.length + this.activeJobs.size;
  }

  addListener(listener: QueueListener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast(event: SSEEvent, jobId: string, sourceId?: string) {
    // Stamp seq and buffer for reconnect backfill
    const stamped = this.bufferEvent(jobId, event);

    for (const listener of this.listeners) {
      listener(stamped, jobId, sourceId);
    }
  }

  // ---- Event buffer for reconnect backfill ----

  private bufferEvent(jobId: string, event: SSEEvent): BufferedEvent {
    let buf = this.eventBuffers.get(jobId);
    if (!buf) {
      buf = { events: [], nextSeq: 0 };
      this.eventBuffers.set(jobId, buf);
    }
    const stamped: BufferedEvent = { ...event, seq: buf.nextSeq++ };
    buf.events.push(stamped);
    // Evict oldest if over cap
    if (buf.events.length > MAX_BUFFERED_EVENTS) {
      buf.events.splice(0, buf.events.length - MAX_BUFFERED_EVENTS);
    }
    return stamped;
  }

  getBufferedEvents(jobId: string, afterSeq = -1): BackfillResponse | null {
    const buf = this.eventBuffers.get(jobId);
    const acc = this.accumulators.get(jobId) ?? { response: '', thinking: '' };
    const jobActive = this.activeJobs.has(jobId);

    // No buffer at all — unknown job
    if (!buf) return null;

    const events = afterSeq < 0
      ? buf.events
      : buf.events.filter(e => e.seq > afterSeq);

    return {
      jobId,
      events,
      currentSeq: buf.nextSeq - 1,
      accumulated: { ...acc },
      jobActive,
    };
  }

  accumulateText(jobId: string, field: 'response' | 'thinking', text: string) {
    let acc = this.accumulators.get(jobId);
    if (!acc) {
      acc = { response: '', thinking: '' };
      this.accumulators.set(jobId, acc);
    }
    acc[field] += text;
  }

  getAccumulated(jobId: string): { response: string; thinking: string } | null {
    return this.accumulators.get(jobId) ?? null;
  }

  private scheduleBufferCleanup(jobId: string) {
    // Clear any existing timer
    const existing = this.cleanupTimers.get(jobId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.eventBuffers.delete(jobId);
      this.accumulators.delete(jobId);
      this.cleanupTimers.delete(jobId);
    }, BUFFER_CLEANUP_DELAY_MS);
    this.cleanupTimers.set(jobId, timer);
  }

  cancelJob(jobId: string): boolean {
    const proc = this.activeProcesses.get(jobId);
    const job = this.activeJobs.get(jobId);
    if (!proc || !job) return false;

    proc.kill('SIGTERM');
    this.activeProcesses.delete(jobId);
    this.activeJobs.delete(jobId);
    job.status = 'error';
    job.error = 'Cancelled by user';
    this.broadcast(
      { type: 'error', jobId: job.id, message: 'Cancelled by user', cancelled: true },
      job.id,
      job.sourceId,
    );
    this.processNext();
    return true;
  }

  cancelActive(): boolean {
    if (this.activeJobs.size === 0) return false;
    const jobIds = Array.from(this.activeJobs.keys());
    for (const jobId of jobIds) {
      this.cancelJob(jobId);
    }
    return true;
  }

  destroy() {
    for (const proc of this.activeProcesses.values()) {
      proc.kill('SIGTERM');
    }
    this.activeProcesses.clear();
    this.activeJobs.clear();
    this.queue = [];
    this.listeners.clear();
    this.eventBuffers.clear();
    this.accumulators.clear();
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
  }

  async destroyAsync(timeoutMs = 10_000): Promise<void> {
    const procs = Array.from(this.activeProcesses.values());
    this.queue = [];
    this.listeners.clear();

    if (procs.length === 0) {
      this.activeProcesses.clear();
      this.activeJobs.clear();
      return;
    }

    // Send SIGTERM to all
    for (const proc of procs) {
      try { proc.kill('SIGTERM'); } catch {}
    }

    // Wait for exit or escalate to SIGKILL
    await Promise.all(procs.map((proc) =>
      new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        proc.on('exit', done);
        proc.on('error', done);
        setTimeout(() => {
          if (!resolved) {
            try { proc.kill('SIGKILL'); } catch {}
            // Give SIGKILL a moment
            setTimeout(done, 500);
          }
        }, timeoutMs);
      }),
    ));

    this.activeProcesses.clear();
    this.activeJobs.clear();
    this.eventBuffers.clear();
    this.accumulators.clear();
    for (const timer of this.cleanupTimers.values()) clearTimeout(timer);
    this.cleanupTimers.clear();
  }

  private processNext() {
    while (
      this.activeJobs.size < this.maxConcurrency &&
      this.queue.length > 0 &&
      this.processor
    ) {
      const job = this.queue.shift()!;
      this.activeJobs.set(job.id, job);
      job.status = 'running';

      this.broadcast({ type: 'job_started', jobId: job.id, position: 0, threadId: job.threadId }, job.id, job.sourceId);

      // Fire-and-forget — each job runs independently
      this.processor(job)
        .catch((err) => {
          job.status = 'error';
          job.error = err instanceof Error ? err.message : String(err);
          this.broadcast(
            { type: 'error', jobId: job.id, message: job.error },
            job.id,
            job.sourceId,
          );
        })
        .finally(() => {
          this.activeJobs.delete(job.id);
          this.activeProcesses.delete(job.id);
          // Schedule deferred cleanup of event buffer (gives reconnecting clients a window)
          this.scheduleBufferCleanup(job.id);
          // Try to start more queued jobs
          this.processNext();
          // Signal drain when everything is done
          if (this.activeJobs.size === 0 && this.queue.length === 0) {
            this.broadcast({ type: 'queue_drained' }, job.id);
          }
        });
    }
  }
}
