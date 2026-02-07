import type { IncomingMessage } from 'node:http';

export type ParsedMultipart = {
  screenshot: Buffer;
  feedback: string;
  color?: string;
  provider?: string;
  model?: string;
  // Planner fields
  goal?: string;
  pageUrl?: string;
  viewport?: string;
  planId?: string;
};

/**
 * Minimal multipart/form-data parser.
 * Expects exactly two fields: "screenshot" (binary) and "feedback" (JSON string).
 */
export async function parseMultipart(req: IncomingMessage): Promise<ParsedMultipart> {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^\s;]+))/);
  if (!boundaryMatch) {
    throw new Error('Missing multipart boundary');
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2]!;

  const body = await readBody(req);
  const delimiter = Buffer.from(`--${boundary}`);
  const endDelimiter = Buffer.from(`--${boundary}--`);

  let screenshot: Buffer | undefined;
  let feedback: string | undefined;
  let color: string | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let goal: string | undefined;
  let pageUrl: string | undefined;
  let viewport: string | undefined;
  let planId: string | undefined;

  // Split body by delimiter
  let offset = 0;
  const parts: { headers: string; body: Buffer }[] = [];

  while (offset < body.length) {
    const delimStart = body.indexOf(delimiter, offset);
    if (delimStart === -1) break;

    const afterDelim = delimStart + delimiter.length;

    // Check for end delimiter
    if (body.slice(delimStart, delimStart + endDelimiter.length).equals(endDelimiter)) {
      break;
    }

    // Skip CRLF after delimiter
    let headerStart = afterDelim;
    if (body[headerStart] === 0x0d && body[headerStart + 1] === 0x0a) {
      headerStart += 2;
    }

    // Find end of headers (double CRLF)
    const headerEnd = body.indexOf('\r\n\r\n', headerStart);
    if (headerEnd === -1) break;

    const headers = body.slice(headerStart, headerEnd).toString('utf-8');
    const bodyStart = headerEnd + 4;

    // Find next delimiter to determine body end
    const nextDelim = body.indexOf(delimiter, bodyStart);
    const bodyEnd = nextDelim !== -1 ? nextDelim - 2 : body.length; // -2 for CRLF before delimiter

    parts.push({
      headers,
      body: body.slice(bodyStart, bodyEnd),
    });

    offset = nextDelim !== -1 ? nextDelim : body.length;
  }

  for (const part of parts) {
    const nameMatch = part.headers.match(/name="([^"]+)"/);
    if (!nameMatch) continue;

    const name = nameMatch[1];
    if (name === 'screenshot') {
      screenshot = part.body;
    } else if (name === 'feedback') {
      feedback = part.body.toString('utf-8');
    } else if (name === 'color') {
      color = part.body.toString('utf-8');
    } else if (name === 'provider') {
      provider = part.body.toString('utf-8');
    } else if (name === 'model') {
      model = part.body.toString('utf-8');
    } else if (name === 'goal') {
      goal = part.body.toString('utf-8');
    } else if (name === 'pageUrl') {
      pageUrl = part.body.toString('utf-8');
    } else if (name === 'viewport') {
      viewport = part.body.toString('utf-8');
    } else if (name === 'planId') {
      planId = part.body.toString('utf-8');
    }
  }

  if (!screenshot) throw new Error('Missing screenshot field');
  // feedback is optional for plan endpoints
  if (!feedback) feedback = '';

  return { screenshot, feedback, color, provider, model, goal, pageUrl, viewport, planId };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
