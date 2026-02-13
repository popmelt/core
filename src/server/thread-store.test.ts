import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ThreadMessage } from './types';

// Mock fs/promises before importing the module
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { mkdir, readFile, writeFile } from 'node:fs/promises';

import { ThreadFileStore } from './thread-store';

const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);
const mockMkdir = vi.mocked(mkdir);

describe('ThreadFileStore', () => {
  let store: ThreadFileStore;

  beforeEach(() => {
    vi.resetAllMocks();
    mockWriteFile.mockResolvedValue(undefined as never);
    mockMkdir.mockResolvedValue(undefined as never);
    store = new ThreadFileStore('/project');
  });

  describe('load', () => {
    it('returns empty store when file is missing', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const result = await store.load();
      expect(result.version).toBe(1);
      expect(result.threads).toEqual({});
    });

    it('parses valid file', async () => {
      const data = { version: 1, threads: { t1: { id: 't1', createdAt: 1, updatedAt: 1, elementIdentifiers: [], messages: [] } } };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(data));
      const result = await store.load();
      expect(result.threads.t1).toBeDefined();
      expect(result.threads.t1!.id).toBe('t1');
    });

    it('caches result on subsequent calls', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      await store.load();
      await store.load();
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('getThread', () => {
    it('returns null for unknown ID', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const thread = await store.getThread('unknown');
      expect(thread).toBeNull();
    });

    it('returns thread by ID', async () => {
      const data = { version: 1, threads: { t1: { id: 't1', createdAt: 1, updatedAt: 1, elementIdentifiers: ['div.test'], messages: [] } } };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(data));
      const thread = await store.getThread('t1');
      expect(thread).not.toBeNull();
      expect(thread!.id).toBe('t1');
    });
  });

  describe('findContinuationThread', () => {
    it('returns null for empty selectors', async () => {
      // findContinuationThread returns early for empty selectors without calling load()
      const result = await store.findContinuationThread([]);
      expect(result).toBeNull();
    });

    it('finds thread with overlapping selectors', async () => {
      const data = {
        version: 1,
        threads: {
          t1: { id: 't1', createdAt: 1, updatedAt: 1, elementIdentifiers: ['div.card', 'p.text'], messages: [] },
        },
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(data));
      const result = await store.findContinuationThread(['div.card']);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('t1');
    });

    it('returns null when no overlap', async () => {
      const data = {
        version: 1,
        threads: {
          t1: { id: 't1', createdAt: 1, updatedAt: 1, elementIdentifiers: ['div.card'], messages: [] },
        },
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(data));
      const result = await store.findContinuationThread(['div.other']);
      expect(result).toBeNull();
    });
  });

  describe('createThread', () => {
    it('creates thread and persists', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const thread = await store.createThread('t1', ['div.card']);
      expect(thread.id).toBe('t1');
      expect(thread.elementIdentifiers).toEqual(['div.card']);
      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
    });
  });

  describe('appendMessage', () => {
    it('adds message to thread', async () => {
      const data = {
        version: 1,
        threads: {
          t1: { id: 't1', createdAt: 1, updatedAt: 1, elementIdentifiers: [], messages: [] },
        },
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(data));

      const msg: ThreadMessage = { role: 'human', timestamp: 123, jobId: 'j1', feedbackSummary: 'Fix it' };
      await store.appendMessage('t1', msg);

      // Verify the thread now has the message by checking what was written
      expect(mockWriteFile).toHaveBeenCalled();
      const written = JSON.parse(mockWriteFile.mock.calls[0]![1] as string);
      expect(written.threads.t1.messages).toHaveLength(1);
      expect(written.threads.t1.messages[0].feedbackSummary).toBe('Fix it');
    });

    it('no-op for unknown threadId', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const msg: ThreadMessage = { role: 'human', timestamp: 123, jobId: 'j1' };
      await store.appendMessage('unknown', msg);
      expect(mockWriteFile).not.toHaveBeenCalled();
    });
  });

  describe('getThreadHistory', () => {
    it('returns all messages when <= maxMessages', async () => {
      const messages: ThreadMessage[] = [
        { role: 'human', timestamp: 1, jobId: 'j1' },
        { role: 'assistant', timestamp: 2, jobId: 'j1' },
      ];
      const data = {
        version: 1,
        threads: {
          t1: { id: 't1', createdAt: 1, updatedAt: 1, elementIdentifiers: [], messages },
        },
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(data));
      const history = await store.getThreadHistory('t1');
      expect(history).toHaveLength(2);
    });

    it('truncates to first + last (N-1) messages', async () => {
      const messages: ThreadMessage[] = Array.from({ length: 10 }, (_, i) => ({
        role: (i % 2 === 0 ? 'human' : 'assistant') as 'human' | 'assistant',
        timestamp: i,
        jobId: `j${i}`,
        feedbackSummary: `msg-${i}`,
      }));
      const data = {
        version: 1,
        threads: {
          t1: { id: 't1', createdAt: 1, updatedAt: 1, elementIdentifiers: [], messages },
        },
      };
      mockReadFile.mockResolvedValueOnce(JSON.stringify(data));
      const history = await store.getThreadHistory('t1', 6);
      expect(history).toHaveLength(6);
      // First message preserved
      expect(history[0]!.feedbackSummary).toBe('msg-0');
      // Last 5 messages (indices 5-9)
      expect(history[5]!.feedbackSummary).toBe('msg-9');
    });

    it('returns empty array for unknown thread', async () => {
      mockReadFile.mockRejectedValueOnce(new Error('ENOENT'));
      const history = await store.getThreadHistory('unknown');
      expect(history).toEqual([]);
    });
  });
});
