import { execSync } from 'node:child_process';

// E2E drives the BUILT app under dist/ (electron.launch points at
// dist/main/index.js), so compile main + preload + renderer before the run.
// Skip the typecheck the `npm run build` script does — that's the lint/CI job;
// here we just need fresh bundles.
export default function globalSetup(): void {
  execSync('npx electron-vite build', { stdio: 'inherit' });
}
