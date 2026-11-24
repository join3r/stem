import { randomUUID } from 'node:crypto';
import { globalShortcut, ipcMain, shell, type BrowserWindow, type WebContents } from 'electron';
import { log } from '../../server/log';
import { handleLocal, handleLocalFrom } from '../ipc-bridge';
import {
  isWaylandSession,
  playFinishChime as platformFinishChime,
  presentOverlayWindow,
  quickChatSummonCommand
} from '../platform';
import {
  failQuickChatProcess,
  HudPill,
  OverlaySession,
  QuickChatHandoffBarrier,
  QuickChatResetBarrier
} from '../ui-lifecycle';
import {
  createHudWindow,
  createOverlayWindow,
  placeHud,
  compactOverlay,
  placeOverlay,
  placeOverlayBeside,
  orderOverlayWithWindow,
  surfaceOverlay,
  overlayStacksWithWindow,
  parkOverlay,
  restoreOverlayOpacity,
  unparkOverlay,
  setOverlayWorkspaceVisibility,
  stackOverlayWithWindows,
  type DockRect
} from './windows';
import { focusWindowApp, peekFrontWindow, readWindowText, stopWindowPeek, warmWindowPeek, windowPeekSupported, windowState } from './window-peek';
import { eventTurnId } from '../../shared/settledTurns';
import { isBrowserApp } from '../../shared/browser-apps';
import { PillTurns, type PillEventParams } from './pill-turns';
import { activityLabel } from '../../shared/activity';
import type {
  BackendEventEnvelope,
  ItemEventParams,
  LiveTurnInfo,
  ManageIntent,
  ManageTabId,
  MenuCommand,
  QuickChatHandoff,
  QuickChatPrompt,
  QuickChatSettings,
  QuickChatShortcutStatus,
  QuickChatStatus,
  QuickChatTabs,
  QuickChatMini,
  QuickChatWindow,
  StartTurnInput,
  StartTurnResult,
  WindowContext
} from '../../shared/types';

// Quick Chat: the Spotlight-style overlay, the bottom-left status pill, and the
// choreography that moves a conversation between them and the main window. All
// of it is CLIENT state — which window owns which thread, whether a hand-off is
// mid-flight, what phase the pill is in — and none of it belongs to a server that
// might not be on this machine.
//
// The one thing that reaches across the boundary is running a prompt. That used
// to be a `quickchat:run` server handler; it is now local orchestration over two
// ordinary server channels (backend:createThread, then backend:startTurn with
// `surface: 'quickChat'`), with the window choreography wrapped around them. The
// preload still exposes it on the same `quickchat:run` IPC channel, so the
// renderer cannot tell the difference — which is the point.
//
// Nothing about this state leaves the machine. It used to: which thread the
// overlay owned was published to the server (`client:claimThread`), so a turn
// being held at the desk would not mirror to a phone as a phantom user-less
// slice. With the phone gone, every client that could receive the mirror is a
// desktop that was already receiving it, so the claim had nothing left to gate.

export interface QuickChatDeps {
  /** The live main window, or null while it is closed. */
  mainWindow(): BrowserWindow | null;
  /** Push to the main window through its ready-queue (see RendererPushQueue). */
  sendToMain(channel: string, payload: unknown): void;
  /** Bring the main window to the front, recreating it if it was closed. */
  revealMainWindow(): void;
  /** Deny in-app navigation and route external links to the system browser. */
  installNavigationGuards(win: BrowserWindow): void;
  /** Call a server channel over the transport (see desktop/proxy.ts). */
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /**
   * Suppress the app.on('activate') main-window recreation for this summon.
   * Showing the overlay activates the app; without the guard that handler would
   * reopen a previously-closed main window, so summoning Quick Chat would "also
   * open the main app."
   */
  beginSummon(): void;
  /**
   * A browser window: whether its browser has the Stem extension connected,
   * and the page in front (browser-host peekWindow). Absent until the browser
   * host exists.
   */
  peekBrowser?(app: string, title: string): Promise<{ ready: boolean; page: { url: string; title: string } | null }>;
}

export interface QuickChatSurface {
  submitHudTurn(input: StartTurnInput): void;
  acceptHudTurn(turnId: string): void;
  abandonHudTurn(turnId: string): void;
  disconnectHud(): void;
  reconcileHud(deviceId: string, turns: LiveTurnInfo[]): void;
  /** Create both windows (hidden) and bind the saved global accelerator. */
  start(settings: QuickChatSettings): void;
  /** Register the client-owned channels: quickchat:* and main:reveal. */
  registerIpc(): void;
  /** Summon or dismiss the overlay — the shortcut, the tray, the CLI, the HUD. */
  toggle(): void;
  /**
   * Window › Minimize (⌘M) while a Quick Chat panel has the keyboard: a window
   * panel shrinks to its pill. True when a panel had it (a panel never minimises).
   */
  minimizeFocused(): boolean;
  /** "Ask about this window" — its shortcut, or `stem --ask-window` (the Wayland path). */
  askAboutWindow(): void;
  /** Is any Quick Chat panel on screen? (app.on('activate') asks before reopening the app.) */
  overlayVisible(): boolean;
  /** Apply the parts of a Quick Chat settings change no other layer can. */
  applySettings(patch: Partial<QuickChatSettings>, next: QuickChatSettings): void;
  /** What Settings needs to tell the truth about the summon key. */
  shortcutStatus(): QuickChatShortcutStatus;
  /** Push on a channel the overlay windows render (approval asks go to one panel). */
  sendToOverlay(channel: string, payload: unknown): void;
  /** Push on a channel the HUD pill renders (theme changes). No-op when it is gone. */
  sendToHud(channel: string, payload: unknown): void;
  /** Let go of the window helper (app quit). */
  stop(): void;
  /** Bring back the panel that owns `threadId` (approval cards). */
  revealIfOwns(threadId: string | null | undefined): void;
  /**
   * Route a backend thread event to this client's windows. Returns true when a
   * desktop-only surface claimed it exclusively — the overlay's live thread, or a
   * hand-off still buffering. Those never reach the phone: the overlay's live
   * thread is a conversation happening at the desk, and a phone would build the
   * same phantom user-less slice the main window would.
   */
  routeBackendEvent(event: BackendEventEnvelope): boolean;
  /** The implicit hand-off when the sidebar opens the overlay's live thread. */
  threadOpened(threadId: string): Promise<void>;
  /** Main window lost focus: surface a running thread in the follow-me pill. */
  syncMainHud(): void;
  /** Main window regained focus: drop the follow-me pill. */
  hideMainHud(): void;
}

/**
 * One Quick Chat panel: an overlay window and the conversation it owns. The
 * plain panel (the Quick Chat shortcut) sits centred and always exists; every
 * window asked about gets a panel of its own, docked beside that window, so
 * several can be open — and answering — at once. A window can hold several
 * conversations as tabs: each tab is a panel of its own (its own overlay
 * window, session and turn), stacked in the same spot with one in front.
 */
interface Panel {
  /** Names the panel to its renderer's tab strip. */
  readonly id: string;
  win: BrowserWindow | null;
  /** The window's tabs this panel is one of; null for the plain panel. */
  group: WindowGroup | null;
  /** The first question asked in the current conversation (the tab's label). */
  label: string | null;
  /** An answer finished while this tab was out of sight. */
  unread: boolean;
  /** Showing a conversation (tall panel) rather than the compact bar. */
  expanded: boolean;
  /**
   * Shrunk to a small pill beside its window (window panels only): ⌘M, the
   * header button, or a click back into the window while an answer runs.
   */
  mini: boolean;
  /** What the pill shows while `mini`: the answer's last progress. */
  miniStatus: QuickChatStatus | null;
  /** The compact bar carries the window chip. */
  chip: boolean;
  /**
   * The window this panel was asked about: it docks beside it (never on top
   * when the screen has room) and follows it while shown, and the first prompt
   * sent with its chip carries its text. Null for the plain panel.
   */
  peek: {
    window: QuickChatWindow;
    bounds: DockRect;
    text: Promise<string | null>;
    /** Last seen minimised, hidden or on another Space (absent: on screen). */
    away?: boolean;
  } | null;
  /**
   * Hidden because its window went out of sight (minimised, app hidden, other
   * Space), not dismissed: it comes back when the window does. macOS only.
   */
  parked: boolean;
  /** Thread ownership and turn state — see OverlaySession. */
  readonly overlay: OverlaySession;
  readonly handoffBarrier: QuickChatHandoffBarrier;
  /** A manual reset requested while the old turn was still settling. Keep
   * ownership long enough to route that turn's terminal event, then release it. */
  readonly resetBarrier: QuickChatResetBarrier;
  turnId: string | null;
  /** Polls the anchored window's frame while the panel is on screen. */
  followTimer: NodeJS.Timeout | null;
  /** The last summon: the longest-unused hidden panel is the one let go. */
  lastShown: number;
}

