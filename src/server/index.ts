import { createPopmelt } from './bridge-server';
import type { PopmeltHandle, PopmeltOptions } from './types';

export type { PopmeltHandle, PopmeltOptions };

export async function startPopmelt(
  options?: PopmeltOptions & { force?: boolean },
): Promise<PopmeltHandle> {
  if (process.env.NODE_ENV === 'production' && !options?.force) {
    throw new Error(
      '[Bridge] Refusing to start in production. Pass { force: true } to override.',
    );
  }

  return createPopmelt(options);
}
