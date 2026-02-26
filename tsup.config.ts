import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: 'esm',
    dts: true,
    banner: { js: '"use client";' },
    esbuildOptions(options) {
      options.jsx = 'automatic';
    },
    minify: true,
    external: ['react', 'react-dom', 'modern-screenshot', 'lucide-react'],
    outDir: 'dist',
    clean: true,
    tsconfig: 'tsconfig.build.json',
  },
  {
    entry: { server: 'src/server/index.ts' },
    format: 'esm',
    dts: true,
    minify: true,
    platform: 'node',
    outDir: 'dist',
    clean: false,
    tsconfig: 'tsconfig.build.json',
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: 'esm',
    dts: false,
    minify: true,
    platform: 'node',
    outDir: 'dist',
    clean: false,
    banner: { js: '#!/usr/bin/env node' },
    tsconfig: 'tsconfig.build.json',
  },
  // Canvas bundle (client, standalone — React externalized via importmap)
  {
    entry: { canvas: 'src/canvas/index.ts' },
    format: 'esm',
    dts: false,
    minify: true,
    esbuildOptions(options) {
      options.jsx = 'automatic';
    },
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    outDir: 'dist',
    clean: false,
    tsconfig: 'tsconfig.build.json',
  },
  // Next.js plugin (edge-compatible, next externalized)
  {
    entry: { 'plugin-next': 'src/plugins/next.ts' },
    format: 'esm',
    dts: false,
    minify: true,
    external: ['next', 'next/server'],
    outDir: 'dist',
    clean: false,
    tsconfig: 'tsconfig.build.json',
  },
  // Vite + Astro plugins (Node.js)
  {
    entry: {
      'plugin-vite': 'src/plugins/vite.ts',
      'plugin-astro': 'src/plugins/astro.ts',
    },
    format: 'esm',
    dts: true,
    minify: true,
    platform: 'node',
    outDir: 'dist',
    clean: false,
    tsconfig: 'tsconfig.build.json',
  },
]);
