// Builds native/mac/stem-computer (the Swift helper behind the computer-control
// persona) into build/native/stem-computer as a universal binary.
//
// Two entry points: electron-builder's `beforePack` hook (default export — runs
// only when packing for macOS, so a Linux build never needs swiftc), and a plain
// `node scripts/build-mac-helper.mjs` for a dev build. The desktop app also
// calls buildHelper() on demand in development (src/desktop/computer-host/helper.ts)
// so a fresh checkout works without remembering this step.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SOURCE_DIR = resolve(here, '..', 'native', 'mac', 'stem-computer');
export const OUTPUT = resolve(here, '..', 'build', 'native', 'stem-computer');

// AppKit for the running-apps list, ScreenCaptureKit for per-window capture (the macOS 14 floor),
// Carbon for the keyboard layout `type` takes key codes from.
const FRAMEWORKS = ['CoreGraphics', 'ImageIO', 'ApplicationServices', 'Foundation', 'AppKit', 'ScreenCaptureKit', 'Carbon'];

export function sourceFiles() {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith('.swift'))
    .sort()
    .map((f) => join(SOURCE_DIR, f));
}

/** A hash of the sources, so a dev build can tell whether its binary is current. */
export function sourceHash() {
  const h = createHash('sha256');
  for (const file of sourceFiles()) h.update(readFileSync(file));
  return h.digest('hex').slice(0, 16);
}

function swiftc(args) {
  execFileSync('xcrun', ['swiftc', ...args], { stdio: 'inherit' });
}

/**
 * Compile for the given archs and lipo them together at `output`. Throws when
 * swiftc is missing — the caller decides whether that is fatal (a release
 * build) or a degraded dev session.
 */
export function buildHelper({ output = OUTPUT, archs = ['arm64', 'x86_64'], log = console.log } = {}) {
  const files = sourceFiles();
  mkdirSync(dirname(output), { recursive: true });
  const slices = [];
  for (const arch of archs) {
    const slice = `${output}-${arch}`;
    log(`[stem-computer] swiftc ${arch} → ${slice}`);
    swiftc([
      '-O',
      '-target',
      `${arch}-apple-macos14`,
      ...FRAMEWORKS.flatMap((f) => ['-framework', f]),
      '-o',
      slice,
      ...files
    ]);
    slices.push(slice);
  }
  // Never overwrite in place: the kernel caches a Mach-O's code signature by
  // vnode, and a binary rewritten under it is SIGKILLed as "Code Signature
  // Invalid" on its next launch. Unlink, then write, then ad-hoc sign the result.
  rmSync(output, { force: true });
  if (slices.length === 1) {
    execFileSync('cp', [slices[0], output]);
  } else {
    execFileSync('lipo', ['-create', ...slices, '-output', output], { stdio: 'inherit' });
  }
  execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' });
  log(`[stem-computer] built ${output} (${statSync(output).size} bytes)`);
  return output;
}

/** electron-builder beforePack hook. */
export default async function beforePack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  buildHelper();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // CLI: `--host-arch` builds only this machine's slice (a dev build);
  // `--output <path>` puts the binary elsewhere than build/native.
  const args = process.argv.slice(2);
  const at = args.indexOf('--output');
  buildHelper({
    ...(at >= 0 && args[at + 1] ? { output: resolve(args[at + 1]) } : {}),
    ...(args.includes('--host-arch') ? { archs: [process.arch === 'arm64' ? 'arm64' : 'x86_64'] } : {})
  });
}
