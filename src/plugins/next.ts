import { type NextRequest, NextResponse } from 'next/server';

const DEFAULT_PORT = parseInt(process.env.POPMELT_BRIDGE_PORT || '1111', 10);

/**
 * Popmelt middleware handler for Next.js.
 * Call at the top of your middleware function to proxy /popmelt to the canvas.
 *
 * Returns a Response if the request was handled, or null if it should continue
 * to your normal middleware logic.
 *
 * @example
 * ```ts
 * import { popmeltMiddleware } from '@popmelt.com/core/next';
 *
 * export async function middleware(request: NextRequest) {
 *   const popmeltResponse = popmeltMiddleware(request);
 *   if (popmeltResponse) return popmeltResponse;
 *
 *   // ... your normal middleware logic
 * }
 * ```
 */
export function popmeltMiddleware(
  request: NextRequest,
  options?: { port?: number; basePath?: string },
): NextResponse | null {
  const basePath = options?.basePath ?? '/popmelt';
  const port = options?.port ?? DEFAULT_PORT;

  // Canvas preview bypass — skip all host middleware (auth, CSRF, onboarding).
  // Sets x-popmelt-canvas header so server components (AdminGuard, requireUser)
  // can also bypass page-level auth checks.
  if (request.nextUrl.searchParams.get('popmelt') === 'canvas') {
    if (process.env.NODE_ENV === 'production') return null;
    const headers = new Headers(request.headers);
    headers.set('x-popmelt-canvas', '1');
    return NextResponse.next({ request: { headers } });
  }

  // Blank renderer — served by Next.js, not bridge
  if (request.nextUrl.pathname.startsWith(basePath + '/render')) {
    if (process.env.NODE_ENV === 'production') return null;
    const headers = new Headers(request.headers);
    headers.set('x-popmelt-canvas', '1');
    return NextResponse.next({ request: { headers } });
  }

  if (request.nextUrl.pathname === basePath || request.nextUrl.pathname.startsWith(basePath + '/')) {
    const bridgePath = '/canvas' + request.nextUrl.pathname.slice(basePath.length);
    return NextResponse.rewrite(
      new URL(bridgePath || '/canvas', `http://localhost:${port}`),
    );
  }

  return null;
}

// Keep withPopmelt as a convenience for apps without custom middleware
type NextConfig = {
  rewrites?: () => Promise<any> | any;
  [key: string]: any;
};

export function withPopmelt(config: NextConfig, options?: { port?: number }): NextConfig {
  if (process.env.NODE_ENV === 'production') return config;

  const port = options?.port ?? DEFAULT_PORT;
  const bridgeOrigin = `http://localhost:${port}`;
  const existingRewrites = config.rewrites;

  return {
    ...config,
    async rewrites() {
      const existing = existingRewrites ? await existingRewrites() : [];

      const popmeltRewrites = [
        { source: '/popmelt', destination: `${bridgeOrigin}/canvas` },
        { source: '/popmelt/:path*', destination: `${bridgeOrigin}/canvas/:path*` },
      ];

      if (Array.isArray(existing)) {
        return {
          beforeFiles: popmeltRewrites,
          afterFiles: existing,
          fallback: [],
        };
      }
      return {
        ...existing,
        beforeFiles: [...(existing.beforeFiles || []), ...popmeltRewrites],
      };
    },
  };
}
