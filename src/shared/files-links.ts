// A reply can link two kinds of files Stem holds on the server:
// - `[report](files/cfk/report.html)`: a file in the user's Files place, the same
//   spelling the model reads in its workspace files list (server/files/inject.ts);
// - `[report](scratch/report.html)`: a file in this chat's scratch folder, where
//   the model puts its own work (the user does not want it in Files).
// Both live on the server, so a click fetches the file to this computer and shows
// it there (desktop files:open / scratch:open). Before this, such a link rendered
// as plain text: on 2026-11-09 a reply's bold "open the explainer" link did nothing.

/** A relative path with no way out: no `..`, no hidden part, no empty segment, not a folder. */
export function isSafeRel(rel: string): boolean {
  if (!rel) return false;
  return !rel.split('/').some((p) => p === '' || p === '.' || p === '..' || p.startsWith('.') || p.includes('\\'));
}

/** The decoded path after `prefix/` in a link, when it is a safe one. */
function relAfter(prefix: string, href: string | undefined): string | undefined {
  const m = new RegExp(`^${prefix}\\/([^?#]+)$`).exec((href ?? '').trim());
  if (!m) return undefined;
  let rel: string;
  try {
    rel = decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
  return isSafeRel(rel) ? rel : undefined;
}

/** The Files-relative path a `files/…` link names, or undefined if it names none. */
export function filesPlaceRel(href: string | undefined): string | undefined {
  return relAfter('files', href);
}

/** The scratch-relative path a `scratch/…` link names, or undefined if it names none. */
export function scratchRel(href: string | undefined): string | undefined {
  return relAfter('scratch', href);
}

/** What GET /files/ takes for a file in a chat's scratch folder (server/exec/scratch.ts scratchDownload). */
export const SCRATCH_PREFIX = 'stem-scratch:';
