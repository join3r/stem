import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const mainAssets = [
  ['src/server/pi/stem-mcp-extension.mjs', 'dist/main/pi/stem-mcp-extension.mjs'],
  ['src/server/pi/pi-node-shim.mjs', 'dist/main/pi/pi-node-shim.mjs']
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
        // index is the Electron main process: src/desktop, which starts the
        // headless server (src/server) in-process and imports the rest of it.
        // embed-worker is a second entry: it runs in its own utilityProcess
        // (utilityProcess.fork(dist/main/embed-worker.js) in embed-worker-host.ts).
        // recall-mcp-server is a third: a standalone stdio MCP server spawned with
        // ELECTRON_RUN_AS_NODE (see pi/mcp-config.ts); bundling it lets it share
        // src/server/recall/search-core.ts with the main process.
        // scan-worker is a fourth: the recall cosine-scan + VACUUM utilityProcess
        // (see scan-worker-host.ts), sharing search-core/maintenance-core.
        // server is a fifth: `stem-server`, the headless entry, which plain
        // `node dist/main/server.js` runs. Rollup gives the two roots one shared
        // chunk for everything under src/server and leaves index.js holding the
        // Electron imports alone — which is precisely the property the boot
        // tripwire (scripts/server-boot.mjs) checks is still true.
        input: {
          index: 'src/desktop/index.ts',
          server: 'src/server/main.ts',
          'embed-worker': 'src/server/recall/embed-worker.ts',
          'recall-mcp-server': 'src/server/recall/mcp-server-main.ts',
          'scan-worker': 'src/server/recall/scan-worker.ts'
        },
        // transformers.js must stay external: it lazily loads onnxruntime-node's
        // native .node binary, which cannot live inside a rollup bundle. Resolved
        // from node_modules at runtime instead.
        // pi-coding-agent must stay external too: pure-ESM, exports-map-only, and
        // its dist/cli.js is spawned as a real file (plus AuthStorage relies on
        // package-relative resolution). Loaded lazily via dynamic import.
        // pdfjs-dist stays external as well: its legacy build probes optional
        // canvas packages via dynamic import, which rollup would try to resolve.
        // word-extractor stays external too: pure-JS CJS resolved from the
        // shipped node_modules (asar is off) and loaded lazily on the first
        // .doc/.docx (folder-index/word.ts) — bundling its CJS tree buys
        // nothing but interop risk.
        // electron-updater stays external for the plain reason: it ships in the
        // pruned node_modules anyway (asar is off), it is only loaded on the one
        // platform that uses it (desktop/updates.ts imports it lazily, AppImage
        // only), and bundling a CJS tree that reads its own package metadata
        // buys nothing but risk.
        external: [
          '@huggingface/transformers',
          '@earendil-works/pi-coding-agent',
          /^pdfjs-dist/,
          'word-extractor',
          'electron-updater'
        ],
        // Multi-input builds default to hashed names; package.json main expects
        // dist/main/index.js, so pin entry names.
        //
        // Shared chunks are pinned FLAT into dist/main rather than rollup's
        // default chunks/ subdirectory, and that is load-bearing. Several modules
        // in the main bundle locate a sibling build artifact relative to
        // `import.meta.url` — the embed and scan workers, recall-mcp-server.js,
        // pi-node-shim.mjs, stem-mcp-extension.mjs. With one entry those modules
        // were always inside dist/main/index.js and the sibling join was exact.
        // The moment a second entry (src/server/main.ts) shares them, rollup
        // hoists them into a chunk, and from dist/main/chunks/ every one of those
        // joins resolves one directory too deep — at runtime, on a path no test
        // reaches, with an ERR_MODULE_NOT_FOUND that names a file nobody wrote.
        // Keeping chunks flat keeps "a main-bundle module's siblings live in
        // dist/main" true regardless of how rollup splits the graph.
        output: { entryFileNames: '[name].js', chunkFileNames: '[name]-[hash].js' }
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
        // One HTML entry, serving all three desktop windows — the URL flag picks
        // main / Quick Chat / HUD. There was a second (mobile.html, the phone's
        // web client, served over the transport); both it and the static route
        // that served it are gone.
        input: {
          index: 'src/renderer/index.html'
        }
      }
    }
  }
});
