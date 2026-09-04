import type { PersonaHarnessPin } from '../../shared/types';

// The persona-pin clamp for coding_agent. A persona's harness pin is not a
// default but the boundary: the pinned agent and device are used verbatim, and
// a requested cwd is honored only inside the pinned folder. Every turn kind
// passes through here since 2026-09-04 (mail deliveries did from the start; a
// mail persona is an autonomous caller, and "any consenting device, any
// folder" was the hole the clamp closed) — a chat run as a code persona is
// bounded the same way, and a chat run as no code persona has no tool at all.

export type ClampedCwd = { ok: true; cwd?: string } | { ok: false; error: string };

/**
 * Resolve the cwd a code persona's coding_agent call may use under its pin.
 * String-based on purpose: the pinned folder can live on a paired computer
 * whose path shapes (windows drives, backslashes) this process must not
 * normalize through its own path module.
 */
export function clampPinnedCwd(requested: string | undefined, pin: PersonaHarnessPin): ClampedCwd {
  const pinned = pin.cwd.trim().replace(/[\\/]+$/, '');
  const asked = (requested ?? '').trim();
  if (!pinned) {
    // A pin saved before its folder was decided. Locally that means the thread
    // scratch dir; on a device there is no folder to run in at all — and the
    // model must not be the one to pick it.
    if (pin.device?.trim()) {
      return {
        ok: false,
        error:
          "This persona's coding setup names a computer but no folder. Ask the user to set the working " +
          'folder in the persona editor (Manage → Personas); do not retry with a cwd of your own.'
      };
    }
    return { ok: true };
  }
  if (!asked) return { ok: true, cwd: pinned };
  // Windows pins keep windows separators; everything else is POSIX.
  const sep = pinned.includes('\\') ? '\\' : '/';
  const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(asked);
  const full = (absolute ? asked : `${pinned}${sep}${asked.replace(/^\.[\\/]/, '')}`).replace(/[\\/]+$/, '');
  const escapes =
    /(^|[\\/])\.\.([\\/]|$)/.test(full) ||
    (full !== pinned && !full.startsWith(`${pinned}/`) && !full.startsWith(`${pinned}\\`));
  if (escapes) {
    return {
      ok: false,
      error:
        `This persona's coding work is pinned to "${pin.cwd}" — cwd must be that folder or a folder inside ` +
        'it. Leave cwd out to use the pinned folder itself.'
    };
  }
  return { ok: true, cwd: full };
}
