/* global URL */
import { clip } from './util.js';

// Accessibility.getFullAXTree → the compact outline the model reads, plus the
// ref → node map the acting actions resolve against.
//
// The outline is deliberately close to Playwright's aria snapshot ("- button
// "Save" [ref=e4]"), because that is the shape models have seen most. What it
// leaves out matters as much as what it keeps: Chrome's tree is mostly unnamed
// generic containers, label wrappers and inline text boxes, and a page like an
// inbox becomes tens of thousands of lines if they are all printed. So unnamed
// containers are flattened into their parent, runs of text are merged into one
// line, and text that only repeats a name already printed (a button's label, a
// field's label sitting next to it) is dropped.
//
// Pure: no `chrome`, no CDP. actions.js fetches the nodes and hands them in.

/** Roles a person acts on. They always get a ref, named or not. */
const INTERACTIVE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
  'DisclosureTriangle'
]);

/** Structure worth a line of its own even without a name. */
const STRUCTURE = new Set([
  'heading',
  'paragraph',
  'list',
  'listitem',
  'table',
  'grid',
  'treegrid',
  'row',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'dialog',
  'alertdialog',
  'alert',
  'status',
  'article',
  'tablist',
  'tabpanel',
  'menu',
  'menubar',
  'toolbar',
  'tree',
  'banner',
  'navigation',
  'main',
  'contentinfo',
  'complementary',
  'search',
  'form',
  'Iframe',
  'progressbar',
  'meter',
  'blockquote'
]);

/** Kept only when named: an unnamed one adds nothing its children don't say. */
const STRUCTURE_IF_NAMED = new Set(['region', 'group', 'radiogroup', 'figure', 'image', 'img', 'note', 'log', 'timer']);

/** Never printed, never walked. */
const SKIP = new Set(['InlineTextBox', 'ListMarker', 'scrollbar']);

/** Flattened without a word break: text inside them continues the sentence. */
const INLINE = new Set([
  'strong',
  'emphasis',
  'mark',
  'code',
  'time',
  'Abbr',
  'abbr',
  'subscript',
  'superscript',
  'insertion',
  'deletion',
  'Ruby',
  'RubyAnnotation',
  'LabelText',
  'none'
]);

const VALUE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'progressbar', 'meter']);
const DISPLAY = { Iframe: 'iframe', image: 'img', DisclosureTriangle: 'button', RootWebArea: 'document' };

const prop = (node, name) => {
  const p = (node.properties || []).find((x) => x.name === name);
  return p && p.value ? p.value.value : undefined;
};
const roleOf = (node) => (node.role && node.role.value) || '';
const nameOf = (node) => clean((node.name && node.name.value) || '');
const clean = (s) => String(s).replace(/\s+/g, ' ').trim();

function shortUrl(href, pageUrl) {
  if (!href || /^javascript:/i.test(href)) return '';
  try {
    const u = new URL(href);
    const p = pageUrl ? new URL(pageUrl) : null;
    if (p && u.origin === p.origin) {
      if (u.pathname === p.pathname && u.search === p.search && u.hash) return u.hash;
      return `${u.pathname}${u.search}${u.hash}`;
    }
  } catch {
    // Not a URL we can shorten: print it as Chrome gave it.
  }
  return href;
}

function attrsOf(node, role) {
  const out = [];
  if (role === 'heading') {
    const level = prop(node, 'level');
    if (level) out.push(`level=${level}`);
  }
  const checked = prop(node, 'checked');
  if (checked === 'true' || checked === true) out.push('checked');
  else if (checked === 'mixed') out.push('checked=mixed');
  if (prop(node, 'selected') === true) out.push('selected');
  const pressed = prop(node, 'pressed');
  if (pressed === 'true' || pressed === true) out.push('pressed');
  else if (pressed === 'mixed') out.push('pressed=mixed');
  const expanded = prop(node, 'expanded');
  if (expanded === true) out.push('expanded');
  else if (expanded === false && role !== 'combobox') out.push('collapsed');
  if (prop(node, 'disabled') === true) out.push('disabled');
  if (prop(node, 'required') === true) out.push('required');
  if (prop(node, 'readonly') === true && VALUE_ROLES.has(role)) out.push('readonly');
  if (prop(node, 'invalid') === 'true') out.push('invalid');
  if (prop(node, 'focused') === true) out.push('focused');
  return out.map((a) => ` [${a}]`).join('');
}

