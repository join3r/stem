import { globalShortcut } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { host } from '../../server/host';
import { log } from '../../server/log';
import type { ComputerAccess, RecordedStep, RecorderState, RecordingDraft } from '../../shared/types';
import { HelperProcess, oneShot, resolveHelperPath, type HelperEvent, type HelperReply } from '../computer-host/helper';
import { buildExample, describeStep, linkTag } from './bundle';
import { linkValues, stepValue, type SeenText, type Shot } from './matcher';
import { createRecorderPill, type RecorderPill } from './pill';

// The skill recorder on this Mac: the person presses Record in a chat, does
// the task the way they always do, presses Stop, and the chat gets a draft
// skill. This owns the helper in record mode, the pill, the ⌃⌥R shortcut and
// the raw recording; the server only ever sees what buildExample() keeps.
// The raw folder (window pictures) is deleted as soon as the author has had it.

/** A recording is cut off here: nobody demonstrates a task for longer. */
const MAX_RECORDING_MS = 30 * 60_000;
const SHORTCUT = 'Control+Alt+R';
const RECENT = 5;

export interface RecorderHelper {
  call(cmd: string, fields?: Record<string, unknown>, timeoutMs?: number): Promise<HelperReply>;
  onEvent(listener: (event: HelperEvent) => void): () => void;
  kill(): void;
}

export interface RecorderDeps {
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  /** Push the state to the main window. */
  send(state: RecorderState): void;
  /** The shortcut was pressed with nothing recording: show Stem and its Record sheet. */
  openSheet(): void;
  hideMain(): void;
  revealMain(): void;
  helpers?: {
    spawn(): Promise<RecorderHelper>;
    oneShot(cmd: string): Promise<HelperReply>;
  };
  pill?: (handlers: Parameters<typeof createRecorderPill>[0]) => RecorderPill;
  recordingsRoot?: () => string;
}

export interface Recorder {
  start(threadId: string, draftId: string | null): Promise<RecorderState>;
  stop(): Promise<RecorderState>;
  togglePause(): Promise<RecorderState>;
  cancel(): Promise<RecorderState>;
  state(): RecorderState;
  access(): Promise<ComputerAccess | null>;
  registerShortcut(): void;
  close(): void;
}

interface Session {
  id: string;
  threadId: string;
  draftId: string | null;
  helper: RecorderHelper;
  dir: string;
  startedAt: number;
  pausedAt: number | null;
  pausedMs: number;
  steps: RecordedStep[];
  seen: SeenText[];
  shots: Shot[];
  tag: string | null;
  tick: NodeJS.Timeout;
  cutoff: NodeJS.Timeout;
}

const realHelpers: NonNullable<RecorderDeps['helpers']> = {
  spawn: async () => new HelperProcess(await resolveHelperPath()),
  oneShot: (cmd) => oneShot(cmd)
};

const IDLE: RecorderState = { phase: 'idle', threadId: null, draftId: null, startedAt: null, steps: 0, lastStep: null, error: null };

