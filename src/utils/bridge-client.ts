const DEFAULT_BRIDGE_URL = 'http://localhost:1111';

export type BridgeStatus = {
  ok: boolean;
  activeJob: { id: string; status: string } | null;
  activeJobs?: { id: string; status: string }[];
  queueDepth: number;
};

export type ProviderCapabilities = {
  providers: Record<string, { available: boolean; path: string | null }>;
};

export async function fetchCapabilities(
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<ProviderCapabilities | null> {
  try {
    const res = await fetch(`${bridgeUrl}/capabilities`);
    if (!res.ok) return null;
    return (await res.json()) as ProviderCapabilities;
  } catch {
    return null;
  }
}

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
  model?: string,
  pastedImages?: Map<string, Blob[]>,
): Promise<{ jobId: string; position: number; threadId?: string }> {
  const formData = new FormData();
  formData.append('screenshot', screenshotBlob, 'screenshot.png');
  formData.append('feedback', feedbackJson);
  if (color) formData.append('color', color);
  if (provider) formData.append('provider', provider);
  if (model) formData.append('model', model);
  if (pastedImages) {
    for (const [annotationId, blobs] of pastedImages) {
      for (let i = 0; i < blobs.length; i++) {
        formData.append(`image-${annotationId}-${i}`, blobs[i]!, `image-${annotationId}-${i}.png`);
      }
    }
  }

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

export async function sendPlanToBridge(
  screenshotBlob: Blob,
  goal: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
  provider?: string,
  model?: string,
  pageUrl?: string,
  viewport?: { width: number; height: number },
  manifest?: import('../tools/types').ManifestEntry[],
  feedbackJson?: string,
): Promise<{ planId: string; jobId: string; position: number; threadId?: string }> {
  const formData = new FormData();
  formData.append('screenshot', screenshotBlob, 'screenshot.png');
  formData.append('goal', goal);
  if (pageUrl) formData.append('pageUrl', pageUrl);
  if (viewport) formData.append('viewport', JSON.stringify(viewport));
  if (provider) formData.append('provider', provider);
  if (model) formData.append('model', model);
  if (manifest) formData.append('manifest', JSON.stringify(manifest));
  if (feedbackJson) formData.append('feedback', feedbackJson);

  const res = await fetch(`${bridgeUrl}/plan`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}

export async function approvePlan(
  planId: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
  approvedTaskIds?: string[],
): Promise<{ planId: string; tasks: unknown[]; status: string }> {
  const res = await fetch(`${bridgeUrl}/plan/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId, approvedTaskIds }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}

export async function sendPlanReview(
  planId: string,
  screenshotBlob: Blob,
  bridgeUrl = DEFAULT_BRIDGE_URL,
  provider?: string,
  model?: string,
): Promise<{ jobId: string; planId: string; position: number }> {
  const formData = new FormData();
  formData.append('screenshot', screenshotBlob, 'screenshot.png');
  formData.append('planId', planId);
  if (provider) formData.append('provider', provider);
  if (model) formData.append('model', model);

  const res = await fetch(`${bridgeUrl}/plan/review`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}

export async function sendPlanExecution(
  screenshotBlob: Blob,
  planId: string,
  tasks: Array<{
    planTaskId: string;
    annotationId: string;
    instruction: string;
    region: { x: number; y: number; width: number; height: number };
    linkedSelector?: string;
    elements?: Array<{ selector: string; reactComponent?: string }>;
  }>,
  bridgeUrl = DEFAULT_BRIDGE_URL,
  provider?: string,
  model?: string,
): Promise<{ jobId: string; planId: string; position: number }> {
  const formData = new FormData();
  formData.append('screenshot', screenshotBlob, 'screenshot.png');
  formData.append('planId', planId);
  formData.append('tasks', JSON.stringify(tasks));
  if (provider) formData.append('provider', provider);
  if (model) formData.append('model', model);

  const res = await fetch(`${bridgeUrl}/plan/execute`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}

export async function sendReplyToBridge(
  threadId: string,
  reply: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
  color?: string,
  provider?: string,
  model?: string,
  images?: Blob[],
): Promise<{ jobId: string; position: number; threadId?: string }> {
  let res: Response;

  if (images && images.length > 0) {
    // Multipart: include attached images
    const formData = new FormData();
    // 1x1 transparent PNG placeholder for the required "screenshot" field
    const placeholder = new Blob([new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
      0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x00, 0x00, 0x02,
      0x00, 0x01, 0xe5, 0x27, 0xde, 0xfc, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
      0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])], { type: 'image/png' });
    formData.append('screenshot', placeholder, 'screenshot.png');
    formData.append('feedback', JSON.stringify({ threadId, reply, color, provider, model }));
    for (let i = 0; i < images.length; i++) {
      formData.append(`image-reply-${i}`, images[i]!, `reply-image-${i}.png`);
    }
    res = await fetch(`${bridgeUrl}/reply`, {
      method: 'POST',
      body: formData,
    });
  } else {
    // JSON: no images
    res = await fetch(`${bridgeUrl}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, reply, color, provider, model }),
    });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}
