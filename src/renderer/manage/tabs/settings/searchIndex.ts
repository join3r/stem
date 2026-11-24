/**
 * The settings search: an index read from the rendered settings, the match,
 * and the jump to a row.
 *
 * The index is not written by hand. SettingsSearch renders a hidden copy of
 * all four sub-tabs with every group open (SearchHarvestContext), and
 * `collectEntries` reads the rows from that DOM: the label, the hint line, the
 * ⓘ text and where the row sits. A new row is in the search when it is on the
 * screen, and a row the current state hides (Speech model with dictation off)
 * is not offered.
 *
 * A row is known by its key: the sub-tab, the group heading above it, the
 * labels of the collapsible rows it sits in, and its own label. The jump
 * reads the same keys from the copy on the screen, opens each closed parent
 * in turn and scrolls to the row.
 */

export type SettingsSub = 'app' | 'features' | 'server' | 'models';

export interface SettingsEntry {
  key: string;
  sub: SettingsSub;
  /** The group heading above the row ('' when there is none). */
  group: string;
  /** Labels of the collapsible rows and groups the row sits in, outermost first. */
  chain: string[];
  label: string;
  hint: string;
  /** Text of the ⓘ explanations on the row. */
  info: string;
  /** Keys of the parents in `chain`, outermost first: what the jump opens. */
  parents: string[];
}

const SEP = '␟';

/**
 * One line of visible text: whitespace folded; ⓘ text, controls and badges
 * (a "Beta" pill beside a heading) left out.
 */
