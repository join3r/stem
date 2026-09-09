import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { QuickChatSettings, StartTurnInput } from '../../src/shared/types';

const mock = vi.hoisted(() => {
  const window = () => ({
    visible: false,
    focused: false,
    isDestroyed: () => false,
    isVisible() { return this.visible; },
    isFocused() { return this.focused; },
    showInactive() { this.visible = true; },
    hide() { this.visible = false; },
    on: vi.fn(),
    webContents: { send: vi.fn() }
  });
  return { window, hud: window(), overlay: window(), chime: vi.fn(),
    handlers: new Map<string, (...args: unknown[]) => unknown>() };
});
vi.mock('../../src/desktop/quickchat/windows', () => ({
  createHudWindow: () => mock.hud,
  createOverlayWindow: () => mock.overlay,
  placeHud: vi.fn(), placeOverlay: vi.fn(), setOverlayWorkspaceVisibility: vi.fn()
}));
vi.mock('../../src/desktop/platform', () => ({
  isWaylandSession: () => false, playFinishChime: mock.chime,
  presentOverlayWindow: () => { mock.overlay.visible = true; }, quickChatSummonCommand: () => 'stem'
}));
vi.mock('../../src/desktop/ipc-bridge', () => ({
  handleLocal: (name: string, fn: (...args: unknown[]) => unknown) => mock.handlers.set(name, fn)
}));

import { createQuickChat } from '../../src/desktop/quickchat';

const settings: QuickChatSettings = {
  shortcut: null, defaultModel: null, defaultEffort: 'medium', defaultServiceTier: null,
  showOnAllDisplays: true, newThreadTimeoutMs: 300000, followAcrossSpaces: true, finishSound: true
};
beforeEach(() => {
  mock.hud.visible = false;
  mock.overlay.visible = false;
  mock.hud.webContents.send.mockClear();
  mock.chime.mockClear();
  mock.handlers.clear();
});

function fixture() {
  const main = mock.window();
  const surface = createQuickChat({
    mainWindow: () => main as unknown as BrowserWindow,
    sendToMain: vi.fn(), revealMainWindow: vi.fn(), installNavigationGuards: vi.fn(), beginSummon: vi.fn(),
    invoke: async (channel, args) => {
      if (channel === 'backend:createThread') return 'chat';
      const input = args[0] as StartTurnInput;
      surface.submitHudTurn(input);
      surface.acceptHudTurn(input.turnId!);
      return { threadId: 'chat', turnId: input.turnId };
    }
  });
  surface.start(settings);
  surface.registerIpc();
  surface.reconcileHud('mac', []);
  const event = (method: string, turnId: string, kind = 'interactive', deviceId = 'mac') =>
    surface.routeBackendEvent({ method, receivedAt: new Date().toISOString(),
      params: { threadId: 'chat', ...(method.startsWith('turn/') ? { turn: { id: turnId } } : { turnId }), origin: { kind, deviceId }, item: { type: 'reasoning' } } });
  return { surface, main, event };
}

describe('the shared HUD window', () => {
  it('never shows or chimes for mail, jobs, or another device, including after a local chat', () => {
    const { surface, event } = fixture();
    for (const [kind, device] of [['mail', 'mac'], ['background', 'mac'], ['interactive', 'phone']]) {
      event('item/started', kind, kind, device);
      event('turn/completed', kind, kind, device);
      expect(mock.hud.visible).toBe(false);
    }
    event('item/started', 'local');
    expect(mock.hud.visible).toBe(true);
    event('turn/completed', 'local');
    expect(mock.chime).toHaveBeenCalledTimes(1);
    surface.hideMainHud();
    event('item/started', 'job', 'background');
    event('turn/completed', 'job', 'background');
    expect(mock.hud.visible).toBe(false);
    expect(mock.chime).toHaveBeenCalledTimes(1);
  });

  it('hides across disconnect and replay, then silently clears a missed completion', () => {
    const { surface, event } = fixture();
    event('item/started', 'local');
    surface.disconnectHud();
    expect(mock.hud.visible).toBe(false);
    event('item/started', 'local');
    event('turn/completed', 'local');
    expect(mock.hud.visible).toBe(false);
    surface.reconcileHud('mac', []);
    surface.syncMainHud();
    expect(mock.hud.visible).toBe(false);
    expect(mock.chime).not.toHaveBeenCalled();
  });

  it('restores a verified local chat after startup and respects main-window focus', () => {
    const { surface, main } = fixture();
    main.focused = true;
    surface.reconcileHud('mac', [{ threadId: 'chat', turnId: 'restored', origin: { kind: 'interactive', deviceId: 'mac' } }]);
    expect(mock.hud.visible).toBe(false);
    main.focused = false;
    surface.syncMainHud();
    expect(mock.hud.visible).toBe(true);
    expect(mock.chime).not.toHaveBeenCalled();
  });

  it('does not let a later background run in the overlay conversation revive Quick Chat', async () => {
    const { event } = fixture();
    await mock.handlers.get('quickchat:run')!(undefined, { input: 'hello', turnId: 'quick' });
    event('item/started', 'quick');
    event('turn/completed', 'quick');
    const count = mock.hud.webContents.send.mock.calls.length;
    event('item/started', 'job', 'background');
    event('turn/completed', 'job', 'background');
    expect(mock.hud.webContents.send).toHaveBeenCalledTimes(count);
    expect(mock.chime).toHaveBeenCalledTimes(1);
  });

  it('assigns a trackable ID when a Quick Chat caller omits one', async () => {
    const { event } = fixture();
    const result = await mock.handlers.get('quickchat:run')!(undefined, { input: 'hello' }) as { turnId: string };
    expect(result.turnId).toBeTruthy();
    event('item/started', result.turnId);
    event('turn/completed', result.turnId);
    expect(mock.hud.webContents.send).toHaveBeenLastCalledWith('quickchat:status',
      expect.objectContaining({ label: 'Answer ready' }));
  });

  it('settles Quick Chat when failure arrives before any activity', async () => {
    const { event } = fixture();
    await mock.handlers.get('quickchat:run')!(undefined, { input: 'hello', turnId: 'quick' });
    event('turn/failed', 'quick');
    expect(mock.hud.webContents.send).toHaveBeenLastCalledWith('quickchat:status',
      expect.objectContaining({ label: 'Request failed', phase: 'finished' }));
  });

  it('clears a disconnected Quick Chat without a false answer-ready notification', async () => {
    const { event, surface } = fixture();
    await mock.handlers.get('quickchat:run')!(undefined, { input: 'hello', turnId: 'quick' });
    event('item/started', 'quick');
    surface.disconnectHud();
    event('turn/completed', 'quick');
    surface.reconcileHud('mac', []);
    expect(mock.hud.visible).toBe(false);
    expect(mock.chime).not.toHaveBeenCalled();
  });

  it('keeps the local turn eligible when Quick Chat hands it to the main window', async () => {
    const { event, surface } = fixture();
    await mock.handlers.get('quickchat:run')!(undefined, { input: 'hello', turnId: 'quick' });
    event('item/started', 'quick');
    await mock.handlers.get('quickchat:handoff')!(undefined, { threadId: 'chat' });
    expect(mock.hud.visible).toBe(false);
    surface.syncMainHud();
    expect(mock.hud.visible).toBe(true);
    event('turn/completed', 'quick');
    expect(mock.hud.webContents.send).toHaveBeenLastCalledWith('quickchat:status',
      expect.objectContaining({ label: 'Answer ready', reveal: 'main' }));
    expect(mock.chime).toHaveBeenCalledTimes(1);
  });
});
