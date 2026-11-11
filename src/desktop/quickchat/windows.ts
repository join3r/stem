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
  sunk.delete(win);
  if (stacked) win.setAlwaysOnTop(false);
  else win.setAlwaysOnTop(true, 'screen-saver');
}

/** A panel whose window closed: back to the ordinary level, where it can be seen. */
export function surfaceOverlay(win: BrowserWindow): void {
  if (sunk.delete(win)) win.setAlwaysOnTop(false);
}

/** Panels put one level below ordinary windows while another app is in front. */
const sunk = new WeakSet<BrowserWindow>();

/**
 * Keep the panel in the stacking order of the window `windowId`. While that
 * window's app is in front, the panel goes directly above the window. While
 * another app is in front (`frontmost` false), the panel goes one level below
 * ordinary windows, so that app's windows cover it, as they cover the window.
 *
 * Why a level and not an order: macOS keeps a window that joins all Spaces in
 * front of the other windows of its level when a different app comes forward,
 * and it does not accept an order relative to another app's window for it.
 * Electron's panel type always joins all Spaces. A panel the user types in
 * stays where it is. Never makes the panel key or activates Stem.
 */
export function orderOverlayWithWindow(win: BrowserWindow, windowId: number, frontmost: boolean | null): void {
  if (!overlayStacksWithWindow) return;
  if (frontmost === false && !win.isFocused()) {
    if (!sunk.has(win)) {
      sunk.add(win);
      win.setAlwaysOnTop(true, 'normal', -1);
    }
    return;
  }
  if (sunk.delete(win)) win.setAlwaysOnTop(false);
  try {
    win.moveAbove(`window:${windowId}:0`);
  } catch {
    // The window closed between the check and the call.
  }
}

/**
 * Hide a window panel whose window just went away (minimised, app hidden, other
 * Space) at once. macOS fades a panel out on hide, which next to the window's
 * own minimise animation looks like a second, lagging one; a panel already at
 * zero opacity has nothing to fade. unparkOverlay puts the opacity back.
 */
export function parkOverlay(win: BrowserWindow): void {
  win.setOpacity(0);
  win.hide();
}

/** Bring a parked panel back without taking focus, at once rather than fading in. */
export function unparkOverlay(win: BrowserWindow): void {
  win.showInactive();
  restoreOverlayOpacity(win);
}

/** Undo parkOverlay's zero opacity; any show of a panel goes through this. */
export function restoreOverlayOpacity(win: BrowserWindow): void {
  if (win.getOpacity() !== 1) win.setOpacity(1);
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
/** The pill a window panel shrinks to (⌘M, or a click back into its window while it works). */
const MINI_WIDTH = 248;
const MINI_HEIGHT = 40;
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
export function placeOverlayBeside(win: BrowserWindow, target: DockRect, expanded: boolean, chip: boolean, tabs = false, mini = false): void {
  const { workArea } = screen.getDisplayMatching({
    x: Math.round(target.x),
    y: Math.round(target.y),
    width: Math.max(1, Math.round(target.width)),
    height: Math.max(1, Math.round(target.height))
  });
  const w = QUICK_CHAT_WIDTH;
  const h = expanded ? QUICK_CHAT_PANEL_HEIGHT : compactHeight(chip, tabs);
  const spot = dockBeside(target, { width: w, height: h }, workArea);
  win.setBounds(overlayOuterBounds(mini ? miniSpot(target, spot, w) : { ...spot, width: w, height: h }));
}

/**
 * The pill sits at the top of the spot the full panel takes, on the side next
 * to the window: the panel's left edge when it docks right of the window,
 * its right edge when it docks left. Pure, for the tests.
 */
export function miniSpot(target: DockRect, panel: { x: number; y: number }, panelWidth: number): DockRect {
  const leftOfWindow = panel.x + panelWidth <= target.x;
  return { x: leftOfWindow ? panel.x + panelWidth - MINI_WIDTH : panel.x, y: panel.y, width: MINI_WIDTH, height: MINI_HEIGHT };
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