function textOf(el: Element | null, drop = ''): string {
  if (!el) return '';
  const copy = el.cloneNode(true) as Element;
  const skip = `[data-stip], button, select, input, textarea, [class*="pill"]${drop ? `, ${drop}` : ''}`;
  copy.querySelectorAll(skip).forEach((n) => n.remove());
  return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function stipOf(el: Element | null): string {
  if (!el) return '';
  return [...el.querySelectorAll('[data-stip]')]
    .map((n) => (n.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

/** The label, hint and ⓘ text of one row element, by the row idiom it uses. */
function readRow(el: Element): { label: string; hint: string; info: string } | null {
  if (el.classList.contains('grp-head')) return { label: textOf(el), hint: '', info: stipOf(el) };
  if (el.classList.contains('role-group-head')) {
    return { label: textOf(el.querySelector(':scope > strong')), hint: textOf(el.querySelector(':scope > em')), info: stipOf(el) };
  }
  if (el.classList.contains('set-sub')) return { label: textOf(el), hint: '', info: stipOf(el) };
  // .set-vrow: a ValueRow, or a DisclosureRow's button.
  const lab = el.querySelector(':scope > .vlab');
  if (!lab) return null;
  return { label: textOf(lab, 'em'), hint: textOf(lab.querySelector(':scope > em')), info: stipOf(lab) };
}

/** The header element of a collapsible body, and its label. */
function parentHeader(body: Element): Element | null {
  const head = body.previousElementSibling;
  if (!head) return null;
  if (body.classList.contains('set-vbody') && head.classList.contains('set-vrow')) return head;
  if (body.classList.contains('role-group-body') && head.classList.contains('role-group-head')) return head;
  return null;
}

const ROW_SELECTOR = '.grp-head, .set-vrow, .role-group-head, .set-block > .set-sub:first-child';

/**
 * Every searchable row under `root` (one sub-tab), in screen order. With
 * `elements`, it also fills a map from key to element, for the jump.
 */
export function collectEntries(
  root: Element,
  sub: SettingsSub,
  elements?: Map<string, Element>
): SettingsEntry[] {
  const out: SettingsEntry[] = [];
  const seen = new Map<string, number>();
  const keyOfEl = new Map<Element, string>();
  let group = '';
  for (const el of root.querySelectorAll(ROW_SELECTOR)) {
    const row = readRow(el);
    if (!row) continue;
    const isGroup = el.classList.contains('grp-head');
    if (isGroup) group = row.label;
    if (!row.label) continue;

    const chain: string[] = [];
    const parents: string[] = [];
    for (let n = el.parentElement; n && n !== root; n = n.parentElement) {
      if (!n.classList.contains('set-vbody') && !n.classList.contains('role-group-body')) continue;
      const head = parentHeader(n);
      const headRow = head && readRow(head);
      if (!head || !headRow?.label) continue;
      chain.unshift(headRow.label);
      parents.unshift(keyOfEl.get(head) ?? '');
    }

    const base = [sub, isGroup ? '#group' : group, ...chain, row.label].join(SEP);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    const key = `${base}${SEP}${n}`;
    keyOfEl.set(el, key);
    elements?.set(key, el);
    out.push({ key, sub, group: isGroup ? '' : group, chain, label: row.label, hint: row.hint, info: row.info, parents });
  }
  return out;
}

export interface SettingsHit {
  entry: SettingsEntry;
  /** 0: the label matches; 1: the label, hint and place match; 2: only with the ⓘ text. */
  tier: 0 | 1 | 2;
}

export function searchTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The entries every term of `query` matches, best first. A term matches as a
 * substring, anywhere in the text that tier looks at. In a tier, screen order
 * stays.
 */
export function matchEntries(
  entries: SettingsEntry[],
  query: string,
  subLabel: (sub: SettingsSub) => string
): SettingsHit[] {
  const terms = searchTerms(query);
  if (!terms.length) return [];
  const all = (text: string) => terms.every((t) => text.includes(t));
  const hits: SettingsHit[] = [];
  for (const entry of entries) {
    const label = entry.label.toLowerCase();
    const place = [label, entry.hint, subLabel(entry.sub), entry.group, ...entry.chain].join(' ').toLowerCase();
    const tier = all(label) ? 0 : all(place) ? 1 : all(`${place} ${entry.info.toLowerCase()}`) ? 2 : null;
    if (tier !== null) hits.push({ entry, tier });
  }
  return hits.sort((a, b) => a.tier - b.tier);
}

/** A short piece of `text` around the first term it holds, for a hit found only in the ⓘ text. */
export function snippet(text: string, terms: string[], width = 90): string {
  if (text.length <= width) return text;
  const lower = text.toLowerCase();
  const found = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0);
  const at = found.length ? Math.min(...found) : 0;
  const start = Math.max(0, Math.min(at - Math.floor(width / 3), text.length - width));
  return `${start > 0 ? '…' : ''}${text.slice(start, start + width).trim()}${start + width < text.length ? '…' : ''}`;
}

/**
 * Show `entry` in the copy of its sub-tab under `root`: open each closed
 * parent, then scroll to the row and flash it. The rows load on their own, so
 * this tries again each frame until the row is there or `timeoutMs` ends.
 * Returns a function that stops it.
 */
export function revealEntry(root: () => Element | null, entry: SettingsEntry, timeoutMs = 4000): () => void {
  const until = performance.now() + timeoutMs;
  const clicked = new Set<string>();
  let frame = 0;
  let stopped = false;

  const show = (el: Element) => {
    el.scrollIntoView({ block: 'center' });
    el.classList.remove('set-search-flash');
    // Restart the animation when the same row is picked twice.
    void (el as HTMLElement).offsetWidth;
    el.classList.add('set-search-flash');
    setTimeout(() => el.classList.remove('set-search-flash'), 1800);
  };

  const step = () => {
    if (stopped) return;
    const r = root();
    if (r) {
      const els = new Map<string, Element>();
      collectEntries(r, entry.sub, els);
      const target = els.get(entry.key);
      if (target) return show(target);
      // Open the deepest parent that is on the screen and still closed.
      for (let i = entry.parents.length - 1; i >= 0; i--) {
        const head = els.get(entry.parents[i]);
        if (!head) continue;
        if (head.getAttribute('aria-expanded') === 'false' && !clicked.has(entry.parents[i])) {
          clicked.add(entry.parents[i]);
          (head as HTMLElement).click();
        }
        break;
      }
      if (performance.now() > until) {
        // The row did not come: land on the nearest parent there is.
        const near = [...entry.parents].reverse().map((k) => els.get(k)).find(Boolean);
        if (near) show(near);
        return;
      }
    } else if (performance.now() > until) return;
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return () => {
    stopped = true;
    cancelAnimationFrame(frame);
  };
}
