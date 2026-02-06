const DEFAULT_BRIDGE_URL = 'http://localhost:1111';

export type BridgeStatus = {
  ok: boolean;
  activeJob: { id: string; status: string } | null;
  queueDepth: number;
};

export async function checkBridgeHealth(
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<BridgeStatus | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`${bridgeUrl}/status`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return null;
    return (await res.json()) as BridgeStatus;
  } catch {
    return null;
  }
}

export async function sendToBridge(
  screenshotBlob: Blob,
  feedbackJson: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
  color?: string,
  provider?: string,
): Promise<{ jobId: string; position: number }> {
  const formData = new FormData();
  formData.append('screenshot', screenshotBlob, 'screenshot.png');
  formData.append('feedback', feedbackJson);
  if (color) formData.append('color', color);
  if (provider) formData.append('provider', provider);

  const res = await fetch(`${bridgeUrl}/send`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}

export async function cancelBridgeJob(
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<{ cancelled: boolean }> {
  const res = await fetch(`${bridgeUrl}/cancel`, { method: 'POST' });
  if (!res.ok) throw new Error(`Bridge returned ${res.status}`);
  return res.json();
}

export async function sendReplyToBridge(
  threadId: string,
  reply: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
  color?: string,
  provider?: string,
): Promise<{ jobId: string; position: number }> {
  const res = await fetch(`${bridgeUrl}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, reply, color, provider }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}
