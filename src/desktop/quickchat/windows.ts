import { BrowserWindow, screen } from 'electron';
import { placeOwnWindow } from '../computer-host/helper';
import { isWaylandSession, overlayOuterBounds, overlayWindowOptions, timeLocaleArguments, workspaceVisibilityOptions } from '../platform';
import { loadRenderer, PRELOAD_SCRIPT } from '../renderer-assets';

// The two windows Quick Chat owns, and where on screen they go. Construction
// only: nothing here knows about sessions, ownership or turns — that is
// ./index.ts, which creates these once at startup and thereafter only ever shows
// and hides them (so summoning is instant and never loses a draft mid-stream).

// The window IS the frosted card (native vibrancy + rounded corners + native
// shadow), so these are the card's own dimensions — no extra room reserved for a
// CSS shadow as before.
const QUICK_CHAT_WIDTH = 596;
// Compact spotlight bar (fresh session) vs. expanded conversation panel (resuming
// a session with messages). The overlay window is resized between the two on show.
const QUICK_CHAT_HEIGHT = 108;
const QUICK_CHAT_PANEL_HEIGHT = 518;

// Bottom-left status HUD pill.
const HUD_WIDTH = 320;
const HUD_HEIGHT = 46;
/** The pill's window title: how Stem's GNOME extension finds it to place it on Wayland. */
const HUD_TITLE = 'Stem status';

/**
 * The Quick Chat overlay (Spotlight-style): a frameless, always-on-top,
 * transparent panel loading the same renderer with a `?quickchat` flag.
 */
export function createOverlayWindow(deps: {
  installNavigationGuards(win: BrowserWindow): void;
  /** The "show on all Spaces" preference, applied once here — see below. */
  visibleOnAllWorkspaces: boolean;
}): BrowserWindow {
  // On macOS the window IS the card (native shadow drawn outside); elsewhere the
  // window is grown by OVERLAY_SHADOW_INSET so the CSS shadow has room inside it.
  const outer = overlayOuterBounds({ x: 0, y: 0, width: QUICK_CHAT_WIDTH, height: QUICK_CHAT_HEIGHT });
  const win = new BrowserWindow({
    width: outer.width,
    height: outer.height,
    frame: false,
    // macOS: an NSPanel with native vibrancy — keyboard focus WITHOUT activating
    // Stem (the Spotlight/Raycast overlay contract), frosting, rounded corners and
    // the drop shadow all drawn natively. Elsewhere: a plain transparent frameless
    // window; the renderer draws the card in CSS and summoning activates the app.
    // See overlayWindowOptions.
    ...overlayWindowOptions(),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: timeLocaleArguments()
    }
  });

  deps.installNavigationGuards(win);

  // Float above full-screen apps. All-Spaces visibility is applied once here
  // (see applyOverlayWorkspaceVisibility) rather than on every show.
  win.setAlwaysOnTop(true, 'screen-saver');
  setOverlayWorkspaceVisibility(win, deps.visibleOnAllWorkspaces);
  // No blur→hide: the overlay now persists a conversation the user re-summons to
  // read, so auto-hiding on focus loss would discard the answer they just opened.
  // Dismissal is explicit only (Escape / shortcut / submit / hand-off).

  loadRenderer(win, 'quickchat');
  return win;
}

/**
 * All-Spaces visibility for the overlay. `skipTransformProcessType: true` is
 * critical: without it, macOS flips the app between accessory and foreground
 * process types on every call — which briefly hides the dock icon AND all app
 * windows, and re-activates the app (pulling the main window forward). We apply
 * this exactly once per window (at creation) and on settings change, never per
 * show, so summoning the overlay never disturbs the main window or dock.
 *
 * Three macOS caveats worth knowing before debugging this again:
 *  - Setting the collection behavior is NOT what puts the overlay on the Space you
 *    are looking at; the ordering call is (see presentOverlayWindow).
 *  - Electron's NSPanel subclass force-ORs CanJoinAllSpaces|FullScreenAuxiliary into
 *    every setCollectionBehavior:, so `false` here cannot actually take the overlay
 *    off other Spaces on macOS — the preference only bites on Linux.
 *  - `skipTransformProcessType` keeps Stem a regular (dock-icon) app, and since
 *    10.14 a regular app's window cannot float over ANOTHER app's full-screen
 *    Space. Ordinary Desktop Spaces are unaffected; full-screen ones need an
 *    accessory-app policy we deliberately don't adopt.
 */
