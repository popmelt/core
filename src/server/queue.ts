import type { ChildProcess } from 'node:child_process';

import type { Job, SSEEvent } from './types';

export type QueueListener = (event: SSEEvent, jobId: string) => void;

export class JobQueue {
  private queue: Job[] = [];
  private activeJob: Job | null = null;
  private activeProcess: ChildProcess | null = null;
  private listeners: Set<QueueListener> = new Set();
  private processor: ((job: Job) => Promise<void>) | null = null;

  setProcessor(fn: (job: Job) => Promise<void>) {
    this.processor = fn;
  }

  get active() {
    return this.activeJob;
  }

  get depth() {
    return this.queue.length;
  }

  get isRunning() {
    return this.activeJob !== null;
  }

  setActiveProcess(proc: ChildProcess | null) {
    this.activeProcess = proc;
  }

  enqueue(job: Job): number {
    this.queue.push(job);
    // If nothing is running, process immediately
    if (!this.activeJob) {
      this.processNext();
    }
    return this.queue.length;
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

  cancelActive(): boolean {
    if (!this.activeProcess) return false;
    this.activeProcess.kill('SIGTERM');
    this.activeProcess = null;
    if (this.activeJob) {
      this.activeJob.status = 'error';
      this.activeJob.error = 'Cancelled by user';
      this.broadcast(
        { type: 'error', jobId: this.activeJob.id, message: 'Cancelled by user' },
        this.activeJob.id,
      );
      this.activeJob = null;
    }
    this.processNext();
    return true;
  }

  destroy() {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
    this.activeJob = null;
    this.queue = [];
    this.listeners.clear();
  }

  private async processNext() {
    if (this.activeJob || this.queue.length === 0 || !this.processor) return;

    const job = this.queue.shift()!;
    this.activeJob = job;
    job.status = 'running';

    this.broadcast({ type: 'job_started', jobId: job.id, position: 0 }, job.id);

    try {
      await this.processor(job);
    } catch (err) {
      job.status = 'error';
      job.error = err instanceof Error ? err.message : String(err);
      this.broadcast(
        { type: 'error', jobId: job.id, message: job.error },
        job.id,
      );
    } finally {
      this.activeJob = null;
      this.activeProcess = null;
      // Process next in queue, or signal drain
      this.processNext();
      if (!this.activeJob) {
        this.broadcast({ type: 'queue_drained' }, job.id);
      }
    }
  }
}
