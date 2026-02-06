import { createBridgeServer } from './bridge-server';
import type { BridgeServerHandle, BridgeServerOptions } from './types';

export type { BridgeServerHandle, BridgeServerOptions };

export async function startBridgeServer(
  options?: BridgeServerOptions & { force?: boolean },
): Promise<BridgeServerHandle> {
  if (process.env.NODE_ENV === 'production' && !options?.force) {
    throw new Error(
      '[Bridge] Refusing to start in production. Pass { force: true } to override.',
    );
  }

  return createBridgeServer(options);
}
