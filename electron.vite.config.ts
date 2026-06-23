import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const mainAssets = [
  ['src/main/pi/stem-mcp-extension.mjs', 'dist/main/pi/stem-mcp-extension.mjs'],
  ['src/main/recall/mcp-server.mjs', 'dist/main/recall/mcp-server.mjs']
] as const;

function copyMainRuntimeAssets() {
  return {
    name: 'copy-main-runtime-assets',
    writeBundle(): void {
      for (const [src, dest] of mainAssets) {
        const to = join(rootDir, dest);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(rootDir, src), to);
      }
    }
  };
}

export default defineConfig({
  main: {
    plugins: [copyMainRuntimeAssets()],
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: 'src/main/index.ts'
      }
    }
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: 'src/preload/index.ts',
        // Sandboxed preloads must be CommonJS (no ESM import at runtime).
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    }
  }
});
