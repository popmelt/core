/**
 * Standalone entry point for the detached bridge process.
 * Spawned by startPopmelt({ detached: true }) — survives Vite/Astro restarts.
 */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createPopmelt } from './bridge-server';

const port = parseInt(process.env.POPMELT_PORT || '1111', 10);
const projectRoot = process.env.POPMELT_PROJECT_ROOT || process.cwd();
const devOrigin = process.env.POPMELT_DEV_ORIGIN || undefined;

const lockDir = join(projectRoot, '.popmelt');
const lockFile = join(lockDir, 'bridge.lock');

async function writeLock(bridgePort: number) {
  await mkdir(lockDir, { recursive: true });
  await writeFile(lockFile, JSON.stringify({ pid: process.pid, port: bridgePort, startedAt: Date.now() }) + '\n');
}

async function removeLock() {
  try { await unlink(lockFile); } catch {}
}

async function main() {
  const handle = await createPopmelt({ port, projectRoot, devOrigin });

  await writeLock(handle.port);

  // Keep alive until signal
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      await handle.close();
      await removeLock();
      resolve();
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  });
}

main().catch((err) => {
  console.error('[popmelt bridge-entry] Fatal:', err);
  removeLock().finally(() => process.exit(1));
});
