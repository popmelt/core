import { request as httpRequest } from 'node:http';

type AstroIntegration = {
  name: string;
  hooks: Record<string, (options: any) => void>;
};

export function popmelt(options?: { port?: number; basePath?: string }): AstroIntegration {
  const port = options?.port ?? parseInt(process.env.POPMELT_BRIDGE_PORT || '1111', 10);
  const basePath = options?.basePath ?? '/popmelt';
  const bridgeOrigin = `http://localhost:${port}`;

  return {
    name: 'popmelt-canvas',
    hooks: {
      'astro:server:setup'({ server }: { server: any }) {
        server.middlewares.use((req: any, res: any, next: any) => {
          const url: string = req.url || '';
          if (!url.startsWith(basePath)) return next();

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
            res.end(`Popmelt bridge not running on port ${port}`);
          });

          req.pipe(proxyReq);
        });
      },
    },
  };
}
