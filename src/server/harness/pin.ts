import type { PersonaHarnessPin } from '../../shared/types';

// The persona-pin clamp for coding_agent inside mail deliveries. A persona's
// harness pin is not a default there but the boundary: the pinned agent and
// device are used verbatim (whatever the tool call named), and a requested cwd
// is honored only inside the pinned folder. Interactive chats never pass
// through here — the clamp exists because a mail persona is an autonomous
// caller, and "any consenting device, any folder" was the hole it closed.

export type ClampedCwd = { ok: true; cwd?: string } | { ok: false; error: string };

/**
 * Resolve the cwd a mail persona's coding_agent call may use under its pin.
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