export function setOverlayWorkspaceVisibility(win: BrowserWindow, onAllWorkspaces: boolean): void {
  win.setVisibleOnAllWorkspaces(onAllWorkspaces, workspaceVisibilityOptions());
}

/**
 * Whether a window panel can live in the asked-about window's stacking order
 * instead of floating over everything: macOS orders a window relative to any
 * other app's window by its window-server id. Elsewhere the panel stays
 * always-on-top and only follows the window's position.
 */
export const overlayStacksWithWindow = process.platform === 'darwin';

/**
 * A window panel's level. Stacked (the "Keep with its window" setting): an
 * ordinary level, so the window it was asked about (and anything stacked over
 * that) can cover it. Otherwise above everything, like the plain panel.
 */
export function stackOverlayWithWindows(win: BrowserWindow, stacked: boolean): void {
  if (!overlayStacksWithWindow) return;
  if (stacked) win.setAlwaysOnTop(false);
  else win.setAlwaysOnTop(true, 'screen-saver');
}

/**
 * Put the panel directly above `windowId` — not above everything: when another
 * window covers the asked-about one, it covers the panel too, and when the
 * asked-about window comes forward the panel comes with it. Never makes the
 * panel key or activates Stem.
 */
export function orderOverlayAbove(win: BrowserWindow, windowId: number): void {
  if (!overlayStacksWithWindow) return;
  try {
    win.moveAbove(`window:${windowId}:0`);
  } catch {
    // The window closed between the check and the call.
  }
}

/**
 * The status HUD: a tiny, non-focusable, always-on-top pill in the bottom-left.
 * `focusable: false` is critical — showing it must never steal focus from the app
 * the user is working in.
 */
export function createHudWindow(deps: { installNavigationGuards(win: BrowserWindow): void }): BrowserWindow {
  const win = new BrowserWindow({
    width: HUD_WIDTH,
    height: HUD_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: PRELOAD_SCRIPT,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: timeLocaleArguments()
    }
  });

  deps.installNavigationGuards(win);
  // A fixed title, not the page's: on Wayland the pill is found by it.
  win.setTitle(HUD_TITLE);
  win.on('page-title-updated', (e) => e.preventDefault());

  // The status pill must float above everything and follow the user across every
  // Space and into full-screen apps — unlike the overlay, this is unconditional
  // (not tied to the `showOnAllDisplays` preference): the pill is the only signal
  // that a turn is still running once the overlay is hidden.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, workspaceVisibilityOptions());

  loadRenderer(win, 'hud');
  return win;
}

/**
 * Center the overlay horizontally on the display under the cursor, in the upper
 * third. Compact when starting fresh; expanded to a panel when resuming a session.
 */
export function placeOverlay(win: BrowserWindow, reset: boolean): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const w = QUICK_CHAT_WIDTH;
  const h = reset ? QUICK_CHAT_HEIGHT : QUICK_CHAT_PANEL_HEIGHT;
  // Card bounds → window bounds (identical on macOS; grown by the CSS-shadow
  // inset elsewhere, keeping the visible card in the same place on every OS).
  win.setBounds(
    overlayOuterBounds({
      x: Math.round(workArea.x + (workArea.width - w) / 2),
      y: Math.round(workArea.y + workArea.height * 0.22),
      width: w,
      height: h
    })
  );
}

/** Height the window chip adds to the compact bar ("Ask about this window"). */
const WINDOW_CHIP_HEIGHT = 58;
/**
 * Height the tab strip adds to the compact bar when a window has more than one
 * conversation open. The expanded panel carries the tabs in its own header.
 */
const TAB_STRIP_HEIGHT = 37;

