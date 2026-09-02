// The version of the persona / skills / memory programming THIS process runs —
// see scripts/sys-version.mjs for what is hashed and why. electron-vite inlines
// the computed value as __STEM_SYS_VERSION__ (the `define` in
// electron.vite.config.ts) for both `dev` and `build`; under vitest nothing
// defines it and every hash reads 'unbuilt', which is a true statement about a
// test process and keeps the stamp's shape identical.
import type { SystemVersion } from '../shared/types';

declare const __STEM_SYS_VERSION__: SystemVersion | undefined;

const UNBUILT: SystemVersion = { persona: 'unbuilt', skills: 'unbuilt', memory: 'unbuilt' };

export function systemVersion(): SystemVersion {
  const inlined = typeof __STEM_SYS_VERSION__ === 'object' ? __STEM_SYS_VERSION__ : undefined;
  return inlined ? { ...inlined } : { ...UNBUILT };
}