export function createRecorder(deps: RecorderDeps): Recorder {
  const supported = process.platform === 'darwin';
  const helpers = deps.helpers ?? realHelpers;
  const root = deps.recordingsRoot ?? (() => join(host().stateRoot(), 'recordings'));
  let session: Session | null = null;
  /** A start in flight: a double press must not spawn two recorders. */
  let starting = false;
  let current: RecorderState = IDLE;
  const pill = (deps.pill ?? createRecorderPill)({
    stop: () => void stop(),
    togglePause: () => void togglePause(),
    note: (text) => addNote(text)
  });

  // Nothing can be recording at launch: whatever a crash left behind goes.
  // start() waits for it so the sweep can never take a new recording's folder.
  const swept = supported ? rm(root(), { recursive: true, force: true }).catch(() => undefined) : Promise.resolve();

  function publish(next: Partial<RecorderState>): RecorderState {
    current = { ...current, ...next };
    deps.send(current);
    return current;
  }

  function elapsed(s: Session): number {
    const now = s.pausedAt ?? Date.now();
    return Math.max(0, now - s.startedAt - s.pausedMs);
  }

  function clock(ms: number): string {
    const sec = Math.floor(ms / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function paint(): void {
    const s = session;
    if (!s) return;
    const last = s.steps[s.steps.length - 1];
    pill.render({
      paused: s.pausedAt !== null,
      time: clock(elapsed(s)),
      text: s.pausedAt !== null ? 'Paused — nothing is recorded' : last ? describeStep(last) : 'Recording — do the task as usual',
      tag: s.pausedAt !== null ? null : s.tag,
      recent: s.steps.slice(-RECENT).map(describeStep)
    });
  }

  function onEvent(s: Session, event: HelperEvent): void {
    if (session !== s) return;
    switch (event.event) {
      case 'rec-step': {
        const step = event.step;
        s.steps.push(step);
        // Trace a value at once, so the pill can show the link the author will see.
        s.tag = stepValue(step) ? linkTag(linkValues([step], s.seen, [], new Date(s.startedAt)).links[0]) : step.kind === 'switch' ? s.tag : null;
        publish({ steps: s.steps.length, lastStep: describeStep(step) });
        paint();
        break;
      }
      case 'rec-seen':
        s.seen.push({ t: event.seen.t, app: event.seen.app, window: event.seen.window, url: event.seen.url, text: event.seen.text });
        // Keep memory bounded on a long recording: the oldest texts go first.
        if (s.seen.length > 400) s.seen.splice(0, s.seen.length - 400);
        break;
      case 'rec-shot':
        s.shots.push(event.shot);
        break;
      case 'rec-note':
        log('recorder', 'helper note', { note: event.note });
        break;
      default:
        break;
    }
  }

  async function access(): Promise<ComputerAccess | null> {
    if (!supported) return null;
    try {
      const reply = await helpers.oneShot('status');
      return reply.ok && reply.status ? reply.status : null;
    } catch {
      return null;
    }
  }

  async function start(threadId: string, draftId: string | null): Promise<RecorderState> {
    if (!supported) throw new Error('Recording a skill needs the Mac app.');
    if (session || starting) throw new Error('A recording is already running.');
    if (current.phase === 'authoring') throw new Error('Stem is still writing the last recording up.');
    starting = true;
    try {
      return await begin(threadId, draftId);
    } finally {
      starting = false;
    }
  }

  async function begin(threadId: string, draftId: string | null): Promise<RecorderState> {
    await swept;
    const id = randomUUID();
    const dir = join(root(), id);
    await mkdir(join(dir, 'shots'), { recursive: true, mode: 0o700 });
    let helper: RecorderHelper;
    try {
      helper = await helpers.spawn();
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    }
    const s: Session = {
      id,
      threadId,
      draftId,
      helper,
      dir,
      startedAt: Date.now(),
      pausedAt: null,
      pausedMs: 0,
      steps: [],
      seen: [],
      shots: [],
      tag: null,
      tick: setInterval(paint, 1000),
      cutoff: setTimeout(() => void stop(), MAX_RECORDING_MS)
    };
    helper.onEvent((event) => onEvent(s, event));
    const reply = await helper.call('record-start', { shotsDir: join(dir, 'shots') });
    if (!reply.ok) {
      clearInterval(s.tick);
      clearTimeout(s.cutoff);
      helper.kill();
      await rm(dir, { recursive: true, force: true });
      throw new Error(reply.error ?? 'The recorder did not start.');
    }
    session = s;
    log('recorder', 'started', { threadId, draftId });
    publish({ ...IDLE, phase: 'recording', threadId, draftId, startedAt: s.startedAt });
    deps.hideMain();
    pill.show();
    paint();
    return current;
  }

  async function finish(s: Session): Promise<void> {
    clearInterval(s.tick);
    clearTimeout(s.cutoff);
    await s.helper.call('record-stop', {}, 5000).catch(() => undefined);
    s.helper.kill();
    pill.hide();
    session = null;
  }

  async function stop(): Promise<RecorderState> {
    const s = session;
    if (!s) return current;
    const durationMs = elapsed(s);
    await finish(s);
    deps.revealMain();
    if (!s.steps.some((step) => step.kind !== 'switch')) {
      await rm(s.dir, { recursive: true, force: true });
      return publish({ ...IDLE, threadId: s.threadId, error: 'Nothing was recorded — no clicks or typing happened.' });
    }
    const example = buildExample({ steps: s.steps, seen: s.seen, shots: s.shots, startedAt: new Date(s.startedAt), durationMs });
    log('recorder', 'stopped', { steps: example.steps.length, links: example.links.length, unmatched: example.unmatched.length });
    publish({ phase: 'authoring', steps: example.steps.length });
    try {
      await deps.invoke('skills:record', [s.threadId, example, s.draftId]) as RecordingDraft;
      publish({ ...IDLE, threadId: s.threadId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log('recorder', 'authoring failed', { error: message });
      publish({ ...IDLE, threadId: s.threadId, error: `Could not write the skill: ${message}` });
    } finally {
      await rm(s.dir, { recursive: true, force: true });
    }
    return current;
  }

  async function togglePause(): Promise<RecorderState> {
    const s = session;
    if (!s) return current;
    const pausing = s.pausedAt === null;
    await s.helper.call('record-pause', { paused: pausing }, 5000);
    if (pausing) s.pausedAt = Date.now();
    else {
      s.pausedMs += Date.now() - (s.pausedAt ?? Date.now());
      s.pausedAt = null;
    }
    paint();
    return publish({ phase: pausing ? 'paused' : 'recording' });
  }

  function addNote(text: string): void {
    const s = session;
    if (!s) return;
    const last = s.steps[s.steps.length - 1];
    // The helper's clock: milliseconds since start, pauses included.
    s.steps.push({ kind: 'note', t: Date.now() - s.startedAt, app: last?.app ?? '', window: last?.window ?? '', text });
    publish({ steps: s.steps.length, lastStep: `Note: ${text}` });
    paint();
  }

  async function cancel(): Promise<RecorderState> {
    const s = session;
    if (!s) return current;
    await finish(s);
    await rm(s.dir, { recursive: true, force: true });
    deps.revealMain();
    return publish({ ...IDLE, threadId: s.threadId });
  }

  return {
    start,
    stop,
    togglePause,
    cancel,
    access,
    state: () => current,
    registerShortcut() {
      if (!supported) return;
      try {
        const ok = globalShortcut.register(SHORTCUT, () => {
          if (session) void stop();
          else {
            deps.revealMain();
            deps.openSheet();
          }
        });
        if (!ok) log('recorder', 'shortcut refused by the OS', { accelerator: SHORTCUT });
      } catch (e) {
        log('recorder', 'shortcut registration failed', { error: String(e) });
      }
    },
    close() {
      const s = session;
      if (s) {
        clearInterval(s.tick);
        clearTimeout(s.cutoff);
        s.helper.kill();
        session = null;
        void rm(s.dir, { recursive: true, force: true });
      }
      pill.destroy();
    }
  };
}
