// electron-builder afterPack hook: drop the onnxruntime-node binaries the
// packaged app can never load.
//
// onnxruntime-node ships one package covering every platform/arch it supports
// (~200MB of binaries) and electron-builder copies all of it. The loader only
// ever resolves bin/napi-v3/${process.platform}/${process.arch}, so everything
// else is dead weight in every artifact — 30-40MB per unreachable dir.
//
// This used to be done with per-platform `files` patterns in
// electron-builder.yml (`mac.files`, `linux.files`). That was a trap: a
// platform-specific `files` list holding only `!…` exclusions becomes its own
// copy matcher with `**/*` prepended, so the whole repository (src/, tests/,
// mobile/, docs/, …) rode along inside every artifact, and a local build died
// on the framework symlinks under mobile/ios/Pods. A hook sees the real build
// target (`electronPlatformName`, `arch`), so it is also correct for
// cross-builds, where the `${platform}` macro would name the host instead.
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import builderUtil from 'builder-util';

const { Arch } = builderUtil;

export default async function afterPack(context) {
  const platform = context.electronPlatformName; // darwin | linux | win32
  const arch = Arch[context.arch]; // x64 | arm64 | …
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const napi = path.join(resources, 'app', 'node_modules', 'onnxruntime-node', 'bin', 'napi-v3');

  let platforms;
  try {
    platforms = await readdir(napi);
  } catch {
    return; // onnxruntime-node not packaged — nothing to prune
  }

  const removed = [];
  for (const p of platforms) {
    const platformDir = path.join(napi, p);
    if (p !== platform) {
      await rm(platformDir, { recursive: true, force: true });
      removed.push(`${p}/*`);
      continue;
    }
    for (const a of await readdir(platformDir)) {
      if (a === arch) continue;
      await rm(path.join(platformDir, a), { recursive: true, force: true });
      removed.push(`${p}/${a}`);
    }
  }
  console.log(`  • pruned onnxruntime binaries  keep=${platform}/${arch} removed=${removed.join(',') || 'none'}`);
}
