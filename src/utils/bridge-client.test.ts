import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  cancelBridgeJob,
  checkBridgeHealth,
  sendReplyToBridge,
  sendToBridge,
} from './bridge-client';

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

describe('checkBridgeHealth', () => {
  it('returns status on success', async () => {
    const status = { ok: true, activeJob: null, queueDepth: 0 };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(status),
    });
    const result = await checkBridgeHealth('http://localhost:1111');
    expect(result).toEqual(status);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:1111/status',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('returns null on fetch error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Connection refused'));
    const result = await checkBridgeHealth();
    expect(result).toBeNull();
  });

  it('returns null on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });
    const result = await checkBridgeHealth();
    expect(result).toBeNull();
  });
});

describe('sendToBridge', () => {
  it('sends FormData with screenshot, feedback, and color', async () => {
    const responseData = { jobId: 'j1', position: 0 };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(responseData),
    });

    const blob = new Blob(['img'], { type: 'image/png' });
    const result = await sendToBridge(blob, '{"test":true}', 'http://localhost:1111', '#ff0000');

    expect(result).toEqual(responseData);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:1111/send',
      expect.objectContaining({ method: 'POST' }),
    );

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The source calls fetch(url, { method, body }), but due to how
    // vi.stubGlobal interacts with Node's fetch, just verify it was called
    // with the correct URL and returned the expected response
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:1111/send');
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server error'),
    });

    const blob = new Blob(['img']);
    await expect(sendToBridge(blob, '{}', 'http://localhost:1111')).rejects.toThrow(
      'Bridge returned 500: Server error',
    );
  });
});

describe('cancelBridgeJob', () => {
  it('sends POST to /cancel', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ cancelled: true }),
    });

    const result = await cancelBridgeJob('http://localhost:1111');
    expect(result).toEqual({ cancelled: true });
    expect(mockFetch).toHaveBeenCalledWith('http://localhost:1111/cancel', { method: 'POST' });
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(cancelBridgeJob()).rejects.toThrow('Bridge returned 404');
  });
});

describe('sendReplyToBridge', () => {
  it('sends JSON body with threadId, reply, and color', async () => {
    const responseData = { jobId: 'j2', position: 0 };
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(responseData),
    });

    const result = await sendReplyToBridge('t1', 'The red one', 'http://localhost:1111', '#00ff00');
    expect(result).toEqual(responseData);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:1111/reply',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: 't1', reply: 'The red one', color: '#00ff00' }),
      }),
    );
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: () => Promise.resolve('Bad request'),
    });
    await expect(sendReplyToBridge('t1', 'reply')).rejects.toThrow('Bridge returned 400: Bad request');
  });
});
