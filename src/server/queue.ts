import type { ChildProcess } from 'node:child_process';

import type { Job, SSEEvent } from './types';

export type QueueListener = (event: SSEEvent, jobId: string) => void;

export class JobQueue {
  private queue: Job[] = [];
  private activeJobs = new Map<string, Job>();
  private activeProcesses = new Map<string, ChildProcess>();
  private listeners: Set<QueueListener> = new Set();
  private processor: ((job: Job) => Promise<void>) | null = null;
  private maxConcurrency: number;

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

  broadcast(event: SSEEvent, jobId: string) {
    for (const listener of this.listeners) {
      listener(event, jobId);
    }
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
      { type: 'error', jobId: job.id, message: 'Cancelled by user' },
      job.id,
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

      this.broadcast({ type: 'job_started', jobId: job.id, position: 0 }, job.id);

      // Fire-and-forget — each job runs independently
      this.processor(job)
        .catch((err) => {
          job.status = 'error';
          job.error = err instanceof Error ? err.message : String(err);
          this.broadcast(
            { type: 'error', jobId: job.id, message: job.error },
            job.id,
          );
        })
        .finally(() => {
          this.activeJobs.delete(job.id);
          this.activeProcesses.delete(job.id);
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
