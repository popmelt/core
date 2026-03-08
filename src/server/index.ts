import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPopmelt, probeBridge } from './bridge-server';
import type { PopmeltHandle, PopmeltOptions } from './types';
import { VERSION } from '../version';

export type { PopmeltHandle, PopmeltOptions };

const DEFAULT_PORT = 1111;

export async function startPopmelt(
  options?: PopmeltOptions & { force?: boolean; detached?: boolean },
): Promise<PopmeltHandle> {
  if (process.env.NODE_ENV === 'production' && !options?.force) {
    throw new Error(
      '[Bridge] Refusing to start in production. Pass { force: true } to override.',
    );
  }

  if (options?.detached) {
    return startDetached(options);
  }

  const handle = await createPopmelt(options);
  process.env.POPMELT_BRIDGE_PORT = String(handle.port);
  return handle;
}

async function startDetached(
  options: PopmeltOptions & { force?: boolean },
): Promise<PopmeltHandle> {
  const basePort = options.port ?? DEFAULT_PORT;
  const projectRoot = options.projectRoot ?? process.cwd();
  const projectId = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12);

  // Check ports 1111–1120 for an existing bridge belonging to this project
  for (let p = basePort; p < basePort + 10; p++) {
    const status = await probeBridge(p);
    if (status && status.projectId === projectId) {
      // Version mismatch — shut down stale bridge and spawn fresh
      if (status.version && status.version !== VERSION) {
        try { await fetch(`http://127.0.0.1:${p}/shutdown`, { method: 'POST' }); } catch {}
        await new Promise((r) => setTimeout(r, 500));
        break;
      }
      // Refresh devOrigin if the app came back on a different port
      const wantedOrigin = options.devOrigin;
      if (wantedOrigin && status.devOrigin !== wantedOrigin) {
        try {
          await fetch(`http://127.0.0.1:${p}/config`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ devOrigin: wantedOrigin }),
          });
        } catch {}
      }
      process.env.POPMELT_BRIDGE_PORT = String(p);
      return { port: p, projectId, close: async () => {} };
    }
  }

  // No existing bridge — spawn a detached child process
  const bridgeEntryPath = join(dirname(fileURLToPath(import.meta.url)), 'bridge-entry.mjs');

  spawn(process.execPath, [bridgeEntryPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      POPMELT_PORT: String(basePort),
      POPMELT_PROJECT_ROOT: projectRoot,
      POPMELT_DEV_ORIGIN: options.devOrigin ?? '',
    },
  }).unref();

  // Poll /status until the bridge is ready (up to ~3s)
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    for (let p = basePort; p < basePort + 10; p++) {
      const status = await probeBridge(p);
      if (status && status.projectId === projectId) {
        process.env.POPMELT_BRIDGE_PORT = String(p);
        return { port: p, projectId, close: async () => {} };
      }
    }
  }

  throw new Error(`[Bridge] Detached bridge failed to start within 3s (port ${basePort})`);
}
