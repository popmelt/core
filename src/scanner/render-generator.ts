import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import type { ComponentManifest } from './types';
import { renderSlug } from './render-slug';

type RenderTarget = {
  key: string;
  slug: string;
  filePath: string;
  exportName: string;
  exportType: 'named' | 'default';
};

// ── Import validation ────────────────────────────────────────────────
// Prevents Turbopack from discovering broken imports, which would
// cascade a global build error to every page in the dev server.

type PathAliases = { root: string; entries: [pattern: string, targets: string[]][] };

const STRIP_COMMENTS = /\/\/.*$|\/\*[\s\S]*?\*\//gm;

async function loadPathAliases(projectRoot: string): Promise<PathAliases> {
  const empty: PathAliases = { root: projectRoot, entries: [] };

  try {
    const raw = await readFile(join(projectRoot, 'tsconfig.json'), 'utf-8');
    const config = JSON.parse(raw.replace(STRIP_COMMENTS, ''));

    let paths = config.compilerOptions?.paths as Record<string, string[]> | undefined;
    let baseUrl = config.compilerOptions?.baseUrl ?? '.';

    // Follow one level of extends
    if (!paths && config.extends) {
      try {
        const extPath = join(projectRoot, config.extends);
        const extRaw = await readFile(extPath, 'utf-8');
        const extConfig = JSON.parse(extRaw.replace(STRIP_COMMENTS, ''));
        paths = extConfig.compilerOptions?.paths;
        baseUrl = extConfig.compilerOptions?.baseUrl ?? baseUrl;
      } catch {}
    }

    if (!paths) return empty;

    return {
      root: join(projectRoot, baseUrl),
      entries: Object.entries(paths),
    };
  } catch {
    return empty;
  }
}

function resolveAlias(importPath: string, aliases: PathAliases): string | null {
  for (const [pattern, targets] of aliases.entries) {
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1); // '@/' from '@/*'
      if (importPath.startsWith(prefix)) {
        const rest = importPath.slice(prefix.length);
        const target = targets[0]!;
        const targetBase = target.endsWith('/*') ? target.slice(0, -1) : target;
        return join(aliases.root, targetBase, rest);
      }
    } else if (pattern === importPath && targets.length > 0) {
      return join(aliases.root, targets[0]!);
    }
  }
  return null;
}

const RESOLVE_EXTS = ['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts'];

async function canResolve(absPath: string): Promise<boolean> {
  for (const ext of ['', ...RESOLVE_EXTS]) {
    try {
      const s = await stat(absPath + ext);
      if (s.isFile()) return true;
    } catch {}
  }
  return false;
}

/**
 * Quick check that a component file's direct `from "..."` imports resolve.
 * Catches the most common failure: an aliased import (e.g. `@/components/ui/carousel`)
 * pointing at a file that was deleted or never existed.
 */
async function hasResolvableImports(
  filePath: string,
  projectRoot: string,
  aliases: PathAliases,
): Promise<boolean> {
  try {
    const fullPath = join(projectRoot, filePath);
    const source = await readFile(fullPath, 'utf-8');

    const checks: Promise<boolean>[] = [];
    const fromPattern = /from\s+['"]([^'"]+)['"]/g;
    let match;

    while ((match = fromPattern.exec(source)) !== null) {
      const imp = match[1]!;

      if (imp.startsWith('.')) {
        // Relative import
        checks.push(canResolve(resolve(dirname(fullPath), imp)));
      } else {
        // Try as path alias — if it doesn't match any alias it's a
        // package import (react, next/dynamic, etc.) which we assume is fine.
        const resolved = resolveAlias(imp, aliases);
        if (resolved) {
          checks.push(canResolve(resolved));
        }
      }
    }

    const results = await Promise.all(checks);
    return results.every(Boolean);
  } catch {
    return false;
  }
}

// ── Target extraction ────────────────────────────────────────────────

/**
 * Builds render targets for all scanned components whose direct imports resolve.
 * Components with broken imports are excluded to prevent Turbopack's global
 * error cascade.
 */
async function extractRenderTargets(
  manifest: ComponentManifest,
  projectRoot: string,
): Promise<RenderTarget[]> {
  const aliases = await loadPathAliases(projectRoot);

  const validated = await Promise.all(
    manifest.components.map(async (entry): Promise<RenderTarget | null> => {
      const ok = await hasResolvableImports(entry.filePath, projectRoot, aliases);
      if (!ok) {
        console.warn(`[Popmelt] Skipping ${entry.filePath}::${entry.name} — unresolvable imports`);
        return null;
      }
      return {
        key: `${entry.filePath}::${entry.name}`,
        slug: renderSlug(entry.filePath, entry.name),
        filePath: entry.filePath,
        exportName: entry.name,
        exportType: entry.exportType,
      };
    }),
  );

  return validated.filter((t): t is RenderTarget => t !== null);
}

// ── Generation ───────────────────────────────────────────────────────

// Bump when templates change to force regeneration
const TEMPLATE_VERSION = 12;

/**
 * SHA-256 hash of template version + sorted keys (16 chars).
 */
function hashTargets(targets: RenderTarget[]): string {
  const sorted = targets.map(t => t.key).sort().join('\n');
  return createHash('sha256').update(TEMPLATE_VERSION + '\n' + sorted).digest('hex').slice(0, 16);
}