/**
 * Build the outline.
 *
 * @param {Array<object>} nodes  getFullAXTree().nodes for the main frame.
 * @param {object} [opts]
 * @param {Array<{ownerBackendNodeId: number, nodes: Array<object>}>} [opts.frames]
 *   Same-process child frames, spliced in under their <iframe>.
 * @param {string} [opts.pageUrl]  For printing same-origin links as paths.
 * @param {number} [opts.maxChars]  Outline budget; past it the rest is cut.
 * @returns {{ text: string, refs: Map<string, {backendNodeId: number, role: string, name: string}>, truncated: boolean, iframes: {total: number, missing: number} }}
 */
export function buildOutline(nodes, opts = {}) {
  const { frames = [], pageUrl = '', maxChars = 40_000 } = opts;
  const byId = new Map();
  const index = (list, prefix) => {
    for (const n of list || []) byId.set(prefix + n.nodeId, { ...n, _p: prefix });
  };
  index(nodes, 'm:');
  const frameRoots = new Map();
  frames.forEach((f, i) => {
    const prefix = `f${i}:`;
    index(f.nodes, prefix);
    const root = (f.nodes || []).find((n) => !n.parentId) || (f.nodes || [])[0];
    if (root) frameRoots.set(f.ownerBackendNodeId, prefix + root.nodeId);
  });
  const kids = (node) => (node.childIds || []).map((id) => byId.get(node._p + id)).filter(Boolean);

  const refs = new Map();
  const lines = [];
  let used = 0;
  let truncated = false;
  const iframes = { total: 0, missing: 0 };

  function keep(node, role, ctx) {
    if (INTERACTIVE.has(role)) return true;
    if (STRUCTURE.has(role)) return true;
    if (STRUCTURE_IF_NAMED.has(role)) return !!nameOf(node);
    // A focusable generic is somebody's custom control (div tabindex=0 with a
    // click handler): the model needs a ref for it. Not inside an editor,
    // where every wrapper is "focusable" along with the field.
    return prop(node, 'focusable') === true && !ctx.inEditable && role !== 'RootWebArea';
  }

  // Children → a flat list of { text } and { node } items, unnamed wrappers dissolved.
  function collect(node, ctx) {
    const items = [];
    for (const c of kids(node)) {
      const role = roleOf(c);
      if (SKIP.has(role)) continue;
      if (c.ignored) {
        items.push(...collect(c, ctx));
        continue;
      }
      if (role === 'StaticText') {
        items.push({ text: (c.name && c.name.value) || '' });
        continue;
      }
      if (role === 'LineBreak') {
        items.push({ brk: true });
        continue;
      }
      if (keep(c, role, ctx)) {
        items.push({ node: c, role });
        continue;
      }
      const inner = collect(c, ctx);
      if (INLINE.has(role)) items.push(...inner);
      else items.push({ brk: true }, ...inner, { brk: true });
    }
    return items;
  }

  // Adjacent text merges into one run; a dissolved block adds a space between runs.
  function merge(items) {
    const out = [];
    let buf = null;
    const flush = () => {
      if (buf !== null) {
        const s = clean(buf);
        if (s) out.push({ text: s });
      }
      buf = null;
    };
    for (const it of items) {
      if (it.node) {
        flush();
        out.push(it);
      } else if (it.brk) {
        if (buf !== null) buf += ' ';
      } else buf = (buf ?? '') + it.text;
    }
    flush();
    return out;
  }

  function dedupe(items, ownName, value) {
    return items.filter((it, i) => {
      if (!it.text) return true;
      if (it.text === ownName || (value && it.text === value)) return false;
      const near = [items[i - 1], items[i + 1]].filter((x) => x && x.node);
      return !near.some((x) => nameOf(x.node) === it.text || nameOf(x.node) === clean(it.text.replace(/[:*]\s*$/, '')));
    });
  }

  function emit(depth, line) {
    if (truncated) return false;
    const s = `${'  '.repeat(depth)}${line}`;
    if (used + s.length + 1 > maxChars) {
      truncated = true;
      return false;
    }
    lines.push(s);
    used += s.length + 1;
    return true;
  }

  function nextRef(node, role, name) {
    if (node.backendDOMNodeId === undefined) return '';
    const ref = `e${refs.size + 1}`;
    refs.set(ref, { backendNodeId: node.backendDOMNodeId, role: DISPLAY[role] || role, name });
    return ` [ref=${ref}]`;
  }

  const textOnly = (items) => items.every((it) => it.text);

  // A row of plain cells reads better as one line: "Tea | 3".
  function compactRow(node, ctx) {
    const cells = merge(collect(node, ctx));
    if (!cells.length || !cells.every((c) => c.node && /^(cell|gridcell|columnheader|rowheader)$/.test(c.role))) return null;
    const parts = [];
    for (const c of cells) {
      const inner = dedupe(merge(collect(c.node, ctx)), nameOf(c.node), '');
      if (!textOnly(inner) || prop(c.node, 'focusable') === true) return null;
      parts.push(nameOf(c.node) || inner.map((x) => x.text).join(' '));
    }
    return parts.join(' | ');
  }

  function render(node, role, depth, ctx) {
    if (truncated) return;
    const name = nameOf(node);
    const childCtx = {
      ...ctx,
      inEditable: ctx.inEditable || !!prop(node, 'editable'),
      inSelect: ctx.inSelect || role === 'combobox' || role === 'MenuListPopup'
    };

    if (role === 'Iframe') {
      iframes.total++;
      const rootKey = frameRoots.get(node.backendDOMNodeId);
      const root = rootKey && byId.get(rootKey);
      if (!root) {
        iframes.missing++;
        emit(depth, `- iframe${name ? ` ${JSON.stringify(clip(name, 200))}` : ''} (contents not included)`);
        return;
      }
      if (!emit(depth, `- iframe${name ? ` ${JSON.stringify(clip(name, 200))}` : ''}:`)) return;
      renderItems(dedupe(merge(collect(root, childCtx)), nameOf(root), ''), depth + 1, childCtx);
      return;
    }

    if (role === 'row') {
      const row = compactRow(node, childCtx);
      if (row !== null) {
        emit(depth, `- row${attrsOf(node, role)}: ${clip(row, 2000)}`);
        return;
      }
    }

    const interactive = INTERACTIVE.has(role) || prop(node, 'focusable') === true;
    const rawValue = VALUE_ROLES.has(role) && node.value ? clean(node.value.value ?? '') : '';
    const value = rawValue && rawValue !== name ? rawValue : '';
    const items = dedupe(merge(collect(node, childCtx)), name, rawValue);
    // An unnamed, empty, inert container says nothing: leave it out.
    if (!interactive && !name && !value && !items.length) return;

    // Native <select> options can't be clicked (the menu is the browser's own
    // UI) — `fill` picks them by text — so they are listed without refs.
    const wantsRef = (interactive && !(role === 'option' && ctx.inSelect)) || (role === 'heading' || ((role === 'image' || role === 'img') && name));
    const display = DISPLAY[role] || role;
    let head = `- ${display}${name ? ` ${JSON.stringify(clip(name, 200))}` : ''}${attrsOf(node, role)}`;
    const ref = wantsRef ? nextRef(node, role, name) : '';
    head += ref;
    // A line cut by the budget must not leave its ref behind: the model never saw it.
    const unref = () => {
      if (ref) refs.delete(`e${refs.size}`);
    };
    if (role === 'link') {
      const url = shortUrl(prop(node, 'url'), pageUrl);
      if (url) head += ` → ${clip(url, 200)}`;
    }
    if (value) head += `: ${clip(value, 300)}`;
    else if (items.length === 1 && items[0].text) {
      if (!emit(depth, `${head}: ${clip(items[0].text, 2000)}`)) unref();
      return;
    }
    if (!emit(depth, head)) {
      unref();
      return;
    }
    renderItems(items, depth + 1, childCtx);
  }

  function renderItems(items, depth, ctx) {
    let options = 0;
    let hiddenOptions = 0;
    for (const it of items) {
      if (truncated) return;
      if (it.text) {
        emit(depth, `- text: ${clip(it.text, 2000)}`);
        continue;
      }
      if (it.role === 'option' && ctx.inSelect && ++options > 30) {
        hiddenOptions++;
        continue;
      }
      render(it.node, it.role, depth, ctx);
    }
    if (hiddenOptions) emit(depth, `- … ${hiddenOptions} more options`);
  }

  const root = (nodes || []).find((n) => !n.parentId) || (nodes || [])[0];
  if (root) {
    const r = byId.get(`m:${root.nodeId}`);
    renderItems(dedupe(merge(collect(r, { inEditable: false, inSelect: false })), nameOf(r), ''), 0, { inEditable: false, inSelect: false });
  }
  return { text: lines.join('\n'), refs, truncated, iframes };
}
