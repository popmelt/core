import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import type { ComponentEntry, ComponentManifest } from './types';

const EXCLUDE_DIRS = new Set(['node_modules', '.next', 'dist', '__popmelt', '.git', '.turbo']);
const EXCLUDE_PATTERNS = [/\.test\.tsx?$/, /\.spec\.tsx?$/, /\.stories\.tsx?$/];

const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]+$/;

// Patterns that match React component exports
const EXPORT_PATTERNS: Array<{ regex: RegExp; type: 'named' | 'default' }> = [
  { regex: /export\s+function\s+([A-Z][a-zA-Z0-9]+)/g, type: 'named' },
  { regex: /export\s+default\s+function\s+([A-Z][a-zA-Z0-9]+)/g, type: 'default' },
  { regex: /export\s+const\s+([A-Z][a-zA-Z0-9]+)\s*[=:]/g, type: 'named' },
  { regex: /export\s+default\s+([A-Z][a-zA-Z0-9]+)\s*;/g, type: 'default' },
];

async function collectTsxFiles(dir: string, root: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      const sub = await collectTsxFiles(join(dir, entry.name), root);
      results.push(...sub);
    } else if (entry.isFile() && entry.name.endsWith('.tsx')) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(root, fullPath);
      if (EXCLUDE_PATTERNS.some(p => p.test(relPath))) continue;
      results.push(fullPath);
    }
  }

  return results;
}

function extractComponents(content: string, filePath: string, root: string): ComponentEntry[] {
  const relPath = relative(root, filePath);
  const components: ComponentEntry[] = [];
  const seen = new Set<string>();

  for (const { regex, type } of EXPORT_PATTERNS) {
    // Reset regex lastIndex
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]!;
      if (seen.has(name)) continue;
      if (!PASCAL_CASE.test(name)) continue;
      seen.add(name);

      // Derive category from directory path
      let category: string | undefined;
      const dirRel = dirname(relPath);
      if (dirRel !== '.') {
        category = dirRel
          .replace(/^app\//, '')
          .replace(/^src\//, '');
      }

      components.push({ name, filePath: relPath, exportType: type, category });
    }
  }

  return components;
}

type RouteMapping = Map<string, string[]>; // component name -> routes

async function buildRouteMap(root: string): Promise<RouteMapping> {
  const map: RouteMapping = new Map();

  // Find all page.tsx files under app/
  const appDir = join(root, 'app');
  let pageFiles: string[];
  try {
    await stat(appDir);
    pageFiles = await collectPageFiles(appDir, root);
  } catch {
    return map; // No app/ directory
  }

  for (const pageFile of pageFiles) {
    const content = await readFile(pageFile, 'utf-8');
    const relDir = dirname(relative(root, pageFile));

    // Derive route from file path: strip 'app', remove route groups (...), remove page.tsx
    const route = '/' + relDir
      .replace(/^app\/?/, '')
      .replace(/\([^)]+\)\/?/g, '') // strip route groups
      .replace(/\/$/, '');

    // Find imports in this page file
    const importRegex = /import\s+.*?from\s+['"](\.\.?\/[^'"]+)['"]/g;
    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1]!;
      const importBasename = basename(importPath).replace(/\.(tsx?|jsx?)$/, '');
      // Also check for PascalCase names in the import statement
      const importNames = match[0].match(/\b([A-Z][a-zA-Z0-9]+)\b/g) || [];
      for (const name of importNames) {
        if (!PASCAL_CASE.test(name)) continue;
        const routes = map.get(name) ?? [];
        if (!routes.includes(route)) routes.push(route);
        map.set(name, routes);
      }
      // Also map the file basename if PascalCase
      if (PASCAL_CASE.test(importBasename)) {
        const routes = map.get(importBasename) ?? [];
        if (!routes.includes(route)) routes.push(route);
        map.set(importBasename, routes);
      }
    }
  }

  return map;
}

async function collectPageFiles(dir: string, root: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      results.push(...await collectPageFiles(join(dir, entry.name), root));
    } else if (entry.isFile() && entry.name === 'page.tsx') {
      results.push(join(dir, entry.name));
    }
  }

  return results;
}

export async function scanForComponents(projectRoot: string): Promise<ComponentManifest> {
  const tsxFiles = await collectTsxFiles(projectRoot, projectRoot);
  const routeMap = await buildRouteMap(projectRoot);

  const components: ComponentEntry[] = [];

  for (const file of tsxFiles) {
    const content = await readFile(file, 'utf-8');
    const entries = extractComponents(content, file, projectRoot);

    for (const entry of entries) {
      // Attach routes if known
      const routes = routeMap.get(entry.name);
      if (routes && routes.length > 0) {
        entry.routes = routes;
      }
      components.push(entry);
    }
  }

  // Sort by name for stable output
  components.sort((a, b) => a.name.localeCompare(b.name));

  return {
    version: 1,
    scannedAt: Date.now(),
    components,
  };
}
