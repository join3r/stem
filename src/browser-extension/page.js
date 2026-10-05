/* global document, window, Event, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, Element, getComputedStyle */

// Functions that run INSIDE the page, on one element, through
// Runtime.callFunctionOn (`this` is the element a ref resolved to). They are
// written as real functions so the linter reads them, then sent as source:
// nothing here may close over module scope.

/** What kind of field the element is — fill's dispatch table. */
export function describeElement() {
  const el = this;
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  const role = (el.getAttribute && el.getAttribute('role')) || '';
  const type = tag === 'input' ? String(el.type || 'text').toLowerCase() : '';
  return {
    tag,
    type,
    role,
    editable: !!el.isContentEditable,
    checked: tag === 'input' && (type === 'checkbox' || type === 'radio') ? !!el.checked : null,
    ariaChecked: el.getAttribute ? el.getAttribute('aria-checked') : null,
    multiple: !!el.multiple,
    disabled: !!el.disabled || (el.getAttribute && el.getAttribute('aria-disabled') === 'true'),
    readOnly: !!el.readOnly
  };
}

/** The field's current value as the page sees it (for reporting back). */
export function readValue() {
  const el = this;
  if (el instanceof HTMLSelectElement) return [...el.selectedOptions].map((o) => o.text.trim()).join(', ');
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked ? 'checked' : 'unchecked';
  if (el.getAttribute && el.getAttribute('aria-checked') !== null && !('value' in el)) return el.getAttribute('aria-checked') === 'true' ? 'checked' : 'unchecked';
  if (el.isContentEditable) return el.innerText;
  return 'value' in el ? String(el.value) : el.textContent;
}

/** Select everything in an input, textarea or contenteditable so typing replaces it. */
export function selectAllIn() {
  const el = this;
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      el.select();
    } catch {
      // Some input types (number, email in old engines) refuse select(): the
      // value setter path in fill covers them.
    }
    return true;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  return true;
}

/**
 * Set a value the way frameworks notice: through the prototype's setter (React
 * tracks the instance one), then input + change. For the input types typing
 * cannot fill (date, color, range…).
 */
export function setNativeValue(value) {
  const el = this;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return String(el.value);
}

/** Choose a <select> option by its text or value (case-insensitive; a unique partial text match is accepted). */
export function selectOption(wanted) {
  const el = this;
  const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  const w = norm(wanted);
  const options = [...el.options];
  let pick = options.find((o) => norm(o.text) === w || norm(o.value) === w || norm(o.label) === w);
  if (!pick) {
    const partial = options.filter((o) => norm(o.text).includes(w));
    if (partial.length === 1) pick = partial[0];
  }
  if (!pick) return { ok: false, options: options.slice(0, 40).map((o) => o.text.trim()), total: options.length };
  if (pick.disabled) return { ok: false, disabled: pick.text.trim() };
  if (el.multiple) pick.selected = true;
  else el.value = pick.value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, chosen: pick.text.trim() };
}

/**
 * The <input type=file> an upload ref means. Sites hide the real input behind
 * a styled button or drop zone, and hidden inputs are not in the accessibility
 * tree, so the ref is usually that button. Try, in order: the element itself,
 * the control its <label> points at, the nearest ancestor holding exactly one
 * file input, and finally the only file input on the page. Returns the input,
 * or a sentence when there is none or no way to tell which.
 */
export function findFileInput() {
  const isFile = (e) => e instanceof HTMLInputElement && e.type === 'file';
  const el = this;
  if (isFile(el)) return el;
  const label = el.closest ? el.closest('label') : null;
  if (label && isFile(label.control)) return label.control;
  if (el.tagName === 'LABEL' && isFile(el.control)) return el.control;
  for (let node = el; node && node instanceof Element; node = node.parentElement) {
    const found = node.querySelectorAll('input[type=file]');
    if (found.length === 1) return found[0];
    if (found.length > 1) break;
  }
  const all = [...document.querySelectorAll('input[type=file]')];
  if (all.length === 1) return all[0];
  const describe = (e) => {
    const bits = [e.id ? `#${e.id}` : '', e.name ? `name=${e.name}` : '', e.accept ? `accept=${e.accept}` : ''].filter(Boolean);
    return bits.length ? bits.join(' ') : 'unnamed';
  };
  if (!all.length) return 'The page has no file input near that element (or anywhere): click the upload button first, then try again.';
  return `That element isn't a file input and the page has ${all.length} (${all.map(describe).join('; ')}): use the ref of the button or drop zone right next to the one you mean.`;
}