/**
 * Locates the Next.js App Router directory. Checks `app/` then `src/app/`.
 */
async function findAppDir(projectRoot: string): Promise<string | null> {
  for (const candidate of ['app', 'src/app']) {
    const dir = join(projectRoot, candidate);
    try {
      const s = await stat(dir);
      if (s.isDirectory()) return dir;
    } catch {}
  }
  return null;
}

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

/**
 * Generates a per-component page.tsx.
 *
 * Each component gets its own route at `/popmelt/render/{slug}`.
 * Uses `next/dynamic` with `ssr: false` so:
 *   - Server-side `redirect()` calls are skipped (no SSR = no server redirect)
 *   - Client-side navigation is caught by the layout's history patches
 *   - Turbopack has an explicit client boundary per component
 *   - If one component has incompatible deps, only that route fails
 */
function buildComponentPage(target: RenderTarget, pageDir: string, projectRoot: string): string {
  const absComponent = join(projectRoot, target.filePath.replace(/\.(tsx?|jsx?)$/, ''));
  const importPath = JSON.stringify(toPosix(relative(pageDir, absComponent)));

  if (target.exportType === 'default') {
    return `'use client';\nimport dynamic from 'next/dynamic';\nexport default dynamic(() => import(${importPath}), { ssr: false });\n`;
  }
  return `'use client';\nimport dynamic from 'next/dynamic';\nexport default dynamic(\n  () => import(${importPath}).then(mod => ({ default: mod.${target.exportName} })),\n  { ssr: false },\n);\n`;
}

const LAYOUT_SOURCE = `// Auto-generated by Popmelt scanner — do not edit
'use client';

import { useEffect, type ReactNode } from 'react';

export default function PopmeltRenderLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    const origPush = history.pushState.bind(history);
    const origReplace = history.replaceState.bind(history);

    history.pushState = function (...args: Parameters<typeof history.pushState>) {
      const url = args[2];
      if (url && String(url).indexOf('/popmelt/render') !== 0) {
        console.warn('[Popmelt] Blocked navigation to:', url);
        return;
      }
      return origPush(...args);
    };

    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
      const url = args[2];
      if (url && String(url).indexOf('/popmelt/render') !== 0) {
        console.warn('[Popmelt] Blocked navigation to:', url);
        return;
      }
      return origReplace(...args);
    };

    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as Element).closest?.('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (href && !href.startsWith('/popmelt/render') && !href.startsWith('#')) {
        e.preventDefault();
        e.stopPropagation();
        console.warn('[Popmelt] Blocked link navigation to:', href);
      }
    };

    document.addEventListener('click', handleClick, true);

    return () => {
      history.pushState = origPush;
      history.replaceState = origReplace;
      document.removeEventListener('click', handleClick, true);
    };
  }, []);

  return children;
}
`;

const ERROR_SOURCE = `// Auto-generated by Popmelt scanner — do not edit
'use client';

export default function PopmeltRenderError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ padding: 40, fontFamily: 'system-ui' }}>
      <h2 style={{ color: '#ef4444', fontSize: 16, fontWeight: 600, margin: 0 }}>
        Component render error
      </h2>
      <pre style={{
        marginTop: 12,
        padding: 12,
        background: '#fef2f2',
        border: '1px solid #fecaca',
        fontSize: 12,
        color: '#991b1b',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {error.message}
      </pre>
      <button
        onClick={reset}
        style={{
          marginTop: 12,
          padding: '6px 16px',
          fontSize: 12,
          background: '#1f2937',
          color: '#fff',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        Retry
      </button>
    </div>
  );
}
`;

/**
 * Generates render files for scanned components.
 *
 * Architecture — each component gets its own isolated Next.js route:
 *   app/popmelt/render/
 *     layout.tsx              — navigation-blocking shell + "ok" postMessage
 *     error.tsx               — shared error boundary for all component routes
 *     {slug}/page.tsx         — 'use client' dynamic import of one component
 *
 * Components with unresolvable direct imports are excluded to prevent
 * Turbopack's global error cascade.
 */
export async function generateRenderFiles(
  manifest: ComponentManifest,
  projectRoot: string,
  lastHash?: string,
): Promise<string> {
  const targets = await extractRenderTargets(manifest, projectRoot);

  if (targets.length === 0) {
    return lastHash ?? '';
  }

  const hash = hashTargets(targets);
  if (hash === lastHash) return hash;

  const appDir = await findAppDir(projectRoot);
  if (!appDir) return lastHash ?? '';

  const renderDir = join(appDir, 'popmelt', 'render');

  // Wipe and regenerate so stale pages (from now-excluded components) are removed
  await rm(renderDir, { recursive: true, force: true });
  await mkdir(renderDir, { recursive: true });

  const writes: Promise<void>[] = [
    writeFile(join(renderDir, 'layout.tsx'), LAYOUT_SOURCE),
    writeFile(join(renderDir, 'error.tsx'), ERROR_SOURCE),
  ];

  for (const target of targets) {
    const pageDir = join(renderDir, target.slug);
    writes.push(
      mkdir(pageDir, { recursive: true }).then(() =>
        writeFile(join(pageDir, 'page.tsx'), buildComponentPage(target, pageDir, projectRoot))
      ),
    );
  }

  await Promise.all(writes);

  return hash;
}
