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
]);