export function fileSummary() {
  return [...(this.files || [])].map((f) => ({ name: f.name, size: f.size }));
}

export function isMultipleFileInput() {
  return !!this.multiple;
}

/** Whether a click at (x, y) lands on this element, or what covers it there. */
export function hitCheck(x, y) {
  if (this.ownerDocument !== document) return 'ok';
  const hit = document.elementFromPoint(x, y);
  if (!hit) return 'nothing';
  if (hit === this || this.contains(hit) || hit.contains(this)) return 'ok';
  const root = hit.getRootNode && hit.getRootNode();
  if (root && root.host && (root.host === this || this.contains(root.host))) return 'ok';
  const name = hit.tagName.toLowerCase();
  const id = hit.id ? `#${hit.id}` : '';
  const cls = typeof hit.className === 'string' && hit.className.trim() ? `.${hit.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
  const text = (hit.innerText || hit.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${name}${id}${cls}${text ? ` "${text}"` : ''}`;
}

/** The element's box in the viewport (CSS px), for scroll reports. */
export function viewportBox() {
  const r = this.getBoundingClientRect();
  return { top: Math.round(r.top), left: Math.round(r.left), height: Math.round(r.height), vh: window.innerHeight, vw: window.innerWidth };
}

/**
 * Scroll positions: the window's, and the nearest scrolling box under the
 * point (x, y) — apps like mail clients scroll an inner panel, not the page.
 */
export function scrollState(x, y) {
  const se = document.scrollingElement || document.documentElement;
  const out = {
    x: Math.round(window.scrollX),
    y: Math.round(window.scrollY),
    maxX: Math.max(0, se.scrollWidth - window.innerWidth),
    maxY: Math.max(0, se.scrollHeight - window.innerHeight),
    vw: window.innerWidth,
    vh: window.innerHeight,
    inner: null
  };
  let node = document.elementFromPoint(x, y);
  while (node && node !== document.body && node !== document.documentElement) {
    const s = getComputedStyle(node);
    const scrollsY = /(auto|scroll|overlay)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 1;
    const scrollsX = /(auto|scroll|overlay)/.test(s.overflowX) && node.scrollWidth > node.clientWidth + 1;
    if (scrollsY || scrollsX) {
      const cls = typeof node.className === 'string' && node.className.trim() ? `.${node.className.trim().split(/\s+/)[0]}` : '';
      out.inner = {
        desc: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : cls}`,
        top: Math.round(node.scrollTop),
        left: Math.round(node.scrollLeft),
        maxTop: node.scrollHeight - node.clientHeight,
        maxLeft: node.scrollWidth - node.clientWidth
      };
      break;
    }
    node = node.parentElement;
  }
  return out;
}

/** True when nothing in the page would receive typed text. */
export function nothingFocused() {
  const a = document.activeElement;
  return !a || a === document.body || a === document.documentElement;
}

/**
 * Scroll by (dx, dy) without the compositor: the nearest scrolling box under
 * (x, y), else the window. "instant", so a page's smooth-scroll CSS can't
 * leave it mid-animation in a tab that is not drawing.
 */
export function scrollByScript(x, y, dx, dy) {
  let node = document.elementFromPoint(x, y);
  while (node && node !== document.body && node !== document.documentElement) {
    const s = getComputedStyle(node);
    const canY = dy && /(auto|scroll|overlay)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 1;
    const canX = dx && /(auto|scroll|overlay)/.test(s.overflowX) && node.scrollWidth > node.clientWidth + 1;
    if (canY || canX) {
      node.scrollBy({ left: dx, top: dy, behavior: 'instant' });
      return true;
    }
    node = node.parentElement;
  }
  window.scrollBy({ left: dx, top: dy, behavior: 'instant' });
  return true;
}

/** Put the caret after the field's current content. */
export function caretToEnd() {
  const el = this;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      const n = el.value.length;
      el.setSelectionRange(n, n);
    } catch {
      // email/number inputs have no selection API: typing appends there anyway.
    }
    return true;
  }
  if (el.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return true;
}
