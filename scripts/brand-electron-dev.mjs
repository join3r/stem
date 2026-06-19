// Brand the dev Electron bundle so the dock tooltip and macOS menu-bar title
// read "Stem" instead of "Electron". Those come from CFBundleName /
// CFBundleDisplayName in the running app bundle, which in dev is Electron's
// own node_modules/electron/dist/Electron.app — app.setName() can't override
// it. A packaged build sets these via its own Info.plist, so this only matters
// for `npm run dev`.
//
// Wired as `predev` so it runs before every dev launch and re-applies after an
// `npm install` recreates node_modules. Idempotent; a no-op off macOS or when
// the bundle is missing.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NAME = 'Stem';
const plist = fileURLToPath(
  new URL('../node_modules/electron/dist/Electron.app/Contents/Info.plist', import.meta.url)
);

if (process.platform !== 'darwin' || !existsSync(plist)) process.exit(0);

const pb = (cmd) => execFileSync('/usr/libexec/PlistBuddy', ['-c', cmd, plist], { stdio: 'pipe' });
const setOrAdd = (key, value) => {
  try {
    pb(`Set :${key} ${value}`);
  } catch {
    pb(`Add :${key} string ${value}`);
  }
};

setOrAdd('CFBundleName', NAME);
setOrAdd('CFBundleDisplayName', NAME);
console.log(`Branded dev Electron bundle as "${NAME}".`);
