import { screen } from 'electron';
import { HelperProcess, resolveHelperPath } from '../computer-host/helper';
import { log } from '../../server/log';
import type { QuickChatWindow } from '../../shared/types';

// "Ask about this window": the helper calls behind the second Quick Chat
// shortcut (native/mac/stem-computer/WindowPeek.swift, and its Windows twin
// native/windows/stem-computer/Peek.cs, and on GNOME native/linux/stem-computer).
// One helper process of its own,
// started on first use and kept, so a press costs a capture and not a process
// launch; it never selects a window or touches a computer-control run.

/** Where a helper can see other apps' windows. */
export const windowPeekSupported = process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux';

/** The window as the panel needs it, plus the frame the panel docks against. */
export interface PeekedWindow {
  window: QuickChatWindow;
  bounds: Rect;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How much of a window's text goes before the model. */
const MAX_TEXT_CHARS = 20_000;

let helper: HelperProcess | null = null;
let starting: Promise<HelperProcess> | null = null;

async function ensureHelper(): Promise<HelperProcess> {
  if (helper?.alive) return helper;
  if (!starting) {
    starting = resolveHelperPath()
      .then((binary) => (helper = new HelperProcess(binary)))
      .finally(() => (starting = null));
  }
  return starting;
}

/** Start the helper ahead of the first press, so that press costs a capture only. */
export function warmWindowPeek(): void {
  if (!windowPeekSupported) return;
  ensureHelper().catch((error) => log('quickchat', 'window peek could not start the helper', { error: String(error) }));
}

/**
 * A rectangle as the helper sent it, in the units Electron places windows in:
 * the Mac helper speaks points already; the Windows one, which is DPI aware,
 * speaks physical pixels, and Electron's are device-independent.
 */
function asRect(value: unknown): Rect | null {
  const r = value as Partial<Rect> | null | undefined;
  if (!r || [r.x, r.y, r.width, r.height].some((n) => typeof n !== 'number')) return null;
  const rect = { x: r.x!, y: r.y!, width: r.width!, height: r.height! };
  return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
}

/**
 * The window the person was in when they pressed the shortcut, with one
 * picture of it. Null when there is no such window (or this is not a Mac);
 * a missing permission comes back as `missing` with whatever could be read.
 * With `windowId`, that window instead (the panel's New takes a fresh
 * picture of the window it is docked beside); null once it has closed.
 */
export async function peekFrontWindow(windowId?: number): Promise<PeekedWindow | null> {
  if (!windowPeekSupported) return null;
  let reply;
  try {
    reply = await (await ensureHelper()).call('peek-window', windowId === undefined ? {} : { windowId }, 10_000);
  } catch (error) {
    log('quickchat', 'window peek could not start the helper', { error: String(error) });
    return null;
  }
  const raw = reply as unknown as {
    ok: boolean;
    error?: string;
    window?: { windowId: number; app: string; bundleId: string | null; title: string; bounds: unknown } | null;
    access?: { screen?: boolean; accessibility?: boolean };
    screenshot?: { jpegBase64: string };
  };
  if (!raw.ok || !raw.window) {
    if (!raw.ok) log('quickchat', 'window peek failed', { error: raw.error });
    return null;
  }
  const bounds = asRect(raw.window.bounds);
  if (!bounds) return null;
  const missing: QuickChatWindow['missing'] = [];
  if (raw.access?.screen === false) missing.push('screen');
  if (raw.access?.accessibility === false) missing.push('accessibility');
  return {
    bounds,
    window: {
      windowId: raw.window.windowId,
      app: raw.window.app,
      bundleId: raw.window.bundleId ?? null,
      title: raw.window.title,
      imageBase64: raw.screenshot?.jpegBase64 ?? null,
      missing
    }
  };
}

/** The window's readable text, or null when its app shows none (or Accessibility is off). */
export async function readWindowText(windowId: number): Promise<string | null> {
  try {
    const reply = (await (await ensureHelper()).call('peek-text', { windowId, maxChars: MAX_TEXT_CHARS }, 15_000)) as {
      ok: boolean;
      text?: string | null;
    };
    return reply.ok && typeof reply.text === 'string' && reply.text.trim() ? reply.text : null;
  } catch (error) {
    log('quickchat', 'reading the window text failed', { error: String(error) });
    return null;
  }
}

/**
 * Where the window is now and whether it is on screen (false while minimised,
 * its app hidden, or on another Space; helpers that cannot tell say nothing and
 * count as on screen). Null once it has closed — or, on helpers that report
 * minimised windows as gone, while minimised.
 */
export async function windowState(windowId: number): Promise<{ bounds: Rect; onScreen: boolean } | null> {
  if (!helper?.alive) return null;
  const reply = (await helper.call('window-bounds', { windowId }, 2_000)) as unknown as { ok: boolean; bounds?: unknown; onScreen?: unknown };
  const bounds = reply.ok ? asRect(reply.bounds) : null;
  return bounds ? { bounds, onScreen: reply.onScreen !== false } : null;
}

export function stopWindowPeek(): void {
  helper?.kill();
  helper = null;
}
