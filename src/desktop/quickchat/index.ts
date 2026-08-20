import { globalShortcut, ipcMain, type BrowserWindow } from 'electron';
import { log } from '../../server/log';
import { handleLocal } from '../ipc-bridge';
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
  placeOverlay,
  setOverlayWorkspaceVisibility
} from './windows';
import { activityLabel } from '../../shared/activity';
import type {
  BackendEventEnvelope,
  ItemEventParams,
  QuickChatHandoff,
  QuickChatPrompt,
  QuickChatSettings,
  QuickChatShortcutStatus,
  QuickChatStatus,
  StartTurnInput,
  StartTurnResult
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
}

export interface QuickChatSurface {
  /** Create both windows (hidden) and bind the saved global accelerator. */
  start(settings: QuickChatSettings): void;
  /** Register the client-owned channels: quickchat:* and main:reveal. */
  registerIpc(): void;
  /** Summon or dismiss the overlay — the shortcut, the tray, the CLI, the HUD. */
  toggle(): void;
  /** Is the overlay on screen? (app.on('activate') asks before reopening the app.) */
  overlayVisible(): boolean;
  /** Apply the parts of a Quick Chat settings change no other layer can. */
  applySettings(patch: Partial<QuickChatSettings>, next: QuickChatSettings): void;
  /** What Settings needs to tell the truth about the summon key. */
  shortcutStatus(): QuickChatShortcutStatus;
  /** Push on a channel the overlay window renders. No-op when it is gone. */
  sendToOverlay(channel: string, payload: unknown): void;
  /** Bring the overlay back when it owns `threadId` (approval cards). */
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

export function createQuickChat(deps: QuickChatDeps): QuickChatSurface {
  let overlayWindow: BrowserWindow | null = null;
  /** Bottom-left status pill shown while the overlay is hidden and a turn runs. */
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
  /** Cached "show overlay on all Spaces" setting, applied once per overlay window. */
  let overlayOnAllDisplays = true;
  /** Cached inactivity timeout (ms) after which a summon starts a fresh thread. */
  let newThreadTimeoutMs = 5 * 60_000;

  // ---- Quick Chat session ownership ----
  //
  // The overlay owns one live conversation at a time. While it owns a thread, that
  // thread's backend events route to the overlay (not the main window) and drive the
  // status HUD. Hand-off (button, or opening the thread from the sidebar) routes
  // events to the main window from then on. All of that state lives in `overlay`
  // (see OverlaySession) — every mutation is a named transition, never a bare flag.
  const overlay = new OverlaySession();
  const overlayHandoffBarrier = new QuickChatHandoffBarrier();
  /** A manual reset requested while the old overlay turn was still settling. Keep
   * ownership long enough to route that turn's terminal event, then release it. */
  const overlayResetBarrier = new QuickChatResetBarrier();

  // ---- Follow-me status pill (main-window threads) ----
  //
  // The bottom-left pill is shared between Quick Chat and the main app. While the
  // main window is unfocused (you switched Spaces/apps) and a main-window thread is
  // running, the pill mirrors that progress so you don't lose sight of it.
  /** Show the pill for main threads when the main window loses focus. */
  let followAcrossSpaces = true;
  /** Play a chime when a turn finishes while the pill is visible. */
  let finishSound = false;
  /** Main-window threads currently running (working/answering), keyed by threadId. */
  const runningMainThreads = new Set<string>();
  /** Ownership + last phase of the shared pill (chime edge detection) — see HudPill. */
  const hud = new HudPill();

  function applyOverlayWorkspaceVisibility(): void {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      setOverlayWorkspaceVisibility(overlayWindow, overlayOnAllDisplays);
    }
  }

