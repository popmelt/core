const DEFAULT_BRIDGE_URL = 'http://localhost:1111';

function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  if (init.signal) {
    // Chain the existing signal
    init.signal.addEventListener('abort', () => controller.abort());
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export type BridgeStatus = {
  ok: boolean;
  activeJob: { id: string; status: string } | null;
  activeJobs?: { id: string; status: string }[];
  queueDepth: number;
  recentJobs?: { id: string; status: string; completedAt: number; error?: string; threadId?: string }[];
};

export type McpDetectionResult = {
  found: boolean;
  name: string | null;
  scope: 'user' | 'project' | 'mcp.json' | null;
  disabled: boolean;
};

export type InstallResult = {
  installed: boolean;
  provider: string;
  scope: 'user' | null;
  reason?: string;
};

export type ProviderCapabilities = {
  providers: Record<string, {
    available: boolean;
    path: string | null;
    mcp?: McpDetectionResult;
  }>;
};

export async function fetchCapabilities(
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<ProviderCapabilities | null> {
  try {
    const res = await fetchWithTimeout(`${bridgeUrl}/capabilities`, {}, 5000);
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
  sourceId?: string,
): Promise<{ jobId: string; position: number; threadId?: string }> {
  const formData = new FormData();
  formData.append('screenshot', screenshotBlob, 'screenshot.png');
  formData.append('feedback', feedbackJson);
  if (color) formData.append('color', color);
  if (provider) formData.append('provider', provider);
  if (model) formData.append('model', model);
  if (sourceId) formData.append('sourceId', sourceId);
  if (pastedImages) {
    for (const [annotationId, blobs] of pastedImages) {
      for (let i = 0; i < blobs.length; i++) {
        formData.append(`image-${annotationId}-${i}`, blobs[i]!, `image-${annotationId}-${i}.png`);
      }
    }
  }

  const res = await fetchWithTimeout(`${bridgeUrl}/send`, {
    method: 'POST',
    body: formData,
  }, 30000);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}

export async function cancelBridgeJob(
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<{ cancelled: boolean }> {
  const res = await fetchWithTimeout(`${bridgeUrl}/cancel`, { method: 'POST' }, 5000);
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
  sourceId?: string,
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
  if (sourceId) formData.append('sourceId', sourceId);

  const res = await fetchWithTimeout(`${bridgeUrl}/plan`, {
    method: 'POST',
    body: formData,
  }, 30000);

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
  const res = await fetchWithTimeout(`${bridgeUrl}/plan/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId, approvedTaskIds }),
  }, 10000);

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
  sourceId?: string,
): Promise<{ jobId: string; planId: string; position: number }> {
  const formData = new FormData();
  formData.append('screenshot', screenshotBlob, 'screenshot.png');
  formData.append('planId', planId);
  if (provider) formData.append('provider', provider);
  if (model) formData.append('model', model);
  if (sourceId) formData.append('sourceId', sourceId);

  const res = await fetchWithTimeout(`${bridgeUrl}/plan/review`, {
    method: 'POST',
    body: formData,
  }, 30000);

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
  sourceId?: string,
): Promise<{ jobId: string; planId: string; position: number }> {
  const formData = new FormData();
  formData.append('screenshot', screenshotBlob, 'screenshot.png');
  formData.append('planId', planId);
  formData.append('tasks', JSON.stringify(tasks));
  if (provider) formData.append('provider', provider);
  if (model) formData.append('model', model);
  if (sourceId) formData.append('sourceId', sourceId);

  const res = await fetchWithTimeout(`${bridgeUrl}/plan/execute`, {
    method: 'POST',
    body: formData,
  }, 30000);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}

export async function installMcp(
  bridgeUrl = DEFAULT_BRIDGE_URL,
  serverUrl?: string,
): Promise<{ results: InstallResult[]; capabilities: ProviderCapabilities } | null> {
  try {
    const res = await fetchWithTimeout(`${bridgeUrl}/mcp/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(serverUrl ? { serverUrl } : {}),
    }, 15000);
    if (!res.ok) return null;
    return (await res.json()) as { results: InstallResult[]; capabilities: ProviderCapabilities };
  } catch {
    return null;
  }
}

export type DesignModel = {
  tokens?: Record<string, Record<string, string>>;
  components?: Record<string, Record<string, string>>;
  rules?: string[];
} | null;

export async function addComponentToModel(
  name: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<{ added: boolean; alreadyExists: boolean }> {
  const res = await fetchWithTimeout(`${bridgeUrl}/model/component`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }, 10000);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }
  return res.json();
}

export async function removeComponentFromModel(
  name: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<{ removed: boolean }> {
  const res = await fetchWithTimeout(`${bridgeUrl}/model/component`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }, 10000);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }
  return res.json();
}

export async function updateModelToken(
  path: string,
  value: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<{ updated: boolean }> {
  const res = await fetchWithTimeout(`${bridgeUrl}/model/token`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, value }),
  }, 10000);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }
  return res.json();
}

export async function removeModelToken(
  path: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<{ removed: boolean }> {
  const res = await fetchWithTimeout(`${bridgeUrl}/model/token`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }, 10000);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }
  return res.json();
}

export async function fetchModel(
  bridgeUrl = DEFAULT_BRIDGE_URL,
): Promise<DesignModel> {
  try {
    const res = await fetchWithTimeout(`${bridgeUrl}/model`, {}, 5000);
    if (!res.ok) return null;
    const data = await res.json();
    return data.model ?? null;
  } catch {
    return null;
  }
}

export async function sendReplyToBridge(
  threadId: string,
  reply: string,
  bridgeUrl = DEFAULT_BRIDGE_URL,
  color?: string,
  provider?: string,
  model?: string,
  images?: Blob[],
  sourceId?: string,
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
    formData.append('feedback', JSON.stringify({ threadId, reply, color, provider, model, sourceId }));
    for (let i = 0; i < images.length; i++) {
      formData.append(`image-reply-${i}`, images[i]!, `reply-image-${i}.png`);
    }
    res = await fetchWithTimeout(`${bridgeUrl}/reply`, {
      method: 'POST',
      body: formData,
    }, 30000);
  } else {
    // JSON: no images
    res = await fetchWithTimeout(`${bridgeUrl}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId, reply, color, provider, model, sourceId }),
    }, 30000);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Bridge returned ${res.status}: ${body}`);
  }

  return res.json();
}