/** The conversations open about one window: its tabs, one of them in front. */
interface WindowGroup {
  readonly windowId: number;
  readonly tabs: Panel[];
  active: Panel;
}

/** Window panels (tabs included) kept at most; past this the longest-unused idle hidden one closes. */
const MAX_WINDOW_PANELS = 8;
/** Tabs one window may hold. */
const MAX_TABS_PER_WINDOW = 5;

function newPanel(win: BrowserWindow | null): Panel {
  return {
    id: randomUUID(),
    win,
    group: null,
    label: null,
    unread: false,
    expanded: false,
    mini: false,
    miniStatus: null,
    chip: false,
    peek: null,
    overlay: new OverlaySession(),
    handoffBarrier: new QuickChatHandoffBarrier(),
    resetBarrier: new QuickChatResetBarrier(),
    turnId: null,
    followTimer: null,
    parked: false,
    lastShown: 0
  };
}

function live(win: BrowserWindow | null | undefined): win is BrowserWindow {
  return !!win && !win.isDestroyed();
}

function onScreen(panel: Panel): boolean {
  return live(panel.win) && panel.win.isVisible();
}

/** On screen, or a tab behind one that is: its window's panel is in front of the user. */
function inSight(panel: Panel): boolean {
  return onScreen(panel) || (!!panel.group && onScreen(panel.group.active));
}

/** The compact bar shows a tab strip: its window has more than one conversation. */
function showsTabs(panel: Panel): boolean {
  return !!panel.group && panel.group.tabs.length > 1;
}

/** Permission asks: shown by the panel whose thread asked, else by the plain one. */
const APPROVAL_REQUESTS = new Set([
  'exec:approvalRequest',
  'harness:approvalRequest',
  'mcp:adminApproval',
  'instructions:approvalRequest',
  'skills:approvalRequest'
]);

/** Answers (or expiries) of those asks: the pill stops waiting on them. */
const APPROVAL_RESOLUTIONS = new Set([
  'exec:approvalResolved',
  'harness:approvalResolved',
  'mcp:adminApprovalResolved',
  'instructions:approvalResolved',
  'skills:approvalResolved'
]);

const WAITING: QuickChatStatus = { phase: 'waiting', label: 'Waiting for your approval' };

