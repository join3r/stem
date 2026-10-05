import { execFile } from 'node:child_process';

// Arc hands extensions only the tabs it has loaded since it started: a
// sidebar tab nobody has clicked since then is not a browser tab at all, not
// even a sleeping one, so `chrome.tabs` never sees it (found 2026-10-06: 2 of
// 101 tabs listed). Arc's AppleScript dictionary does see every sidebar tab,
// so for Arc the tab list is completed from there. Reading only: Stem never
// selects a sidebar tab, which would switch the user's view.

export interface ArcSidebarTab {
  space: string;
  /** "pinned" or "unpinned" (Arc's names); favourites are "topApp". */
  location: string;
  title: string;
  url: string;
}

const RS = '\u001e';
const US = '\u001f';

// One Apple event per property per Space: ~0.2 s for 100 tabs, where a
// per-tab loop takes ~3 s.
const SCRIPT = `
set RS to ASCII character 30
set US to ASCII character 31
set out to {}
tell application "Arc"
  repeat with w in windows
    repeat with s in spaces of w
      set sn to title of s
      set us_ to URL of every tab of s
      set ts to title of every tab of s
      set ls to location of every tab of s
      repeat with i from 1 to count of us_
        set end of out to sn & US & ((item i of ls) as text) & US & (item i of ts) & US & (item i of us_)
      end repeat
    end repeat
  end repeat
end tell
set AppleScript's text item delimiters to RS
return out as text
`;

export function parseArcTabs(stdout: string): ArcSidebarTab[] {
  const seen = new Set<string>();
  const tabs: ArcSidebarTab[] = [];
  for (const record of stdout.replace(/\n$/, '').split(RS)) {
    const [space, location, title, url] = record.split(US);
    if (!url) continue;
    // Every window lists the same Spaces; a tab counts once.
    const key = `${space}${US}${location}${US}${url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    tabs.push({ space: space ?? '', location: location ?? '', title: title ?? '', url });
  }
  return tabs;
}

/** Arc's sidebar tabs, or an error sentence (Automation permission refused, Arc not running). */
export function readArcSidebar(): Promise<{ tabs: ArcSidebarTab[] } | { error: string }> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', SCRIPT], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const why = String(stderr || error.message).trim();
        resolve({
          error: /-1743|not authori[sz]ed/i.test(why)
            ? 'macOS did not let Stem read Arc’s sidebar (System Settings → Privacy & Security → Automation → Stem → Arc).'
            : `Arc’s sidebar could not be read: ${why.slice(0, 200)}`
        });
        return;
      }
      resolve({ tabs: parseArcTabs(String(stdout)) });
    });
  });
}

const LOCATION: Record<string, string> = { topApp: 'favourite', pinned: 'pinned', unpinned: 'today' };

/**
 * The lines added to Arc's tab list: the sidebar tabs the extension could not
 * list (`loadedUrls` are the ones it did), by Space, and how to work in one.
 */
export function arcSidebarText(tabs: ArcSidebarTab[], loadedUrls: readonly string[]): string {
  const loaded = new Set(loadedUrls);
  const rest = tabs.filter((t) => !loaded.has(t.url) && /^https?:/i.test(t.url));
  if (!rest.length) return '';
  const lines = [
    `Arc also has ${rest.length} sidebar tab${rest.length === 1 ? '' : 's'} it has not loaded since it started. ` +
      'They have no id yet: to work in one, `open` its URL (a new background tab); never ask the user to click it.'
  ];
  const bySpace = new Map<string, ArcSidebarTab[]>();
  for (const t of rest) bySpace.set(t.space, [...(bySpace.get(t.space) ?? []), t]);
  for (const [space, list] of bySpace) {
    lines.push(`Space “${space || 'untitled'}”:`);
    for (const t of list) {
      const title = t.title.length > 120 ? `${t.title.slice(0, 119)}…` : t.title;
      const url = t.url.length > 300 ? `${t.url.slice(0, 299)}…` : t.url;
      lines.push(`- ${title || '(untitled)'} — ${url} (${LOCATION[t.location] ?? t.location})`);
    }
  }
  return lines.join('\n');
}