/** The compact bar's height: the chip and the tab strip each add a row. */
function compactHeight(chip: boolean, tabs: boolean): number {
  return QUICK_CHAT_HEIGHT + (chip ? WINDOW_CHIP_HEIGHT : 0) + (tabs ? TAB_STRIP_HEIGHT : 0);
}
/** Space between the panel and the window it docks against. */
const DOCK_GAP = 12;

export interface DockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the panel goes next to the window it was asked about, never on top of
 * it when the screen has room: right of the window (top edges level), else
 * left, else below, else above — the first spot the whole panel fits on the
 * window's display. A window that leaves no room anywhere (it fills the
 * screen) gets the panel over its bottom-right corner. Pure, for the tests.
 */
export function dockBeside(target: DockRect, panel: { width: number; height: number }, area: DockRect): { x: number; y: number } {
  const { width: w, height: h } = panel;
  const right = area.x + area.width;
  const bottom = area.y + area.height;
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(v, hi)));
  const levelY = clamp(target.y, area.y, bottom - h);
  const centredX = clamp(target.x + (target.width - w) / 2, area.x, right - w);
  if (target.x + target.width + DOCK_GAP + w <= right) return { x: Math.round(target.x + target.width + DOCK_GAP), y: levelY };
  if (target.x - DOCK_GAP - w >= area.x) return { x: Math.round(target.x - DOCK_GAP - w), y: levelY };
  if (target.y + target.height + DOCK_GAP + h <= bottom) return { x: centredX, y: Math.round(target.y + target.height + DOCK_GAP) };
  if (target.y - DOCK_GAP - h >= area.y) return { x: centredX, y: Math.round(target.y - DOCK_GAP - h) };
  const inset = 16;
  return {
    x: clamp(Math.min(target.x + target.width, right) - w - inset, area.x, right - w),
    y: clamp(Math.min(target.y + target.height, bottom) - h - inset, area.y, bottom - h)
  };
}

/**
 * Place the overlay beside the window it was summoned for (see dockBeside),
 * on that window's display. `chip`: the compact bar carries the window chip;
 * `tabs`: it carries the tab strip.
 */
export function placeOverlayBeside(win: BrowserWindow, target: DockRect, expanded: boolean, chip: boolean, tabs = false): void {
  const { workArea } = screen.getDisplayMatching({
    x: Math.round(target.x),
    y: Math.round(target.y),
    width: Math.max(1, Math.round(target.width)),
    height: Math.max(1, Math.round(target.height))
  });
  const w = QUICK_CHAT_WIDTH;
  const h = expanded ? QUICK_CHAT_PANEL_HEIGHT : compactHeight(chip, tabs);
  const { x, y } = dockBeside(target, { width: w, height: h }, workArea);
  win.setBounds(overlayOuterBounds({ x, y, width: w, height: h }));
}

/**
 * Shrink a visible overlay back to the compact bar where it stands (New thread,
 * or a deleted thread, empties the panel). Keeps the top edge, so the bar stays
 * where the panel's head was rather than jumping to the cursor's display.
 * `chip`: the bar carries a window chip ("Ask about this window"); `tabs`: the
 * tab strip of a window with several conversations.
 */
export function compactOverlay(win: BrowserWindow, chip = false, tabs = false): void {
  const outer = overlayOuterBounds({ x: 0, y: 0, width: QUICK_CHAT_WIDTH, height: compactHeight(chip, tabs) });
  const { x, y, width } = win.getBounds();
  win.setBounds({ x, y, width, height: outer.height });
}

/** Park the pill in the bottom-left of the display under the cursor. */
export function placeHud(win: BrowserWindow): void {
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const x = Math.round(workArea.x + 16);
  const y = Math.round(workArea.y + workArea.height - HUD_HEIGHT - 16);
  win.setBounds({ x, y, width: HUD_WIDTH, height: HUD_HEIGHT });
  // Wayland ignores setBounds' position (GNOME centres new windows).
  if (isWaylandSession()) placeOwnWindow(HUD_TITLE, x, y);
}
