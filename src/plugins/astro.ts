import { request as httpRequest } from 'node:http';

type PopmeltPluginOptions = {
  port?: number;
  projectRoot?: string;
  basePath?: string;
  bridge?: boolean;
};

type AstroIntegration = {
  name: string;
  hooks: Record<string, (options: any) => void | Promise<void>>;
};

export function popmelt(options?: PopmeltPluginOptions): AstroIntegration {
  const basePath = options?.basePath ?? '/popmelt';
  const autoBridge = options?.bridge !== false;

  let bridgePort: number | null = null;
  let bridgeClose: (() => Promise<void>) | null = null;

  return {
    name: 'popmelt',
    hooks: {
      async 'astro:server:setup'({ server }: { server: any }) {
        // Skip auto-start if user is running `popmelt wrap -- astro dev`
        if (!autoBridge || process.env.POPMELT_BRIDGE_URL) {
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

            // Resolve devOrigin from Astro's underlying Vite config
            const resolvedConfig = server.config;
            const host = resolvedConfig?.server?.host === true ? '0.0.0.0' : (resolvedConfig?.server?.host || 'localhost');
            const astroPort = resolvedConfig?.server?.port ?? 4321;
            const devOrigin = `http://${host === '0.0.0.0' ? 'localhost' : host}:${astroPort}`;

            const handle = await startPopmelt({
              port: options?.port,
              projectRoot: options?.projectRoot,
              devOrigin,
              force: true,
            });

            bridgePort = handle.port;
            bridgeClose = handle.close;

            console.log(`[popmelt] bridge ready at http://localhost:${bridgePort}`);

            // Clean shutdown when Astro's underlying Vite server closes
            server.httpServer?.on('close', () => {
              if (bridgeClose) {
                bridgeClose().catch(() => {});
                bridgeClose = null;
              }
            });
          } catch (err) {
            console.warn('[popmelt] bridge failed to start:', (err as Error).message ?? err);
          }
        }

        // Inject bridge URL into HTML responses
        server.middlewares.use((req: any, res: any, next: any) => {
          const url: string = req.url || '';

          // Proxy /popmelt/* to bridge
          if (url.startsWith(basePath)) {
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
            return;
          }

          // Inject bridge URL script into HTML pages
          if (bridgePort !== null && (req.headers.accept?.includes('text/html') || url === '/' || url.endsWith('.html'))) {
            const originalWrite = res.write;
            const originalEnd = res.end;
            let body = '';

            res.write = function (chunk: any, ...args: any[]) {
              body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
              return true;
            };

            res.end = function (chunk: any, ...args: any[]) {
              if (chunk) body += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
              const script = `<script type="text/javascript">window.__POPMELT_BRIDGE_URL__="http://localhost:${bridgePort}";</script>`;
              body = body.replace('<head>', `<head>${script}`);
              // Update content-length if it was set
              if (res.getHeader('content-length')) {
                res.setHeader('content-length', Buffer.byteLength(body));
              }
              originalWrite.call(res, body, 'utf8');
              originalEnd.call(res);
            };
          }

          next();
        });
      },
    },
  };
}
