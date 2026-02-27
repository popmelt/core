import { request as httpRequest } from 'node:http';

type PopmeltPluginOptions = {
  port?: number;
  projectRoot?: string;
  basePath?: string;
  bridge?: boolean;
};

type Plugin = {
  name: string;
  configureServer: (server: any) => Promise<void>;
  transformIndexHtml: () => { tag: string; attrs: Record<string, string>; children: string; injectTo: string } | undefined;
};

export function popmelt(options?: PopmeltPluginOptions): Plugin {
  const basePath = options?.basePath ?? '/popmelt';
  const autoBridge = options?.bridge !== false;

  let bridgePort: number | null = null;
  let bridgeClose: (() => Promise<void>) | null = null;

  return {
    name: 'popmelt',

    async configureServer(server: any) {
      // Skip auto-start if user is running `popmelt wrap -- vite`
      if (!autoBridge || process.env.POPMELT_BRIDGE_URL) {
        // If wrap mode, extract port from env for proxy/inject
        if (process.env.POPMELT_BRIDGE_URL) {
          try {
            bridgePort = new URL(process.env.POPMELT_BRIDGE_URL).port
              ? parseInt(new URL(process.env.POPMELT_BRIDGE_URL).port, 10)
              : null;
          } catch {}
        }
      } else {
        try {
          const { startPopmelt } = await import('../server/index');

          // Resolve devOrigin from Vite's config
          const resolvedConfig = server.config;
          const host = resolvedConfig?.server?.host === true ? '0.0.0.0' : (resolvedConfig?.server?.host || 'localhost');
          const vitePort = resolvedConfig?.server?.port ?? 5173;
          const devOrigin = `http://${host === '0.0.0.0' ? 'localhost' : host}:${vitePort}`;

          const handle = await startPopmelt({
            port: options?.port,
            projectRoot: options?.projectRoot,
            devOrigin,
            force: true, // We know we're in dev — skip NODE_ENV check
          });

          bridgePort = handle.port;
          bridgeClose = handle.close;

          console.log(`[popmelt] bridge ready at http://localhost:${bridgePort}`);

          // Clean shutdown when Vite server closes
          server.httpServer?.on('close', () => {
            if (bridgeClose) {
              bridgeClose().catch(() => {});
              bridgeClose = null;
            }
          });
        } catch (err) {
          // Don't break the dev server if bridge fails to start
          console.warn('[popmelt] bridge failed to start:', (err as Error).message ?? err);
        }
      }

      // Proxy /popmelt/* to bridge
      server.middlewares.use((req: any, res: any, next: any) => {
        const url: string = req.url || '';
        if (!url.startsWith(basePath)) return next();
        if (bridgePort === null) return next();

        const bridgeOrigin = `http://localhost:${bridgePort}`;
        const targetPath = '/canvas' + url.slice(basePath.length);
        const targetUrl = new URL(targetPath, bridgeOrigin);

        const proxyReq = httpRequest(
          targetUrl,
          { method: req.method, headers: { ...req.headers, host: targetUrl.host } },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );

        proxyReq.on('error', () => {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Popmelt bridge not running on port ${bridgePort}`);
        });

        req.pipe(proxyReq);
      });
    },

    transformIndexHtml() {
      if (bridgePort === null) return undefined;
      return {
        tag: 'script',
        attrs: { type: 'text/javascript' },
        children: `window.__POPMELT_BRIDGE_URL__="http://localhost:${bridgePort}";`,
        injectTo: 'head-prepend',
      };
    },
  };
}
