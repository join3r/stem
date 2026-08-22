// Renders assets/*.svg to the PNGs app.json points at. Run from mobile/:
//
//   node scripts/render-icons.mjs
//
// sharp is borrowed from the desktop's node_modules rather than added as a
// dependency here: this runs once per icon change, never on the phone.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sharp = require('../../node_modules/sharp');

const jobs = [
  // The App Store rejects icons with an alpha channel, so the tile is opaque.
  { src: 'assets/icon.svg', out: 'assets/icon.png', alpha: false },
  { src: 'assets/adaptive-icon-fg.svg', out: 'assets/adaptive-icon-fg.png', alpha: true },
  { src: 'assets/adaptive-icon-bg.svg', out: 'assets/adaptive-icon-bg.png', alpha: false }
];

for (const { src, out, alpha } of jobs) {
  let image = sharp(src, { density: 72 }).resize(1024, 1024);
  if (!alpha) image = image.removeAlpha();
  await image.png().toFile(out);
  console.log(`${src} → ${out}`);
}