export function createQuickChat(deps: QuickChatDeps): QuickChatSurface {
  /** Bottom-left status pill shown while a panel is hidden and its turn runs. */
  let hudWindow: BrowserWindow | null = null;

  /** The currently-registered global accelerator, so we can unregister on change. */
  let currentShortcut: string | null = null;
  /**
   * The accelerator the user configured, registered or not. Kept apart from
   * `currentShortcut` (which only ever holds a grab the OS accepted) so Settings can
   * tell "your key is live" from "the OS refused it" instead of showing a shortcut
   * that does nothing.
   */
  let desiredShortcut: string | null = null;
  /** The same pair for "Ask about this window". */
  let currentWindowShortcut: string | null = null;
  let desiredWindowShortcut: string | null = null;

  // ---- Quick Chat panels ----
  //
  // Each panel owns one live conversation at a time. While it owns a thread, that
  // thread's backend events route to the panel (not the main window) and drive the
  // status HUD. Hand-off (button, or opening the thread from the sidebar) routes
  // events to the main window from then on. All of that state lives in the panel's
  // OverlaySession — every mutation is a named transition, never a bare flag.
  const plain = newPanel(null);
  /** "Ask about this window" panels, as tabs grouped by the id of the window they were asked about. */
  const windowPanels = new Map<number, WindowGroup>();
  /** Tabs closed while their answer winds down: still routed to until it settles. */
  const closing = new Set<Panel>();
  /**
   * A hidden, already-loaded overlay waiting to become the next window panel, so
   * asking about a new window is as instant as re-summoning a known one.
   */
  let spare: BrowserWindow | null = null;
  /** A press is still capturing: a second press waits its turn instead of racing it. */
  let peeking = false;
  /** Cached "show overlay on all Spaces" setting, applied once per overlay window. */
  let overlayOnAllDisplays = true;
  /** Cached inactivity timeout (ms) after which a summon starts a fresh thread. */
  let newThreadTimeoutMs = 5 * 60_000;

  // ---- Follow-me status pill (main-window threads) ----
  //
  // The bottom-left pill is shared between Quick Chat and the main app. While the
  // main window is unfocused (you switched Spaces/apps) and a main-window thread is
  // running, the pill mirrors that progress so you don't lose sight of it.
  /** Show the pill for main threads when the main window loses focus. */
  let followAcrossSpaces = true;
  /** Window panels keep to their window's stacking and visibility (macOS). */
  let stayWithWindow = false;
  const stacking = () => overlayStacksWithWindow && stayWithWindow;
  /** Play a chime when a turn finishes while the pill is visible. */
  let finishSound = false;
  /** Locally initiated interactive turns shared by both HUD paths. */
  const pillTurns = new PillTurns();
  /** Ownership + last phase of the shared pill (chime edge detection) — see HudPill. */
  const hud = new HudPill();
  /** The panel the pill speaks for while Quick Chat owns it (its click reveals it). */
  let hudPanel: Panel | null = null;
  /** Unanswered approval cards, id → asking thread: the pill says so instead of "Working…". */
  const approvals = new Map<string, string>();

  function awaitingApproval(threadId: string | null | undefined): boolean {
    if (!threadId) return false;
    for (const t of approvals.values()) if (t === threadId) return true;
    return false;
  }

  function dropApprovals(threadId: string | null | undefined): void {
    for (const [id, t] of approvals) if (t === threadId) approvals.delete(id);
  }

  /** A card was raised or answered: re-push the pill that speaks for its thread. */
  function noteApproval(channel: string, payload: unknown): void {
    const p = (payload ?? {}) as { id?: unknown; threadId?: unknown };
    if (p.id === undefined || p.id === null) return;
    const id = String(p.id);
    let threadId: string | undefined;
    if (APPROVAL_REQUESTS.has(channel)) {
      if (typeof p.threadId !== 'string') return;
      threadId = p.threadId;
      approvals.set(id, threadId);
    } else {
      threadId = approvals.get(id);
      if (!approvals.delete(id)) return;
    }
    const panel = ownerOf(threadId);
    if (panel) {
      if (miniShown(panel.group) && panel.group!.active === panel && panel.overlay.turnRunning)
        showPanelHud(panel, { phase: 'working', label: 'Working…' });
      else if (hudShows(panel) && !onScreen(panel) && hud.lastPhase !== 'finished')
        showPanelHud(panel, { phase: 'working', label: 'Working…' });
    } else syncMainHud();
  }

  /** A panel's pill push, held at "waiting" while its thread has a card open. */
  function showPanelHud(panel: Panel, status: QuickChatStatus): void {
    const waiting = status.phase !== 'finished' && awaitingApproval(panel.overlay.threadId);
    showHud(waiting ? WAITING : status, 'quickchat', panel);
  }

  function panels(): Panel[] {
    return [plain, ...[...windowPanels.values()].flatMap((g) => g.tabs), ...closing];
  }

  /** Every overlay window, the spare included: theme and connection changes reach all. */
  function overlayWindows(): BrowserWindow[] {
    return [...panels().map((p) => p.win), spare].filter(live);
  }

  /** The panel that owns `threadId`, if any does. */
  function ownerOf(threadId: string | null | undefined): Panel | undefined {
    return panels().find((p) => p.overlay.owns(threadId));
  }

  /** The panel a call came from. Unknown callers (tests) speak for the plain one. */
  function panelFor(sender: WebContents | undefined): Panel {
    return (sender && panels().find((p) => live(p.win) && p.win.webContents === sender)) || plain;
  }

  function createPanelWindow(): BrowserWindow {
    return createOverlayWindow({
      installNavigationGuards: deps.installNavigationGuards,
      visibleOnAllWorkspaces: overlayOnAllDisplays
    });
  }

  function panelWindow(panel: Panel): BrowserWindow {
    if (panel === plain && !live(plain.win)) {
      const win = createPanelWindow();
      win.on('closed', () => {
        if (plain.win === win) plain.win = null;
      });
      plain.win = win;
    }
    return panel.win!;
  }

  function ensureSpare(): void {
    if (live(spare)) return;
    const win = createPanelWindow();
    win.on('closed', () => {
      if (spare === win) spare = null;
    });
    spare = win;
  }

  /**
   * A panel for a window asked about for the first time, or another tab in
   * `group`. Too many already: the longest-unused hidden one with nothing
   * running closes first (never a tab of the window in front of the user).
   */
  function openWindowPanel(windowId: number, group: WindowGroup | null = null): Panel {
    const open = panels().filter((p) => p.group);
    if (open.length >= MAX_WINDOW_PANELS) {
      const idle = open
        .filter((p) => !inSight(p) && p.group !== group && !p.overlay.turnRunning && !p.resetBarrier.pending)
        .sort((a, b) => a.lastShown - b.lastShown)[0];
      idle?.win?.destroy();
    }
    const win = live(spare) ? spare : createPanelWindow();
    spare = null;
    // Lives in its window's stacking order rather than over everything, when set so.
    stackOverlayWithWindows(win, stayWithWindow);
    const panel = newPanel(win);
    if (group) group.tabs.push(panel);
    else {
      group = { windowId, tabs: [panel], active: panel };
      windowPanels.set(windowId, group);
    }
    panel.group = group;
    // A click back into the window (or anywhere else) while an answer runs
    // shrinks the panel to its pill, so it stops covering the user's work.
    // Deferred: a tab switch or a dismiss hides the panel in the same tick.
    win.on('blur', () => {
      setTimeout(() => {
        if (panel.group?.active === panel && panel.overlay.turnRunning && !win.isFocused()) minimize(panel, false);
      }, 0);
    });
    win.on('closed', () => {
      stopFollowing(panel);
      panel.win = null;
      if (hudPanel === panel) hudPanel = null;
      leaveGroup(panel);
    });
    // The next window's panel loads while this one is in use.
    setTimeout(ensureSpare, 1_000);
    return panel;
  }

  /** Take a tab out of its window's group; the most recently used one left takes the front. */
  function leaveGroup(panel: Panel): void {
    const group = panel.group;
    if (!group) return;
    panel.group = null;
    group.tabs.splice(group.tabs.indexOf(panel), 1);
    if (!group.tabs.length) {
      if (windowPanels.get(group.windowId) === group) windowPanels.delete(group.windowId);
      return;
    }
    if (group.active === panel) group.active = [...group.tabs].sort((a, b) => b.lastShown - a.lastShown)[0];
    pushTabs(group);
  }

  /**
   * Tell every tab of a window what the strip shows. The compact bar grows or
   * shrinks by the strip when the second tab opens or the last but one closes.
   */
  function pushTabs(group: WindowGroup): void {
    const tabs = group.tabs.map((p) => ({
      id: p.id,
      label: p.label,
      active: p === group.active,
      running: p.overlay.turnRunning,
      unread: p.unread
    }));
    const canAdd = group.tabs.length < MAX_TABS_PER_WINDOW;
    for (const p of group.tabs) sendTo(p, 'quickchat:tabs', { tabs, canAdd, self: p.id } satisfies QuickChatTabs);
    if (onScreen(group.active) && !group.active.expanded) place(group.active);
    pushMini(group.active);
  }

  /** Size and dock a window panel beside its window for what it shows now. */
  function place(panel: Panel): void {
    if (!live(panel.win) || !panel.peek) return;
    placeOverlayBeside(panel.win, panel.peek.bounds, panel.expanded, panel.chip, showsTabs(panel), panel.mini);
  }

  /** The pill of `group` is on screen: its front tab is shrunk and shown. */
  function miniShown(group: WindowGroup | null): boolean {
    return !!group && group.active.mini && onScreen(group.active);
  }

  /** Tell a shrunk panel what its pill shows. */
  function pushMini(panel: Panel): void {
    if (!panel.mini || !panel.peek) return;
    sendTo(panel, 'quickchat:mini', {
      status: panel.miniStatus,
      app: panel.peek.window.app,
      tabs: panel.group?.tabs.length ?? 1
    } satisfies QuickChatMini);
  }

  /**
   * Shrink a window panel with a conversation to a pill beside its window.
   * `giveBackKeys`: the user asked for it from inside the panel, so the
   * keyboard goes back to the window (a click into the window already did that).
   */
  function minimize(panel: Panel, giveBackKeys: boolean): void {
    if (panel.mini || !panel.group || !panel.peek || !panel.expanded || !onScreen(panel)) return;
    panel.mini = true;
    panel.miniStatus = panel.overlay.turnRunning
      ? awaitingApproval(panel.overlay.threadId)
        ? WAITING
        : { phase: 'working', label: 'Working…' }
      : null;
    pushMini(panel);
    place(panel);
    if (giveBackKeys && panel.win!.isFocused()) {
      // Hidden and shown again without focus: the panel stops being the key
      // window. macOS then gives the keyboard to no app, so the helper makes
      // the window's app the active one again.
      panel.win!.hide();
      panel.win!.showInactive();
      void focusWindowApp(panel.peek.window.windowId);
    }
  }

  /** Grow a pill back to the full panel; present() then puts it in front. */
  function unminimize(panel: Panel): void {
    if (!panel.mini) return;
    panel.mini = false;
    panel.miniStatus = null;
    sendTo(panel, 'quickchat:mini', null);
  }

  function ensureHudWindow(): BrowserWindow {
    if (!hudWindow || hudWindow.isDestroyed()) {
      hudWindow = createHudWindow({ installNavigationGuards: deps.installNavigationGuards });
      hudWindow.on('closed', () => {
        hudWindow = null;
      });
    }
    return hudWindow;
  }

  function sendTo(panel: Panel, channel: string, payload?: unknown): void {
    if (live(panel.win)) panel.win.webContents.send(channel, payload);
  }

  /** Play the finish chime: macOS system sound, or the HUD window's bundled asset. */
  function playFinishChime(): void {
    platformFinishChime(hudWindow);
  }

  /**
   * Show the HUD pill (bottom-left of the display under the cursor) and push status.
   * `owner` records whether Quick Chat (and which panel) or the follow-me path is
   * driving it. The chime fires once, on the transition into 'finished' while the
   * pill is visible.
   */
  function showHud(status: QuickChatStatus, owner: 'quickchat' | 'main', panel: Panel | null = null): void {
    // A window shrunk to its pill: the pill beside it shows the front tab's
    // progress, and no tab of that window uses the shared pill.
    if (owner === 'quickchat' && panel?.group && miniShown(panel.group)) {
      if (panel !== panel.group.active) return;
      const finished = status.phase === 'finished' && panel.miniStatus?.phase !== 'finished';
      panel.miniStatus = status;
      pushMini(panel);
      if (finished && finishSound) platformFinishChime(ensureHudWindow());
      return;
    }
    if (!pillTurns.connected) return;
    const win = ensureHudWindow();
    if (!win.isVisible()) {
      placeHud(win);
      win.showInactive(); // show without stealing focus
    }
    hudPanel = owner === 'quickchat' ? panel : null;
    const enteredFinished = hud.notePush(owner, status.phase);
    // Stamp the live accelerator so the pill prompts the real summon key, not Enter.
    win.webContents.send('quickchat:status', { ...status, shortcut: currentShortcut });
    if (enteredFinished && finishSound) playFinishChime();
  }

  function hideHud(): void {
    if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) hudWindow.hide();
    hud.noteHidden();
    hudPanel = null;
  }

  /** Is the pill showing `panel`'s turn? */
  function hudShows(panel: Panel): boolean {
    return hud.owner === 'quickchat' && hudPanel === panel;
  }

  function finishOverlayReset(panel: Panel): void {
    panel.overlay.releaseThread();
    panel.resetBarrier.settle();
  }

  /**
   * HUD state machine, driven by a panel-owned thread's event stream. Only runs
   * while that panel is hidden (when it's visible the user is reading, no HUD):
   *   working  -> "Thinking…" / "Searching the web…" / "Using a tool…"
   *   answering -> once the first answer text streams
   *   finished  -> once the turn completes
   */
  function driveHud(panel: Panel, event: { method: string; params: unknown }): void {
    const p = (event.params ?? {}) as PillEventParams;
    if (eventTurnId(p) !== panel.turnId || !pillTurns.event(event.method, p)) return;
    const { overlay } = panel;
    // A tab behind the one in front shows its progress in the strip, not the
    // pill. A window shrunk to its pill shows the progress there (see showHud).
    const visible = inSight(panel) && !miniShown(panel.group);
    switch (event.method) {
      case 'item/started': {
        if (visible) break;
        const item = (event.params as ItemEventParams)?.item;
        const type = item?.type;
        // Always update — tool calls and teed web searches mid-answer keep the
        // pill live instead of freezing at 'Answering…' after the first token.
        if (type && type !== 'agentMessage')
          showPanelHud(panel, { phase: 'working', label: activityLabel(type, item?.name, item?.detail) });
        break;
      }
      case 'item/agentMessage/delta': {
        if (visible) break;
        // Deltas arrive per token; only push when the label actually changes
        // (first token, or resuming the answer after a mid-answer tool call).
        if (!overlay.hudTextSeen || hud.lastPhase !== 'answering' || hudPanel !== panel) {
          overlay.noteAnswerText();
          showPanelHud(panel, { phase: 'answering', label: 'Answering…' });
        }
        break;
      }
      case 'turn/completed':
      case 'turn/failed':
      case 'turn/aborted': {
        const label =
          event.method === 'turn/completed'
            ? 'Answer ready'
            : event.method === 'turn/failed'
              ? 'Request failed'
              : 'Stopped';
        overlay.settleTurn(Date.now());
        dropApprovals(overlay.threadId);
        if (panel.group) {
          if (event.method === 'turn/completed' && !onScreen(panel) && !panel.resetBarrier.pending) panel.unread = true;
          pushTabs(panel.group);
        }
        // A reset must not release the old thread until this terminal event has
        // been routed. Otherwise its trailing deltas can be mistaken for the next
        // Quick Chat session.
        if (panel.resetBarrier.pending) {
          overlay.resetHudText();
          if (hudShows(panel)) hideHud();
          finishOverlayReset(panel);
        } else if (!visible) {
          showHud({ phase: 'finished', label }, 'quickchat', panel);
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Follow-me pill: while the main window is unfocused (you switched Spaces/apps)
   * and a main-window thread is running, mirror its progress in the shared pill.
   * No-ops while Quick Chat owns the pill (it takes priority) or the feature is off.
   */
  function syncMainHud(): void {
    if (!followAcrossSpaces) {
      if (hud.owner === 'main') hideHud();
      return;
    }
    if (hud.owner === 'quickchat') return;
    const main = deps.mainWindow();
    const blurred = !!main && !main.isDestroyed() && !main.isFocused();
    const running = pillTurns.turns.filter(t => !ownerOf(t.threadId));
    if (running.length && blurred) {
      const waiting = running.some(t => awaitingApproval(t.threadId));
      showHud({ ...(waiting ? WAITING : { phase: 'working', label: 'Working…' }), reveal: 'main' }, 'main');
    } else if (hud.owner === 'main') hideHud();
  }

  /**
   * Track which main-window threads are running and drive the follow-me pill. The
   * 'finished' transition (and its chime) only fires when the pill is already
   * shown for the main app (hud.owner === 'main') — i.e. the user is away.
   */
  function noteMainThreadEvent(method: string, threadId: string, params?: unknown): void {
    const p = (params ?? {}) as PillEventParams;
    if (!pillTurns.event(method, { ...p, threadId })) return;
    if (method === 'item/started' || method === 'item/agentMessage/delta') {
      syncMainHud();
    } else if (method === 'turn/completed' || method === 'turn/failed' || method === 'turn/aborted' || method === 'process/exit') {
      dropApprovals(threadId);
      if (hud.owner === 'main' && !pillTurns.turns.some(t => !ownerOf(t.threadId))) {
        const label = method === 'turn/completed' ? 'Answer ready' : method === 'turn/aborted' ? 'Stopped' : 'Request failed';
        showHud({ phase: 'finished', label, reveal: 'main' }, 'main');
      }
    }
  }

  /**
   * Show a panel. `reset` true => start a fresh session (compact spotlight bar);
   * false => resume the existing session (expanded conversation panel, showing the
   * answer the user re-summoned to read). The panel's React state persists across
   * hide/show, so resuming needs no payload beyond the reset flag.
   */
  function showQuickChat(panel: Panel, reset: boolean, window?: QuickChatWindow): void {
    panel.expanded = !reset;
    if (reset) panel.chip = !!panel.peek;
    present(panel);
    panel.win!.webContents.send('quickchat:focus', window ? { reset, window } : { reset });
  }

  /**
   * Put a panel on screen as it stands. A tab comes to the front of its
   * window's panel, in the spot the one it replaces was in, and that one hides.
   */
  function present(panel: Panel): void {
    const win = panelWindow(panel);
    // Resuming puts the answer in front of the user: that's reading it.
    if (panel.expanded && !panel.overlay.turnRunning) markOverlayThreadRead(panel);
    // Another panel's running turn keeps its pill; a tab of this window's does
    // not, the strip shows it.
    if (hud.owner !== 'quickchat' || hudPanel === panel || (!!panel.group && hudPanel?.group === panel.group)) hideHud();
    deps.beginSummon();
    panel.lastShown = Date.now();
    panel.parked = false;
    unminimize(panel);
    const group = panel.group;
    if (group) {
      const before = group.active;
      if (before !== panel && before.peek && panel.peek && onScreen(before)) panel.peek.bounds = before.peek.bounds;
      group.active = panel;
      panel.unread = false;
    }
    if (panel.peek) {
      place(panel);
      followWindow(panel);
    } else placeOverlay(win, !panel.expanded);
    // Surface the panel on whatever Space the user is on and make it the key window
    // so it receives keystrokes (typing, Escape) — without activating Stem, so the
    // previous app stays active underneath and the main window is never pulled
    // forward. The macOS ordering is subtle; see presentOverlayWindow.
    restoreOverlayOpacity(win);
    // A panel sunk behind another app's windows comes back to its own level.
    if (group) stackOverlayWithWindows(win, stayWithWindow);
    presentOverlayWindow(win);
    if (group) {
      for (const tab of group.tabs) if (tab !== panel) dismissQuickChat(tab);
      pushTabs(group);
    }
  }

  /**
   * Keep a docked panel with its window while the panel is on screen: beside it
   * when the window is dragged or resized, and (macOS) directly above it in the
   * stacking order — whatever covers the window covers the panel, and when the
   * window comes forward the panel comes with it. A window that is minimised,
   * hidden or moved to another Space takes its panel along, and brings it back
   * on return. Only the change is acted on: a panel the user brings back while
   * its window is still away stays up. Stops once the panel is dismissed or the
   * window closes.
   */
  function followWindow(panel: Panel): void {
    if (panel.followTimer) return;
    const following = (win: BrowserWindow | null): win is BrowserWindow => live(win) && (win.isVisible() || panel.parked);
    panel.followTimer = setInterval(() => {
      const win = panel.win;
      const anchored = panel.peek;
      if (!following(win) || !anchored) {
        stopFollowing(panel);
        return;
      }
      void windowState(anchored.window.windowId)
        .then((state) => {
          if (panel.peek !== anchored || !following(win)) return;
          if (!state) {
            // Closed (or, off macOS, minimised): the panel stays where it is,
            // and one parked with it is let go.
            surfaceOverlay(win);
            if (panel.parked) {
              panel.parked = false;
              stopFollowing(panel);
            }
            return;
          }
          const wasAway = !!anchored.away;
          anchored.away = !state.onScreen;
          if (stacking() && anchored.away !== wasAway) {
            if (anchored.away) {
              if (win.isVisible()) {
                panel.parked = true;
                parkOverlay(win);
              }
              return;
            }
            if (panel.parked) {
              panel.parked = false;
              unparkOverlay(win);
              if (hudShows(panel)) hideHud();
            }
          }
          if (anchored.away) return;
          const b = state.bounds;
          const p = anchored.bounds;
          if (b.x !== p.x || b.y !== p.y || b.width !== p.width || b.height !== p.height) {
            anchored.bounds = b;
            place(panel);
          }
          if (stacking()) orderOverlayWithWindow(win, anchored.window.windowId, state.frontmost);
        })
        .catch(() => undefined);
    }, stacking() ? 250 : 400);
  }

  function stopFollowing(panel: Panel): void {
    if (panel.followTimer) clearInterval(panel.followTimer);
    panel.followTimer = null;
  }

  /**
   * The window shortcut: capture the window the user is in, then summon that
   * window's own panel beside it, with the window as a chip. Each window keeps
   * its own panel and conversation, so asking about a second window leaves the
   * first one's panel open. Pressed while typing in a panel, it dismisses that
   * panel; pressed over a window whose panel is open, it brings that panel
   * forward. A known window resumes its conversation (unless it went idle).
   */
  async function askAboutWindow(): Promise<void> {
    const focused = panels().find((p) => onScreen(p) && p.win!.isFocused());
    if (focused) {
      dismissQuickChat(focused);
      return;
    }
    if (peeking) return;
    peeking = true;
    try {
      const peeked = await peekFrontWindow();
      if (!peeked) {
        // No other window to ask about: an ordinary summon.
        toggleQuickChat();
        return;
      }
      const w = peeked.window;
      await addBrowserState(w);
      // A window with several tabs comes back on the one last in front.
      const known = windowPanels.get(w.windowId)?.active;
      if (known && onScreen(known) && known.mini) {
        // Shrunk to its pill: the full panel comes back, keyboard and all.
        present(known);
        known.win!.webContents.send('quickchat:focus', { reset: false });
        return;
      }
      if (known && onScreen(known)) {
        // Already open beside it: just put the keyboard back in it.
        known.lastShown = Date.now();
        deps.beginSummon();
        presentOverlayWindow(known.win!);
        known.win!.webContents.send('quickchat:focus', { reset: false });
        return;
      }
      const panel = known ?? openWindowPanel(w.windowId);
      const reset = panel.overlay.shouldStartFresh(Date.now(), newThreadTimeoutMs);
      if (reset) {
        panel.overlay.clearForFreshSession();
        panel.label = null;
      }
      // The text is read while the user types; the send waits for it (see runQuickChat).
      const text = reset || !panel.peek
        ? w.missing.includes('accessibility')
          ? Promise.resolve(null)
          : readWindowText(w.windowId)
        : panel.peek.text;
      panel.peek = { window: w, bounds: peeked.bounds, text };
      showQuickChat(panel, reset, reset ? w : undefined);
    } finally {
      peeking = false;
    }
  }

  /** A browser window: whether browser control can drive it, and its page. */
  async function addBrowserState(w: QuickChatWindow): Promise<void> {
    if (!deps.peekBrowser || !isBrowserApp(w.app, w.bundleId)) return;
    // quiet: a browser that cannot answer is one without browser control.
    const seen = await deps.peekBrowser(w.app, w.title).catch(() => ({ ready: false, page: null }));
    w.browserReady = seen.ready;
    if (seen.page) w.url = seen.page.url;
  }

  /**
   * The panel's New: a fresh question about the window it is docked beside
   * gets a fresh picture and text of it, not the ones from the last summon.
   * `window: null` once the window has closed; null when the panel is not
   * docked beside a window, so it keeps whatever window it shows.
   */
  async function repeekPanelWindow(panel: Panel): Promise<{ window: QuickChatWindow | null } | null> {
    const anchored = panel.peek;
    if (!anchored) return null;
    panel.label = null;
    if (panel.group) pushTabs(panel.group);
    const peeked = await peekFrontWindow(anchored.window.windowId);
    if (!peeked) return { window: null };
    const w = peeked.window;
    await addBrowserState(w);
    const text = w.missing.includes('accessibility') ? Promise.resolve(null) : readWindowText(w.windowId);
    panel.peek = { window: w, bounds: peeked.bounds, text };
    return { window: w };
  }

  /** What the model is told about the window a prompt was sent with. */
  async function windowContextFor(panel: Panel, windowId: number | undefined): Promise<WindowContext | undefined> {
    const anchored = panel.peek;
    if (windowId === undefined || !anchored || anchored.window.windowId !== windowId) return undefined;
    const { app, bundleId, title, url, browserReady } = anchored.window;
    // A slow app's tree must not hold the question up for long: past this the
    // turn goes with the picture alone.
    const text = await Promise.race([
      anchored.text,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000))
    ]);
    return {
      windowId,
      app,
      bundleId,
      title,
      text,
      ...(url ? { url } : {}),
      ...(browserReady !== undefined ? { browserReady } : {})
    };
  }

  /**
   * Quick Chat answers are read in the panel, never in the main window, so the
   * panel's thread has to be stamped read from here or its sidebar row stays
   * bold. Two moments count: re-summoning onto a settled answer, and a turn
   * settling while the panel is on screen.
   */
  function markOverlayThreadRead(panel: Panel): void {
    const threadId = panel.overlay.threadId;
    if (!threadId || panel.overlay.handedOff) return;
    void deps.invoke('inbox:setRead', [[threadId], true]).catch((error) => log('main', 'quick chat mark-read failed', { threadId, error: String(error) }));
  }

  /**
   * Hide a panel on an explicit dismiss (Escape, or the shortcut pressed again).
   * Panels are non-activating, so hiding one does not promote Stem's main window
   * to the front and the previously-active app keeps focus — we just hide the
   * panel (no app.hide, which would also hide the main window, the HUD and every
   * other panel).
   */
  function dismissQuickChat(panel: Panel): void {
    stopFollowing(panel);
    panel.parked = false;
    if (onScreen(panel)) panel.win!.hide();
  }

  /** The Quick Chat shortcut: summon or dismiss the plain, centred panel. */
  function toggleQuickChat(): void {
    if (onScreen(plain)) {
      dismissQuickChat(plain);
      return;
    }
    // Decide continue-vs-fresh: no live session, already handed off, or idle past
    // the configured timeout => start a new thread. Clear ownership up front so the
    // old thread's events stop routing to the (now reset) panel.
    const reset = plain.overlay.shouldStartFresh(Date.now(), newThreadTimeoutMs);
    if (reset) plain.overlay.clearForFreshSession();
    showQuickChat(plain, reset);
  }

  /** Grab `accelerator` for `handler`; the accelerator when the OS granted it, else null. */
  function registerAccelerator(accelerator: string | null, handler: () => void): string | null {
    if (!accelerator) return null;
    try {
      if (globalShortcut.register(accelerator, handler)) return accelerator;
      log('main', 'global shortcut refused by the OS', { accelerator });
    } catch (error) {
      log('main', 'global shortcut registration failed', { accelerator, error: String(error) });
    }
    return null;
  }

  /** (Re)register the global accelerator. Returns false when registration fails. */
  function applyQuickChatShortcut(accelerator: string | null): boolean {
    desiredShortcut = accelerator;
    if (currentShortcut) {
      globalShortcut.unregister(currentShortcut);
      currentShortcut = null;
    }
    currentShortcut = registerAccelerator(accelerator, toggleQuickChat);
    return !accelerator || !!currentShortcut;
  }

  /** (Re)register "Ask about this window" where the helper can see other windows (Wayland binds `--ask-window` instead). */
  function applyWindowShortcut(accelerator: string | null): void {
    desiredWindowShortcut = accelerator;
    if (currentWindowShortcut) {
      globalShortcut.unregister(currentWindowShortcut);
      currentWindowShortcut = null;
    }
    if (!windowPeekSupported) return;
    currentWindowShortcut = registerAccelerator(accelerator, () => void askAboutWindow());
    // The helper's launch was most of a first press's wait: start it now, and
    // have the first window's panel loaded before it is asked for.
    if (currentWindowShortcut) {
      warmWindowPeek();
      ensureSpare();
    }
  }

  /**
   * What Settings needs to tell the truth about the summon key: the configured
   * accelerator, whether the OS actually granted the grab, and — on Wayland, where
   * a granted grab still never fires — the command to bind in the DE instead.
   */
  function quickChatShortcutStatus(): QuickChatShortcutStatus {
    return {
      accelerator: desiredShortcut,
      registered: !!desiredShortcut && currentShortcut === desiredShortcut,
      windowAccelerator: desiredWindowShortcut,
      windowRegistered: !!desiredWindowShortcut && currentWindowShortcut === desiredWindowShortcut,
      wayland: isWaylandSession(),
      summonCommand: quickChatSummonCommand(),
      windowSummonCommand: quickChatSummonCommand('--ask-window')
    };
  }

  async function captureQuickChatHandoff(panel: Panel, threadId: string): Promise<{
    id: string;
    snapshot: QuickChatHandoff;
  } | null> {
    const win = panel.win;
    if (!live(win)) return null;
    const ticket = panel.handoffBarrier.begin(threadId);
    if (ticket.fresh) win.webContents.send('quickchat:handoffRequest', { id: ticket.id, threadId });
    const timer = setTimeout(() => {
      const buffered = panel.handoffBarrier.cancel(ticket.id);
      for (const event of buffered) {
        if (!win.isDestroyed()) win.webContents.send('backend:event', event);
        driveHud(panel, event);
      }
    }, 30_000);
    const snapshot = await ticket.promise;
    clearTimeout(timer);
    if (!snapshot) return null;
    // Keep the barrier installed until the caller flips ownership. Otherwise an
    // event can arrive between this await and chats:open marking the panel as
    // handed off, and be routed back to Quick Chat after its snapshot was taken.
    return { id: ticket.id, snapshot };
  }

  /**
   * Opening a panel's live thread from the sidebar is an implicit hand-off:
   * route its events to the main window and drop the panel/HUD so the two views
   * don't diverge. Runs before the server reads the thread (chats:open), and its
   * throws are the ones the renderer sees.
   */
  async function threadOpened(threadId: string): Promise<void> {
    const panel = ownerOf(threadId);
    if (!panel) return;
    const { overlay } = panel;
    const captured = await captureQuickChatHandoff(panel, threadId);
    if (!captured) {
      // A simultaneous explicit Open-in-Stem action may already have completed
      // the same transition and cancelled this sidebar request.
      if (!overlay.handedOff) {
        showQuickChat(panel, false);
        throw new Error('Quick Chat did not return a handoff snapshot. Try Open in Stem again.');
      }
      return;
    }
    // Flip ownership before removing the event barrier. Events arriving
    // before commit stay buffered; events arriving after it route directly
    // to the main renderer.
    const flippedHere = overlay.claimHandoff();
    const transition = panel.handoffBarrier.commit(captured.id);
    if (!transition) {
      // An explicit handoff may have won while this handler was awaiting the
      // snapshot. Only restore ownership when no other path completed it.
      if (flippedHere) {
        overlay.revertHandoff();
        showQuickChat(panel, false);
        throw new Error('Quick Chat handoff was interrupted. Try Open in Stem again.');
      }
      return;
    }
    overlay.stopTurn();
    if (hudShows(panel)) hideHud();
    dismissQuickChat(panel);
    // Its conversation now lives in the main window; the tab has nothing left.
    if (showsTabs(panel)) void closeTab(panel);
    deps.sendToMain('quickchat:adopt', transition.snapshot);
    for (const bufferedEvent of transition.events) {
      deps.sendToMain('backend:event', bufferedEvent);
      noteMainThreadEvent(bufferedEvent.method, threadId, bufferedEvent.params);
    }
  }

  /** A backend death took `panel`'s running turn with it: give the input back. */
  function failPanelTurn(panel: Panel): void {
    panel.overlay.restore(failQuickChatProcess(Date.now(), panel.overlay.threadId));
    if (hudShows(panel)) showHud({ phase: 'finished', label: 'Request failed' }, 'quickchat', panel);
    if (panel.resetBarrier.pending) finishOverlayReset(panel);
  }

  function routeBackendEvent(event: BackendEventEnvelope): boolean {
    const threadId = (event.params as { threadId?: string } | undefined)?.threadId;
    // captureQuickChatHandoff replays buffered events immediately after the atomic snapshot.
    if (threadId && panels().some((p) => p.handoffBarrier.buffer(threadId, event))) return true;
    // A panel owns its live thread until hand-off: route its events to that
    // panel (which renders the conversation) and the status HUD, NOT the main
    // window — otherwise the main window would build a phantom user-less slice.
    const owner = ownerOf(threadId);
    if (owner) {
      // The panel's own worker died mid-turn (attributed process/exit routes
      // with the dead turn's threadId): restore the input exactly as an
      // unattributed backend death always has.
      if (event.method === 'process/exit' && (owner.overlay.turnRunning || owner.resetBarrier.pending) &&
          pillTurns.event(event.method, (event.params ?? {}) as PillEventParams)) {
        failPanelTurn(owner);
      }
      sendTo(owner, 'backend:event', event);
      driveHud(owner, event);
      if (event.method === 'turn/completed' && onScreen(owner) && !owner.mini) markOverlayThreadRead(owner);
      return true;
    }
    if (!threadId) {
      // An attributed process/exit with a null thread is an idle pool worker
      // retiring: no turn died anywhere, so nothing here may clear. Forward it
      // and stop — the destructive branch below is for the unattributed death
      // of a whole (older) backend.
      const exitParams = event.params as { threadId?: string | null } | undefined;
      if (event.method === 'process/exit' && exitParams && 'threadId' in exitParams) {
        deps.sendToMain('backend:event', event);
        for (const panel of panels()) sendTo(panel, 'backend:event', event);
        return false;
      }
      // Process-level events (e.g. process/exit) carry no threadId — let every
      // window clear its run state, and clear the follow-me pill so a backend
      // crash never leaves a stuck "Working…" pill.
      for (const panel of panels()) {
        for (const bufferedEvent of panel.handoffBarrier.cancelCurrent()) {
          sendTo(panel, 'backend:event', bufferedEvent);
          driveHud(panel, bufferedEvent);
        }
      }
      deps.sendToMain('backend:event', event);
      for (const panel of panels()) sendTo(panel, 'backend:event', event);
      if (event.method === 'process/exit') {
        pillTurns.event(event.method, (event.params ?? {}) as PillEventParams);
        for (const panel of panels()) {
          if (panel.overlay.turnRunning || panel.resetBarrier.pending) failPanelTurn(panel);
        }
        if (hud.owner === 'main') hideHud();
      }
      return false;
    }
    deps.sendToMain('backend:event', event);
    noteMainThreadEvent(event.method, threadId, event.params);
    return false;
  }

  /**
   * Close one of a window's tabs. The next one comes to the front where it
   * stood; the last tab only hides, like Escape. A tab whose answer is still
   * winding down (its renderer already stopped it) keeps its thread until the
   * turn's last event has routed, the same way New thread does, then goes.
   */
  async function closeTab(panel: Panel): Promise<void> {
    const group = panel.group;
    if (!group) return;
    if (group.tabs.length === 1) {
      dismissQuickChat(panel);
      return;
    }
    const i = group.tabs.indexOf(panel);
    const wasInFront = onScreen(panel);
    leaveGroup(panel);
    if (wasInFront) {
      const next = group.tabs[Math.min(i, group.tabs.length - 1)];
      if (panel.peek && next.peek) next.peek.bounds = panel.peek.bounds;
      present(next);
      next.win!.webContents.send('quickchat:focus', { reset: false });
    }
    dismissQuickChat(panel);
    if (hudShows(panel)) hideHud();
    if (!panel.overlay.handedOff) {
      closing.add(panel);
      panel.overlay.prepareManualReset();
      if (panel.overlay.turnRunning) await panel.resetBarrier.wait();
      else finishOverlayReset(panel);
      closing.delete(panel);
    }
    panel.win?.destroy();
  }

  /**
   * Run a prompt in the panel's own thread. For a fresh session we pre-create
   * the thread (so its events route correctly from the very first event), then
   * hide the plain panel and raise the HUD — the disappear→HUD half of the cycle.
   */
  async function runQuickChat(panel: Panel, prompt: QuickChatPrompt): Promise<StartTurnResult> {
    const { overlay } = panel;
    // Start the disappear→HUD half of the cycle immediately — before the (async)
    // thread creation — so the panel never flashes the half-laid-out panel.
    const turnId = prompt.turnId || randomUUID();
    panel.turnId = turnId;
    overlay.beginTurn(Date.now());
    if (panel.group) {
      if (!overlay.owns(prompt.threadId)) panel.label = prompt.input.trim().slice(0, 80) || null;
      pushTabs(panel.group);
    }
    if (panel.peek && onScreen(panel)) {
      // Docked beside a window: the answer is read right there, next to what
      // it is about, so the panel grows in place instead of giving way to the
      // pill. (driveHud shows no pill while the panel is visible.)
      panel.expanded = true;
      place(panel);
    } else {
      // Hide just the panel (NOT app.hide — that would also hide the HUD we're
      // about to show, and re-showing the HUD would reactivate the app and surface
      // the main window). The panel is non-activating, so hiding it does not
      // promote the main window. The HUD is non-focusable, so it never steals
      // focus from whatever app the user is in.
      dismissQuickChat(panel);
      showHud({ phase: 'working', label: 'Working…' }, 'quickchat', panel);
    }

    try {
      const continuing = overlay.owns(prompt.threadId);
      let threadId = continuing ? overlay.threadId! : null;
      if (!threadId) {
        // The format goes in at creation: it decides which kind of worker the
        // pre-created session is bound to, and only that worker can serve it.
        threadId = (await deps.invoke('backend:createThread', [prompt.model ?? undefined, prompt.format ?? null])) as string;
        overlay.adoptThread(threadId);
        // Before the turn, so no event of it can outrun the claim.
        // Optimistic sidebar row so the quickchat thread shows immediately.
        deps.sendToMain('quickchat:sessionStarted', {
          threadId,
          title: prompt.input.trim() || 'New chat'
        });
      }

      const windowContext = await windowContextFor(panel, prompt.windowId);
      // `surface` is the whole of what makes this a Quick Chat turn: the server
      // resolves the Quick Chat web-search toggle and the main+quickChat
      // instruction composition from it (see backend:startTurn).
      const result = (await deps.invoke('backend:startTurn', [
        {
          input: prompt.input,
          turnId,
          threadId,
          model: prompt.model ?? undefined,
          effort: prompt.effort ?? undefined,
          serviceTier: prompt.serviceTier,
          format: prompt.format,
          surface: 'quickChat',
          attachments: prompt.attachments,
          ...(windowContext ? { windowContext } : {})
        } satisfies StartTurnInput
      ])) as StartTurnResult;
      overlay.noteActivity(Date.now());
      if (overlay.handedOff && result.threadId && result.turnId) {
        // The snapshot can be captured while startTurn is still preparing Recall.
        // Publish the minted id as soon as prompt acceptance returns so Stop is
        // interruptible even before the first real item event.
        deps.sendToMain('backend:event', {
          method: 'item/started',
          params: {
            threadId: result.threadId,
            turnId: result.turnId,
            item: { id: `agent-${result.turnId}`, type: 'agentMessage' }
          },
          receivedAt: new Date().toISOString()
        } satisfies BackendEventEnvelope);
      }
      // The memory shortcut ("remember that …") completes with no stream — jump the
      // HUD straight to finished. A canceled start also comes back handled, but
      // there is no answer to announce: the user stopped it, so just stand down.
      if (result.handled) {
        overlay.stopTurn();
        if (result.canceled) {
          if (hudShows(panel)) hideHud();
        } else if (!onScreen(panel)) showHud({ phase: 'finished', label: 'Answer ready' }, 'quickchat', panel);
      }
      return result;
    } catch (e) {
      overlay.settleTurn(Date.now());
      if (panel.group) pushTabs(panel.group);
      if (hudShows(panel)) hideHud();
      if (panel.resetBarrier.pending) finishOverlayReset(panel);
      if (overlay.handedOff && overlay.threadId) {
        deps.sendToMain('backend:event', {
          method: 'turn/failed',
          params: {
            threadId: overlay.threadId,
            turn: { id: `quick-start-${Date.now()}`, status: 'failed' },
            error: e instanceof Error ? e.message : String(e)
          },
          receivedAt: new Date().toISOString()
        } satisfies BackendEventEnvelope);
      } else {
        showQuickChat(panel, false);
      }
      throw e;
    }
  }

  return {
    submitHudTurn(input) { pillTurns.submit(input); },
    acceptHudTurn(turnId) { pillTurns.accepted(turnId); },
    abandonHudTurn(turnId) { pillTurns.abandon(turnId); syncMainHud(); },
    disconnectHud() {
      pillTurns.disconnect();
      approvals.clear(); // The reconnect replays every card still open.
      hideHud();
    },
    reconcileHud(deviceId, turns) {
      pillTurns.reconcile(deviceId, turns);
      hideHud(); // Snapshot corrections are silent; only live endings chime.
      let shown = false;
      for (const panel of panels()) {
        const running = pillTurns.turns.some(t => t.turnId === panel.turnId && panel.overlay.owns(t.threadId));
        if (panel.overlay.turnRunning && !running) {
          panel.overlay.settleTurn(Date.now());
          if (panel.resetBarrier.pending) finishOverlayReset(panel);
        }
        if (running && !onScreen(panel)) {
          panel.overlay.beginTurn(Date.now());
          if (!shown && !inSight(panel)) {
            showPanelHud(panel, { phase: 'working', label: 'Working…' });
            shown = true;
          }
        }
      }
      for (const group of windowPanels.values()) pushTabs(group);
      if (!shown) syncMainHud();
    },
    start(settings) {
      // Seed the all-Spaces flag before creating the overlay so it's applied once,
      // at creation.
      overlayOnAllDisplays = settings.showOnAllDisplays;
      newThreadTimeoutMs = settings.newThreadTimeoutMs;
      followAcrossSpaces = settings.followAcrossSpaces;
      stayWithWindow = settings.stayWithWindow;
      finishSound = settings.finishSound;
      // Pre-create the windows (hidden) so the shortcut summons instantly, and
      // bind the global accelerators from the saved settings.
      panelWindow(plain);
      ensureHudWindow();
      applyQuickChatShortcut(settings.shortcut);
      applyWindowShortcut(settings.windowShortcut);
    },

    stop() {
      for (const panel of panels()) stopFollowing(panel);
      stopWindowPeek();
    },

    registerIpc() {
      ipcMain.on('quickchat:handoffSnapshot', (event, id: string, payload: QuickChatHandoff) => {
        const panel = panels().find((p) => live(p.win) && event.sender === p.win.webContents);
        panel?.handoffBarrier.supply(id, payload);
      });

      handleLocal('quickchat:shortcutStatus', () => quickChatShortcutStatus());
      handleLocalFrom('quickchat:run', (sender, prompt: QuickChatPrompt) => runQuickChat(panelFor(sender), prompt));

      // Forget the calling panel's thread so its next prompt opens a fresh one.
      // A window panel also re-captures its window: the reply is the fresh chip.
      handleLocalFrom('quickchat:newThread', async (sender) => {
        const panel = panelFor(sender);
        panel.overlay.prepareManualReset();
        if (hudShows(panel)) hideHud();
        if (panel.overlay.turnRunning) {
          await panel.resetBarrier.wait();
        } else {
          finishOverlayReset(panel);
        }
        return repeekPanelWindow(panel);
      });

      // Hand the conversation off to the main window: route future events there,
      // reveal the main window, and have it adopt the thread as the active chat.
      handleLocalFrom('quickchat:handoff', (sender, payload: QuickChatHandoff) => {
        const panel = panelFor(sender);
        const bufferedEvents = panel.handoffBarrier.cancelCurrent();
        panel.overlay.claimHandoff();
        panel.overlay.stopTurn();
        if (panel.resetBarrier.pending) finishOverlayReset(panel);
        if (hudShows(panel)) hideHud();
        dismissQuickChat(panel);
        if (showsTabs(panel)) void closeTab(panel);
        deps.revealMainWindow();
        deps.sendToMain('quickchat:adopt', payload);
        for (const bufferedEvent of bufferedEvents) {
          deps.sendToMain('backend:event', bufferedEvent);
          noteMainThreadEvent(bufferedEvent.method, payload.threadId, bufferedEvent.params);
        }
      });

      // Re-summon the panel the pill speaks for (HUD click); the plain one by default.
      handleLocal('quickchat:reveal', () => {
        const panel = hudPanel && hudPanel !== plain && live(hudPanel.win) ? hudPanel : null;
        if (panel) {
          if (!onScreen(panel)) showQuickChat(panel, false);
        } else if (!onScreen(plain)) toggleQuickChat();
      });

      // Raise the main window (follow-me pill click). Returning focus to the main
      // window fires the 'focus' handler, which hides the pill.
      handleLocal('main:reveal', () => deps.revealMainWindow());

      handleLocalFrom('quickchat:hide', (sender) => {
        dismissQuickChat(panelFor(sender));
      });

      // The window chip's "Open Settings": the Privacy pane for the missing grant.
      handleLocal('quickchat:openPrivacy', (_e, which: 'screen' | 'accessibility') => {
        const pane = which === 'accessibility' ? 'Privacy_Accessibility' : 'Privacy_ScreenCapture';
        void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pane}`);
      });

      // The window chip's Connect / Set up: the work happens in the main window's panel.
      handleLocalFrom('quickchat:openManage', (sender, tab: ManageTabId, raw?: ManageIntent | null) => {
        const intent: ManageIntent | null =
          raw?.kind === 'mcp-connect' && typeof raw.entryId === 'string'
            ? { kind: 'mcp-connect', entryId: raw.entryId.slice(0, 100) }
            : raw?.kind === 'browser-control'
              ? { kind: 'browser-control' }
              : null;
        dismissQuickChat(panelFor(sender));
        deps.revealMainWindow();
        deps.sendToMain('menu:command', { kind: 'manage-tab', tab, ...(intent ? { intent } : {}) } satisfies MenuCommand);
      });

      // The panel emptied while on screen (New thread, deleted thread): drop back
      // to the compact bar instead of leaving a tall empty card.
      handleLocalFrom('quickchat:compact', (sender, chip?: boolean) => {
        const panel = panelFor(sender);
        panel.expanded = false;
        panel.chip = chip === true;
        if (onScreen(panel) && !panel.mini) compactOverlay(panel.win!, panel.chip, showsTabs(panel));
      });

      // A window panel's tabs: another conversation about the same window,
      // with a fresh picture of it (the window may show something new by now).
      handleLocalFrom('quickchat:newTab', async (sender) => {
        const from = panelFor(sender);
        const group = from.group;
        if (!group || group.tabs.length >= MAX_TABS_PER_WINDOW) return;
        const peeked = await peekFrontWindow(group.windowId);
        // The window closed: nothing to ask about.
        if (!peeked || !group.tabs.length) return;
        const w = peeked.window;
        await addBrowserState(w);
        const tab = openWindowPanel(group.windowId, group);
        const text = w.missing.includes('accessibility') ? Promise.resolve(null) : readWindowText(w.windowId);
        // Where the panel stands now, not where the window was when it was first asked about.
        tab.peek = { window: w, bounds: from.peek?.bounds ?? peeked.bounds, text };
        showQuickChat(tab, true, w);
      });

      // ⌘M / the header button: shrink to the pill. A click on the pill grows it back.
      handleLocalFrom('quickchat:minimize', (sender) => {
        minimize(panelFor(sender), true);
      });
      handleLocalFrom('quickchat:expand', (sender) => {
        const panel = panelFor(sender);
        if (!panel.mini) return;
        present(panel);
        sendTo(panel, 'quickchat:focus', { reset: false });
      });

      handleLocalFrom('quickchat:switchTab', (sender, id: string) => {
        const tab = panelFor(sender).group?.tabs.find((p) => p.id === id);
        if (!tab || (tab.group!.active === tab && onScreen(tab))) return;
        present(tab);
        tab.win!.webContents.send('quickchat:focus', { reset: false });
      });

      // A tab stops its own answer before it goes (it owns the turn's ids), so
      // closing another tab asks that one to close itself.
      handleLocalFrom('quickchat:closeTab', async (sender, id: string) => {
        const from = panelFor(sender);
        const tab = from.group?.tabs.find((p) => p.id === id);
        if (!tab) return;
        if (tab !== from) sendTo(tab, 'quickchat:closeTabRequest', { id });
        else await closeTab(tab);
      });
    },

    toggle: toggleQuickChat,
    minimizeFocused: () => {
      const panel = panels().find((p) => onScreen(p) && p.win!.isFocused());
      if (!panel) return false;
      minimize(panel, true);
      return true;
    },

    askAboutWindow: () => void askAboutWindow(),

    overlayVisible: () => panels().some(onScreen),

    applySettings(patch, next) {
      if ('shortcut' in patch) applyQuickChatShortcut(next.shortcut);
      if ('windowShortcut' in patch) applyWindowShortcut(next.windowShortcut);
      if ('showOnAllDisplays' in patch) {
        overlayOnAllDisplays = next.showOnAllDisplays;
        for (const win of overlayWindows()) setOverlayWorkspaceVisibility(win, overlayOnAllDisplays);
      }
      if ('newThreadTimeoutMs' in patch) newThreadTimeoutMs = next.newThreadTimeoutMs;
      if ('followAcrossSpaces' in patch) {
        followAcrossSpaces = next.followAcrossSpaces;
        if (!followAcrossSpaces && hud.owner === 'main') hideHud();
      }
      if ('finishSound' in patch) finishSound = next.finishSound;
      if ('stayWithWindow' in patch && next.stayWithWindow !== stayWithWindow) {
        stayWithWindow = next.stayWithWindow;
        for (const panel of panels()) {
          if (!panel.group || !live(panel.win)) continue;
          stackOverlayWithWindows(panel.win, stayWithWindow);
          // A panel parked with its window comes back once the binding is off.
          if (!stayWithWindow && panel.parked) {
            panel.parked = false;
            unparkOverlay(panel.win);
            if (hudShows(panel)) hideHud();
          }
          // The poll rate follows the setting.
          if (panel.followTimer) {
            stopFollowing(panel);
            followWindow(panel);
          }
        }
      }
    },

    shortcutStatus: quickChatShortcutStatus,

    sendToOverlay(channel, payload) {
      // Every approval ask and answer funnels through here (live and replayed).
      if (APPROVAL_REQUESTS.has(channel) || APPROVAL_RESOLUTIONS.has(channel)) noteApproval(channel, payload);
      if (APPROVAL_REQUESTS.has(channel)) {
        // One card, in the panel whose conversation asked — or the plain panel,
        // whose dialog has always carried asks from elsewhere.
        sendTo(ownerOf((payload as { threadId?: string } | undefined)?.threadId) ?? plain, channel, payload);
        return;
      }
      for (const win of overlayWindows()) win.webContents.send(channel, payload);
    },

    sendToHud(channel, payload) {
      if (hudWindow && !hudWindow.isDestroyed()) hudWindow.webContents.send(channel, payload);
    },

    revealIfOwns(threadId) {
      // A panel may be hidden while its turn runs. Bring the originating panel
      // back so mounting a card actually makes the confirmation visible.
      const panel = threadId ? ownerOf(threadId) : undefined;
      if (panel && !onScreen(panel) && !closing.has(panel)) showQuickChat(panel, false);
    },

    routeBackendEvent,
    threadOpened,
    syncMainHud,

    hideMainHud() {
      if (hud.owner === 'main') hideHud();
    }
  };
}
