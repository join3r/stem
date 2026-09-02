// Types for the system-version hasher, so electron.vite.config.ts (typechecked
// with the app) imports a typed module. The hasher itself stays plain .mjs: it
// runs under bare `node` too (`node scripts/sys-version.mjs`).
import type { SystemVersion } from '../src/shared/types';

/** Source paths (relative to the repo root) hashed into each subsystem's version. */
export declare const SUBSYSTEMS: Record<keyof Omit<SystemVersion, 'build'>, string[]>;

/** sha256 over the listed files/directories, cut to 12 hex. */
export declare function hashPaths(rootDir: string, paths: string[]): string;

/** The git commit (`-dirty` when modified), STEM_GIT_SHA, or undefined without git. */
export declare function gitBuild(rootDir: string): string | undefined;

export declare function computeSystemVersion(rootDir: string): SystemVersion;
