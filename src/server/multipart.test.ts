import { Readable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import type { IncomingMessage } from 'node:http';

import { parseMultipart } from './multipart';

function buildMultipartBody(
  boundary: string,
  fields: { name: string; filename?: string; contentType?: string; value: Buffer | string }[],
): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    let headers = `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"`;
    if (field.filename) headers += `; filename="${field.filename}"`;
    headers += '\r\n';
    if (field.contentType) headers += `Content-Type: ${field.contentType}\r\n`;
    headers += '\r\n';

    const body = typeof field.value === 'string' ? Buffer.from(field.value) : field.value;
    parts.push(Buffer.from(headers));
    parts.push(body);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

function createMockRequest(
  body: Buffer,
  contentType: string,
): IncomingMessage {
  const readable = new Readable();
  readable.push(body);
  readable.push(null);
  (readable as any).headers = { 'content-type': contentType };
  return readable as unknown as IncomingMessage;
}

describe('parseMultipart', () => {
  const boundary = '----TestBoundary123';

  it('parses screenshot and feedback fields', async () => {
    const screenshotData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const feedbackJson = JSON.stringify({ url: 'http://localhost:3000' });

    const body = buildMultipartBody(boundary, [
      { name: 'screenshot', filename: 'screenshot.png', contentType: 'image/png', value: screenshotData },
      { name: 'feedback', value: feedbackJson },
    ]);

    const req = createMockRequest(body, `multipart/form-data; boundary=${boundary}`);
    const result = await parseMultipart(req);

    expect(result.screenshot).toBeInstanceOf(Buffer);
    expect(result.screenshot.length).toBeGreaterThan(0);
    expect(result.feedback).toBe(feedbackJson);
  });

  it('parses optional color field', async () => {
    const body = buildMultipartBody(boundary, [
      { name: 'screenshot', filename: 'screenshot.png', value: Buffer.from('img') },
      { name: 'feedback', value: '{}' },
      { name: 'color', value: '#ff0000' },
    ]);

    const req = createMockRequest(body, `multipart/form-data; boundary=${boundary}`);
    const result = await parseMultipart(req);
    expect(result.color).toBe('#ff0000');
  });

  it('throws on missing boundary', async () => {
    const req = createMockRequest(Buffer.from(''), 'multipart/form-data');
    await expect(parseMultipart(req)).rejects.toThrow('Missing multipart boundary');
  });

  it('throws on missing screenshot', async () => {
    const body = buildMultipartBody(boundary, [
      { name: 'feedback', value: '{}' },
    ]);
    const req = createMockRequest(body, `multipart/form-data; boundary=${boundary}`);
    await expect(parseMultipart(req)).rejects.toThrow('Missing screenshot field');
  });

  it('throws on missing feedback', async () => {
    const body = buildMultipartBody(boundary, [
      { name: 'screenshot', filename: 'screenshot.png', value: Buffer.from('img') },
    ]);
    const req = createMockRequest(body, `multipart/form-data; boundary=${boundary}`);
    await expect(parseMultipart(req)).rejects.toThrow('Missing feedback field');
  });

  it('handles quoted boundary in content-type', async () => {
    const body = buildMultipartBody(boundary, [
      { name: 'screenshot', filename: 'screenshot.png', value: Buffer.from('img') },
      { name: 'feedback', value: '{}' },
    ]);
    const req = createMockRequest(body, `multipart/form-data; boundary="${boundary}"`);
    const result = await parseMultipart(req);
    expect(result.feedback).toBe('{}');
  });
});