  function ensureOverlayWindow(): BrowserWindow {
    if (!overlayWindow || overlayWindow.isDestroyed()) {
      overlayWindow = createOverlayWindow({
        installNavigationGuards: deps.installNavigationGuards,
        visibleOnAllWorkspaces: overlayOnAllDisplays
      });
      overlayWindow.on('closed', () => {
        overlayWindow = null;
      });
    }
    return overlayWindow;
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

  function sendToOverlay(channel: string, payload?: unknown): void {
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.webContents.send(channel, payload);
  }

  /** Play the finish chime: macOS system sound, or the HUD window's bundled asset. */
  function playFinishChime(): void {
    platformFinishChime(hudWindow);
  }

  /**
   * Show the HUD pill (bottom-left of the display under the cursor) and push status.
   * `owner` records whether Quick Chat or the follow-me path is driving it. The chime
   * fires once, on the transition into 'finished' while the pill is visible.
   */
  function showHud(status: QuickChatStatus, owner: 'quickchat' | 'main'): void {
    const win = ensureHudWindow();
    if (!win.isVisible()) {
      placeHud(win);
      win.showInactive(); // show without stealing focus
    }
    const enteredFinished = hud.notePush(owner, status.phase);
    // Stamp the live accelerator so the pill prompts the real summon key, not Enter.
    win.webContents.send('quickchat:status', { ...status, shortcut: currentShortcut });
    if (enteredFinished && finishSound) playFinishChime();
  }

  function hideHud(): void {
    if (hudWindow && !hudWindow.isDestroyed() && hudWindow.isVisible()) hudWindow.hide();
    hud.noteHidden();
  }

  function finishOverlayReset(): void {
    overlay.releaseThread();
    overlayResetBarrier.settle();
  }

  /**
   * HUD state machine, driven by the overlay-owned thread's event stream. Only runs
   * while the overlay is hidden (when it's visible the user is reading, no HUD):
   *   working  -> "Thinking…" / "Searching the web…" / "Using a tool…"
   *   answering -> once the first answer text streams
   *   finished  -> once the turn completes
   */
  function driveHud(event: { method: string; params: unknown }): void {
    const overlayVisible = overlayWindow?.isVisible() ?? false;
    switch (event.method) {
      case 'item/started': {
        if (overlayVisible) break;
        const item = (event.params as ItemEventParams)?.item;
        const type = item?.type;
        // Always update — tool calls and teed web searches mid-answer keep the
        // pill live instead of freezing at 'Answering…' after the first token.
        if (type && type !== 'agentMessage')
          showHud({ phase: 'working', label: activityLabel(type, item?.name, item?.detail) }, 'quickchat');
        break;
      }
      case 'item/agentMessage/delta': {
        if (overlayVisible) break;
        // Deltas arrive per token; only push when the label actually changes
        // (first token, or resuming the answer after a mid-answer tool call).
        if (!overlay.hudTextSeen || hud.lastPhase !== 'answering') {
          overlay.noteAnswerText();
          showHud({ phase: 'answering', label: 'Answering…' }, 'quickchat');
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
        // A reset must not release the old thread until this terminal event has
        // been routed. Otherwise its trailing deltas can be mistaken for the next
        // Quick Chat session.
        if (overlayResetBarrier.pending) {
          overlay.resetHudText();
          if (hud.owner === 'quickchat') hideHud();
          finishOverlayReset();
        } else if (!overlayVisible) {
          showHud({ phase: 'finished', label }, 'quickchat');
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
    const running = runningMainThreads.size > 0;
    if (running && blurred) {
      showHud({ phase: 'working', label: 'Working…', reveal: 'main' }, 'main');
    }
  }

  /**
   * Track which main-window threads are running and drive the follow-me pill. The
   * 'finished' transition (and its chime) only fires when the pill is already
   * shown for the main app (hud.owner === 'main') — i.e. the user is away.
   */
  function noteMainThreadEvent(method: string, threadId: string): void {
    if (method === 'item/started' || method === 'item/agentMessage/delta') {
      runningMainThreads.add(threadId);
      syncMainHud(); // handles a thread that starts while you're already away
    } else if (method === 'turn/completed' || method === 'turn/failed' || method === 'turn/aborted') {
      runningMainThreads.delete(threadId);
      if (hud.owner === 'main' && runningMainThreads.size === 0) {
        const label =
          method === 'turn/completed' ? 'Answer ready' : method === 'turn/failed' ? 'Request failed' : 'Stopped';
        showHud({ phase: 'finished', label, reveal: 'main' }, 'main');
      }
    }
  }

  /**
   * Show the overlay. `reset` true => start a fresh session (compact spotlight bar);
   * false => resume the existing session (expanded conversation panel, showing the
   * answer the user re-summoned to read). The overlay's React state persists across
   * hide/show, so resuming needs no payload beyond the reset flag.
   */
  function showQuickChat(reset: boolean): void {
    const win = ensureOverlayWindow();
    hideHud();
    deps.beginSummon();
    placeOverlay(win, reset);
    // Surface the panel on whatever Space the user is on and make it the key window
    // so it receives keystrokes (typing, Escape) — without activating Stem, so the
    // previous app stays active underneath and the main window is never pulled
    // forward. The macOS ordering is subtle; see presentOverlayWindow.
    presentOverlayWindow(win);
    win.webContents.send('quickchat:focus', { reset });
  }

  /**
   * Hide the overlay on an explicit dismiss (Escape, or the shortcut pressed again).
   * The overlay is a non-activating panel, so hiding it does not promote Stem's main
   * window to the front and the previously-active app keeps focus — we just hide the
   * panel (no app.hide, which would also hide the main window and the HUD).
   */
  function dismissQuickChat(): void {
    hideOverlayWindow();
  }

  /** Hide just the overlay window (without app.hide), so the HUD can stay visible. */
  function hideOverlayWindow(): void {
    if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible()) overlayWindow.hide();
  }

  function toggleQuickChat(): void {
    if (overlayWindow && overlayWindow.isVisible()) {
      dismissQuickChat();
      return;
    }
    // Decide continue-vs-fresh: no live session, already handed off, or idle past
    // the configured timeout => start a new thread. Clear ownership up front so the
    // old thread's events stop routing to the (now reset) overlay.
    const reset = overlay.shouldStartFresh(Date.now(), newThreadTimeoutMs);
    if (reset) overlay.clearForFreshSession();
    showQuickChat(reset);
  }

  /** (Re)register the global accelerator. Returns false when registration fails. */
  function applyQuickChatShortcut(accelerator: string | null): boolean {
    desiredShortcut = accelerator;
    if (currentShortcut) {
      globalShortcut.unregister(currentShortcut);
      currentShortcut = null;
    }
    if (!accelerator) return true;
    try {
      const ok = globalShortcut.register(accelerator, toggleQuickChat);
      if (ok) currentShortcut = accelerator;
      else log('main', 'global shortcut refused by the OS', { accelerator });
      return ok;
    } catch (error) {
      log('main', 'global shortcut registration failed', { accelerator, error: String(error) });
      return false;
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
      wayland: isWaylandSession(),
      summonCommand: quickChatSummonCommand()
    };
  }

  async function captureQuickChatHandoff(threadId: string): Promise<{
    id: string;
    snapshot: QuickChatHandoff;
  } | null> {
    const win = overlayWindow;
    if (!win || win.isDestroyed()) return null;
    const ticket = overlayHandoffBarrier.begin(threadId);
    if (ticket.fresh) win.webContents.send('quickchat:handoffRequest', { id: ticket.id, threadId });
    const timer = setTimeout(() => {
      const buffered = overlayHandoffBarrier.cancel(ticket.id);
      for (const event of buffered) {
        if (!win.isDestroyed()) win.webContents.send('backend:event', event);
        driveHud(event);
      }
    }, 30_000);
    const snapshot = await ticket.promise;
    clearTimeout(timer);
    if (!snapshot) return null;
    // Keep the barrier installed until the caller flips ownership. Otherwise an
    // event can arrive between this await and chats:open marking the overlay as
    // handed off, and be routed back to Quick Chat after its snapshot was taken.
    return { id: ticket.id, snapshot };
  }

  /**
   * Opening the overlay's live thread from the sidebar is an implicit hand-off:
   * route its events to the main window and drop the overlay/HUD so the two views
   * don't diverge. Runs before the server reads the thread (chats:open), and its
   * throws are the ones the renderer sees.
   */
  async function threadOpened(threadId: string): Promise<void> {
    if (!overlay.owns(threadId)) return;
    const captured = await captureQuickChatHandoff(threadId);
    if (!captured) {
      // A simultaneous explicit Open-in-Stem action may already have completed
      // the same transition and cancelled this sidebar request.
      if (!overlay.handedOff) {
        showQuickChat(false);
        throw new Error('Quick Chat did not return a handoff snapshot. Try Open in Stem again.');
      }
      return;
    }
    // Flip ownership before removing the event barrier. Events arriving
    // before commit stay buffered; events arriving after it route directly
    // to the main renderer.
    const flippedHere = overlay.claimHandoff();
    const transition = overlayHandoffBarrier.commit(captured.id);
    if (!transition) {
      // An explicit handoff may have won while this handler was awaiting the
      // snapshot. Only restore ownership when no other path completed it.
      if (flippedHere) {
        overlay.revertHandoff();
        showQuickChat(false);
        throw new Error('Quick Chat handoff was interrupted. Try Open in Stem again.');
      }
      return;
    }
    overlay.stopTurn();
    hideHud();
    hideOverlayWindow();
    deps.sendToMain('quickchat:adopt', transition.snapshot);
    for (const bufferedEvent of transition.events) {
      deps.sendToMain('backend:event', bufferedEvent);
      noteMainThreadEvent(bufferedEvent.method, threadId);
    }
  }

  function routeBackendEvent(event: BackendEventEnvelope): boolean {
    const threadId = (event.params as { threadId?: string } | undefined)?.threadId;
    // The overlay owns its live thread until hand-off: route its events to the
    // overlay window (which renders the conversation) and the status HUD, NOT the
    // main window — otherwise the main window would build a phantom user-less slice.
    const overlayOwned = overlay.owns(threadId);
    const handoffBuffered = !!threadId && overlayHandoffBarrier.buffer(threadId, event);
    if (handoffBuffered) {
      // captureQuickChatHandoff replays these immediately after the atomic snapshot.
      return true;
    }
    if (overlayOwned) {
      sendToOverlay('backend:event', event);
      driveHud(event);
      return true;
    }
    if (!threadId) {
      // Process-level events (e.g. process/exit) carry no threadId — let both
      // windows clear their run state, and clear the follow-me pill so a backend
      // crash never leaves a stuck "Working…" pill.
      const abandonedHandoffEvents = overlayHandoffBarrier.cancelCurrent();
      for (const bufferedEvent of abandonedHandoffEvents) {
        sendToOverlay('backend:event', bufferedEvent);
        driveHud(bufferedEvent);
      }
      deps.sendToMain('backend:event', event);
      sendToOverlay('backend:event', event);
      runningMainThreads.clear();
      if (event.method === 'process/exit' && (overlay.turnRunning || overlayResetBarrier.pending)) {
        overlay.restore(failQuickChatProcess(Date.now(), overlay.threadId));
        if (hud.owner === 'quickchat') showHud({ phase: 'finished', label: 'Request failed' }, 'quickchat');
        if (overlayResetBarrier.pending) finishOverlayReset();
      }
      if (hud.owner === 'main') hideHud();
      return false;
    }
    deps.sendToMain('backend:event', event);
    noteMainThreadEvent(event.method, threadId);
    return false;
  }

  /**
   * Run a prompt in the overlay's own thread. For a fresh session we pre-create
   * the thread (so its events route correctly from the very first event), then
   * hide the overlay and raise the HUD — the disappear→HUD half of the cycle.
   */
  async function runQuickChat(prompt: QuickChatPrompt): Promise<StartTurnResult> {
    // Start the disappear→HUD half of the cycle immediately — before the (async)
    // thread creation — so the overlay never flashes the half-laid-out panel.
    overlay.beginTurn(Date.now());
    // Hide just the overlay (NOT app.hide — that would also hide the HUD we're
    // about to show, and re-showing the HUD would reactivate the app and surface
    // the main window). The overlay is a non-activating panel, so hiding it does
    // not promote the main window. The HUD is non-focusable, so it never steals
    // focus from whatever app the user is in.
    hideOverlayWindow();
    showHud({ phase: 'working', label: 'Working…' }, 'quickchat');

    try {
      const continuing = overlay.owns(prompt.threadId);
      let threadId = continuing ? overlay.threadId! : null;
      if (!threadId) {
        threadId = (await deps.invoke('backend:createThread', [prompt.model ?? undefined])) as string;
        overlay.adoptThread(threadId);
        // Before the turn, so no event of it can outrun the claim.
        // Optimistic sidebar row so the quickchat thread shows immediately.
        deps.sendToMain('quickchat:sessionStarted', {
          threadId,
          title: prompt.input.trim() || 'New chat'
        });
      }

      // `surface` is the whole of what makes this a Quick Chat turn: the server
      // resolves the Quick Chat web-search toggle and the main+quickChat
      // instruction composition from it (see backend:startTurn).
      const result = (await deps.invoke('backend:startTurn', [
        {
          input: prompt.input,
          turnId: prompt.turnId,
          threadId,
          model: prompt.model ?? undefined,
          effort: prompt.effort ?? undefined,
          serviceTier: prompt.serviceTier,
          format: prompt.format,
          surface: 'quickChat',
          attachments: prompt.attachments
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
        if (result.canceled) hideHud();
        else showHud({ phase: 'finished', label: 'Answer ready' }, 'quickchat');
      }
      return result;
    } catch (e) {
      overlay.settleTurn(Date.now());
      hideHud();
      if (overlayResetBarrier.pending) finishOverlayReset();
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
        showQuickChat(false);
      }
      throw e;
    }
  }

  return {
    start(settings) {
      // Seed the all-Spaces flag before creating the overlay so it's applied once,
      // at creation.
      overlayOnAllDisplays = settings.showOnAllDisplays;
      newThreadTimeoutMs = settings.newThreadTimeoutMs;
      followAcrossSpaces = settings.followAcrossSpaces;
      finishSound = settings.finishSound;
      // Pre-create both windows (hidden) so the shortcut summons instantly, and
      // bind the global accelerator from the saved settings.
      ensureOverlayWindow();
      ensureHudWindow();
      applyQuickChatShortcut(settings.shortcut);
    },

    registerIpc() {
      ipcMain.on('quickchat:handoffSnapshot', (event, id: string, payload: QuickChatHandoff) => {
        const win = overlayWindow;
        if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
        overlayHandoffBarrier.supply(id, payload);
      });

      handleLocal('quickchat:shortcutStatus', () => quickChatShortcutStatus());
      handleLocal('quickchat:run', (_e, prompt: QuickChatPrompt) => runQuickChat(prompt));

      // Forget the current overlay thread so the next prompt opens a fresh one.
      handleLocal('quickchat:newThread', () => {
        overlay.prepareManualReset();
        hideHud();
        if (overlay.turnRunning) {
          return overlayResetBarrier.wait();
        } else {
          finishOverlayReset();
        }
      });

      // Hand the conversation off to the main window: route future events there,
      // reveal the main window, and have it adopt the thread as the active chat.
      handleLocal('quickchat:handoff', (_e, payload: QuickChatHandoff) => {
        const bufferedEvents = overlayHandoffBarrier.cancelCurrent();
        overlay.claimHandoff();
        overlay.stopTurn();
        if (overlayResetBarrier.pending) finishOverlayReset();
        hideHud();
        hideOverlayWindow();
        deps.revealMainWindow();
        deps.sendToMain('quickchat:adopt', payload);
        for (const bufferedEvent of bufferedEvents) {
          deps.sendToMain('backend:event', bufferedEvent);
          noteMainThreadEvent(bufferedEvent.method, payload.threadId);
        }
      });

      // Re-summon the overlay (HUD click). Same path as the shortcut.
      handleLocal('quickchat:reveal', () => {
        if (!overlayWindow?.isVisible()) toggleQuickChat();
      });

      // Raise the main window (follow-me pill click). Returning focus to the main
      // window fires the 'focus' handler, which hides the pill.
      handleLocal('main:reveal', () => deps.revealMainWindow());

      handleLocal('quickchat:hide', () => {
        dismissQuickChat();
      });
    },

    toggle: toggleQuickChat,

    overlayVisible: () => overlayWindow?.isVisible() ?? false,

    applySettings(patch, next) {
      if ('shortcut' in patch) applyQuickChatShortcut(next.shortcut);
      if ('showOnAllDisplays' in patch) {
        overlayOnAllDisplays = next.showOnAllDisplays;
        applyOverlayWorkspaceVisibility();
      }
      if ('newThreadTimeoutMs' in patch) newThreadTimeoutMs = next.newThreadTimeoutMs;
      if ('followAcrossSpaces' in patch) {
        followAcrossSpaces = next.followAcrossSpaces;
        if (!followAcrossSpaces && hud.owner === 'main') hideHud();
      }
      if ('finishSound' in patch) finishSound = next.finishSound;
    },

    shortcutStatus: quickChatShortcutStatus,

    sendToOverlay,

    revealIfOwns(threadId) {
      // Quick Chat hides itself while a turn runs. Bring the originating surface
      // back so mounting a card actually makes the confirmation visible.
      if (threadId && overlay.owns(threadId)) showQuickChat(false);
    },

    routeBackendEvent,
    threadOpened,
    syncMainHud,

    hideMainHud() {
      if (hud.owner === 'main') hideHud();
    }
  };
}
