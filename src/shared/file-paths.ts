// File paths in a reply become file:// links, so a click opens the file on
// this computer and a right-click offers "Show in Finder". The model is asked
// to write real links (server/workspace/bootstrap.ts), but coding agents and
// tool output name files as plain paths, mostly in backticks, so those are
// picked up here too. The main process decides what a click may actually do
// (desktop/open-link.ts): documents open, everything else is only revealed.
//
// Detection is narrow, like phone-links.ts: an absolute path under a place
// user files live (~/…, /Users/…, /home/…, /Volumes/…, /tmp/…, a drive
// letter), never a relative path or a URL path like /api/v1. A `~` path is
// sent as file:///~/… and expanded to the home folder by the main process,
// which is the only side that knows it.

const ROOT = String.raw`(?:~[/\\]|\/(?:Users|home|Volumes|tmp|private|mnt|media|opt|var|srv|root|Applications|Library)\/|[A-Za-z]:\\)`;

/** A whole inline-code value that is a path, optionally with a :line[:col] suffix. */
const WHOLE_RE = new RegExp(String.raw`^${ROOT}[^\n<>"|*?]*$`);
/** A path inside prose: no spaces, stops before trailing punctuation. */
const PROSE_RE = new RegExp(String.raw`(?<![\w/\\.~:-])${ROOT}[^\s<>"'|*?()\[\]{}\`]*`, 'g');
const LINE_SUFFIX_RE = /:\d+(?::\d+)?$/;
const TRAILING_PUNCT_RE = /[.,;:!?]+$/;

/** The file:// URL for an absolute or ~ path, or undefined if it is not one. */
export function filePathHref(raw: string): string | undefined {
  const text = raw.trim();
  if (!WHOLE_RE.test(text)) return undefined;
  const path = text.replace(LINE_SUFFIX_RE, '');
  if (/^~[/\\]/.test(path)) return `file:///~/${encodePath(path.slice(2))}`;
  if (/^[A-Za-z]:\\/.test(path)) return `file:///${path.slice(0, 2)}/${encodePath(path.slice(3))}`;
  return `file:///${encodePath(path.slice(1))}`;
}

function encodePath(rest: string): string {
  return rest
    .split(/[/\\]/)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export interface FilePathMatch {
  start: number;
  end: number;
  href: string;
}

/** Paths written in running text. */
export function findFilePaths(text: string): FilePathMatch[] {
  const out: FilePathMatch[] = [];
  for (const m of text.matchAll(PROSE_RE)) {
    const value = m[0].replace(TRAILING_PUNCT_RE, '');
    // A bare root ("/tmp/", "~/") names no file worth a link.
    if (value.replace(/[/\\]+$/, '').split(/[/\\]/).filter(Boolean).length < 2) continue;
    const href = filePathHref(value);
    if (href) out.push({ start: m.index, end: m.index + value.length, href });
  }
  return out;
}
