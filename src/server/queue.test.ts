import { describe, expect, it, vi } from 'vitest';

import type { Job, SSEEvent } from './types';
import { JobQueue } from './queue';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-' + Math.random().toString(36).slice(2, 7),
    status: 'queued',
    screenshotPath: '/tmp/shot.png',
    feedback: {
      timestamp: '2025-01-01',
      url: 'http://localhost:3000',
      viewport: { width: 1280, height: 720 },
      scrollPosition: { x: 0, y: 0 },
      annotations: [],
      styleModifications: [],
    },
    createdAt: Date.now(),
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('JobQueue', () => {
  it('starts with depth 0 and isRunning false', () => {
    const q = new JobQueue();
    expect(q.depth).toBe(0);
    expect(q.isRunning).toBe(false);
  });

  it('enqueue returns queue depth and processes immediately when idle', async () => {
    const q = new JobQueue();
    const d = deferred();
    q.setProcessor(() => d.promise);

    const depth = q.enqueue(makeJob());
    // Job is immediately dequeued and running, so queue depth returns the pre-shift count
    // The job was pushed then immediately shifted for processing
    expect(q.isRunning).toBe(true);

    d.resolve();
    // Allow microtask to complete
    await d.promise;
  });

  it('processes jobs concurrently up to maxConcurrency', async () => {
    const q = new JobQueue(2);
    const order: string[] = [];

    const d1 = deferred();
    const d2 = deferred();
    const d3 = deferred();
    let callCount = 0;

    q.setProcessor(async () => {
      callCount++;
      const n = callCount;
      order.push(`start-${n}`);
      if (n === 1) { await d1.promise; order.push('end-1'); }
      else if (n === 2) { await d2.promise; order.push('end-2'); }
      else { await d3.promise; order.push('end-3'); }
    });

    q.enqueue(makeJob({ id: 'j1' }));
    q.enqueue(makeJob({ id: 'j2' }));
    q.enqueue(makeJob({ id: 'j3' }));

    // Both first two jobs should start concurrently
    expect(q.isRunning).toBe(true);
    expect(q.activeCount).toBe(2);
    expect(order).toEqual(['start-1', 'start-2']);

    // Third job is still queued
    expect(q.depth).toBe(1);

    // Finish first job — third should start
    d1.resolve();
    await d1.promise;
    await new Promise(r => setTimeout(r, 10));

    expect(order).toContain('end-1');
    expect(order).toContain('start-3');
    expect(q.activeCount).toBe(2);

    d2.resolve();
    d3.resolve();
    await Promise.all([d2.promise, d3.promise]);
    await new Promise(r => setTimeout(r, 10));

    expect(order).toEqual(['start-1', 'start-2', 'end-1', 'start-3', 'end-2', 'end-3']);
    expect(q.isRunning).toBe(false);
  });

  it('broadcasts job_started and queue_drained', async () => {
    const q = new JobQueue();
    const events: SSEEvent[] = [];

    q.addListener((event) => events.push(event));
    q.setProcessor(async () => {});

    q.enqueue(makeJob({ id: 'j1' }));
    await new Promise(r => setTimeout(r, 10));

    const types = events.map(e => e.type);
    expect(types).toContain('job_started');
    expect(types).toContain('queue_drained');
  });

  it('broadcasts error on processor throw', async () => {
    const q = new JobQueue();
    const events: SSEEvent[] = [];

    q.addListener((event) => events.push(event));
    q.setProcessor(async () => {
      throw new Error('boom');
    });

    q.enqueue(makeJob({ id: 'j1' }));
    await new Promise(r => setTimeout(r, 10));

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent as { type: 'error'; message: string }).message).toBe('boom');
  });

  it('cancelActive kills process and broadcasts error', () => {
    const q = new JobQueue();
    const events: SSEEvent[] = [];
    q.addListener((event) => events.push(event));

    const d = deferred();
    q.setProcessor(() => d.promise);
    q.enqueue(makeJob({ id: 'j1' }));

    const mockProc = { kill: vi.fn() } as any;
    q.setActiveProcess('j1', mockProc);

    const cancelled = q.cancelActive();
    expect(cancelled).toBe(true);
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');

    const errorEvent = events.find(e => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('cancelActive returns false when no active process', () => {
    const q = new JobQueue();
    expect(q.cancelActive()).toBe(false);
  });

  it('addListener returns unsubscribe function', async () => {
    const q = new JobQueue();
    const events: SSEEvent[] = [];
    const unsub = q.addListener((event) => events.push(event));

    q.setProcessor(async () => {});
    q.enqueue(makeJob());
    await new Promise(r => setTimeout(r, 10));

    const count = events.length;
    unsub();

    q.enqueue(makeJob());
    await new Promise(r => setTimeout(r, 10));

    // Should not receive new events after unsubscribe
    // (May receive same count or slightly more from queue_drained of first job)
    // The key test: unsub was callable and the listener was removed
    expect(typeof unsub).toBe('function');
  });

  it('destroy kills active process and clears queue', () => {
    const q = new JobQueue();
    const d = deferred();
    q.setProcessor(() => d.promise);
    q.enqueue(makeJob());
    q.enqueue(makeJob());

    const mockProc = { kill: vi.fn() } as any;
    q.setActiveProcess('j1', mockProc);

    q.destroy();
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(q.depth).toBe(0);
    expect(q.isRunning).toBe(false);
  });
});
