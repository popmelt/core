import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Thread, ThreadMessage, ThreadStore } from './types';

const EMPTY_STORE: ThreadStore = { version: 1, threads: {} };

export class ThreadFileStore {
  private filePath: string;
  private cache: ThreadStore | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(projectRoot: string) {
    this.filePath = join(projectRoot, '.popmelt', 'threads.json');
  }

  async load(): Promise<ThreadStore> {
    if (this.cache) return this.cache;

    try {
      const raw = await readFile(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.threads) {
        this.cache = parsed as ThreadStore;
        return this.cache;
      }
    } catch {
      // Missing or corrupt file — start fresh
    }

    this.cache = { ...EMPTY_STORE, threads: {} };
    return this.cache;
  }

  async getThread(id: string): Promise<Thread | null> {
    const store = await this.load();
    return store.threads[id] ?? null;
  }

  async findContinuationThread(linkedSelectors: string[]): Promise<Thread | null> {
    if (linkedSelectors.length === 0) return null;

    const store = await this.load();
    const selectorSet = new Set(linkedSelectors);

    for (const thread of Object.values(store.threads)) {
      const hasOverlap = thread.elementIdentifiers.some(id => selectorSet.has(id));
      if (hasOverlap) return thread;
    }

    return null;
  }

  async createThread(id: string, linkedSelectors: string[]): Promise<Thread> {
    const store = await this.load();

    const thread: Thread = {
      id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      elementIdentifiers: linkedSelectors,
      messages: [],
    };

    store.threads[id] = thread;
    await this.persist();
    return thread;
  }

  async appendMessage(threadId: string, message: ThreadMessage): Promise<void> {
    const store = await this.load();
    const thread = store.threads[threadId];
    if (!thread) return;

    thread.messages.push(message);
    thread.updatedAt = Date.now();
    await this.persist();
  }

  async addElementIdentifiers(threadId: string, selectors: string[]): Promise<void> {
    const store = await this.load();
    const thread = store.threads[threadId];
    if (!thread) return;

    const existing = new Set(thread.elementIdentifiers);
    for (const sel of selectors) {
      if (!existing.has(sel)) {
        thread.elementIdentifiers.push(sel);
      }
    }
    thread.updatedAt = Date.now();
    await this.persist();
  }

  async getThreadHistory(threadId: string, maxMessages = 6): Promise<ThreadMessage[]> {
    const thread = await this.getThread(threadId);
    if (!thread || thread.messages.length === 0) return [];

    if (thread.messages.length <= maxMessages) {
      return thread.messages;
    }

    // Keep first message + last (maxMessages - 1)
    return [
      thread.messages[0]!,
      ...thread.messages.slice(-(maxMessages - 1)),
    ];
  }

  private async persist(): Promise<void> {
    // Chain writes to avoid concurrent write races
    this.writeChain = this.writeChain.then(async () => {
      if (!this.cache) return;
      try {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, JSON.stringify(this.cache, null, 2));
      } catch (err) {
        console.error('[ThreadStore] Failed to persist:', err);
      }
    });
    await this.writeChain;
  }
}
