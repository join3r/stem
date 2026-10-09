import { globalShortcut } from 'electron';
import { randomUUID } from 'node:crypto';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { host } from '../../server/host';
import { log } from '../../server/log';
import type { ComputerAccess, RecordedStep, RecorderState, RecordingDraft, RecordingExample } from '../../shared/types';
import { HelperProcess, oneShot, resolveHelperPath, type HelperEvent, type HelperReply } from '../computer-host/helper';
import { buildExample, describeStep, linkTag } from './bundle';
import { linkValues, stepValue, type SeenText, type Shot } from './matcher';
import { createRecorderPill, type RecorderPill } from './pill';

// The skill recorder on this Mac: the person presses Record in a chat, does
// the task the way they always do, presses Stop, and the chat gets a draft
// skill. This owns the helper in record mode, the pill, the ⌃⌥R shortcut and
// the raw recording; the server only ever sees what buildExample() keeps.
// The raw folder (window pictures) is deleted as soon as the author has had it.
// While recording, every event is appended to the folder's events.jsonl, so a
// quit or crash mid-recording loses nothing: the next time the server is
// reachable, recover() writes the leftover up like a Stop would have.

/** A recording is cut off here: nobody demonstrates a task for longer. */
const MAX_RECORDING_MS = 30 * 60_000;
const SHORTCUT = 'Control+Alt+R';
const RECENT = 5;
/** A leftover recording older than this is dropped, not written up. */
const RECOVER_FOR_MS = 7 * 24 * 60 * 60_000;
const NO_SHOTS_NOTE = 'Screen Recording was off, so no pictures were kept; values only a picture could explain were not traced.';
const QUIT_NOTE = 'Stem quit before this recording was stopped, so its last steps may be missing.';

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
  /** Write up recordings a quit or crash left behind; called whenever the server is reachable. */
  recover(): Promise<void>;
  close(): void;
}

/** What a recording's folder holds besides its pictures, enough to write it up after a quit. */
interface Meta {
  threadId: string;
  draftId: string | null;
  startedAt: number;
}

type Logged =
  | { k: 'step'; step: RecordedStep }
  | { k: 'seen'; seen: SeenText }
  | { k: 'shot'; shot: Shot }
  | { k: 'note'; note: string };

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
  /** Said to the person on the pill and to the author with the recording. */
  notes: string[];
  events: WriteStream;
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

  // Nothing can be recording at launch: a folder without its meta.json is
  // junk and goes now; one with it waits for recover(). start() waits for this
  // so the sweep can never take a new recording's folder.
  const swept = supported ? sweep().catch(() => undefined) : Promise.resolve();
  let recovering: Promise<void> | null = null;
  /** Folders a recording in this run still owns (starting, recording, being written up): never recovered. */
  const live = new Set<string>();

  async function sweep(): Promise<void> {
    for (const name of await readdir(root()).catch(() => [] as string[])) {
      const dir = join(root(), name);
      if (!(await stat(join(dir, 'meta.json')).catch(() => null))) await rm(dir, { recursive: true, force: true });
    }
  }

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
      warning: s.notes.includes(NO_SHOTS_NOTE) ? 'No pictures' : null,
      recent: s.steps.slice(-RECENT).map(describeStep)
    });
  }

  function keep(s: Session, entry: Logged): void {
    s.events.write(`${JSON.stringify(entry)}\n`);
  }

  function onEvent(s: Session, event: HelperEvent): void {
    if (session !== s) return;
    switch (event.event) {
      case 'rec-step': {
        const step = event.step;
        s.steps.push(step);
        keep(s, { k: 'step', step });
        // Trace a value at once, so the pill can show the link the author will see.
        s.tag = stepValue(step) ? linkTag(linkValues([step], s.seen, [], new Date(s.startedAt)).links[0]) : step.kind === 'switch' ? s.tag : null;
        publish({ steps: s.steps.length, lastStep: describeStep(step) });
        paint();
        break;
      }
      case 'rec-seen': {
        const seen = { t: event.seen.t, app: event.seen.app, window: event.seen.window, url: event.seen.url, text: event.seen.text };
        s.seen.push(seen);
        keep(s, { k: 'seen', seen });
        // Keep memory bounded on a long recording: the oldest texts go first.
        if (s.seen.length > 400) s.seen.splice(0, s.seen.length - 400);
        break;
      }
      case 'rec-shot':
        s.shots.push(event.shot);
        keep(s, { k: 'shot', shot: event.shot });
        break;
      case 'rec-note':
        log('recorder', 'helper note', { note: event.note, code: event.code });
        if (event.code === 'no-shots' && !s.notes.includes(NO_SHOTS_NOTE)) {
          s.notes.push(NO_SHOTS_NOTE);
          keep(s, { k: 'note', note: NO_SHOTS_NOTE });
          paint();
        }
        break;
      case 'rec-press':
        pill.pressAt(event.x, event.y);
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
    live.add(dir);
    try {
      return await open(threadId, draftId, id, dir);
    } catch (e) {
      live.delete(dir);
      throw e;
    }
  }

  async function open(threadId: string, draftId: string | null, id: string, dir: string): Promise<RecorderState> {
    await mkdir(join(dir, 'shots'), { recursive: true, mode: 0o700 });
    const startedAt = Date.now();
    const meta: Meta = { threadId, draftId, startedAt };
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta), { mode: 0o600 });
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
      startedAt,
      pausedAt: null,
      pausedMs: 0,
      steps: [],
      seen: [],
      shots: [],
      notes: [],
      events: createWriteStream(join(dir, 'events.jsonl'), { flags: 'a', mode: 0o600 }),
      tag: null,
      tick: setInterval(paint, 1000),
      cutoff: setTimeout(() => void stop(), MAX_RECORDING_MS)
    };
    helper.onEvent((event) => onEvent(s, event));
    const reply = await helper.call('record-start', { shotsDir: join(dir, 'shots') });
    if (!reply.ok) {
      clearInterval(s.tick);
      clearTimeout(s.cutoff);
      s.events.end();
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
    await new Promise<void>((done) => s.events.end(done));
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
      await drop(s.dir);
      return publish({ ...IDLE, threadId: s.threadId, error: 'Nothing was recorded — no clicks or typing happened.' });
    }
    const example = buildExample({ steps: s.steps, seen: s.seen, shots: s.shots, startedAt: new Date(s.startedAt), durationMs, notes: s.notes });
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
      await drop(s.dir);
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
    const step: RecordedStep = { kind: 'note', t: Date.now() - s.startedAt, app: last?.app ?? '', window: last?.window ?? '', text };
    s.steps.push(step);
    keep(s, { k: 'step', step });
    publish({ steps: s.steps.length, lastStep: `Note: ${text}` });
    paint();
  }

  async function cancel(): Promise<RecorderState> {
    const s = session;
    if (!s) return current;
    await finish(s);
    await drop(s.dir);
    deps.revealMain();
    return publish({ ...IDLE, threadId: s.threadId });
  }

  async function drop(dir: string): Promise<void> {
    await rm(dir, { recursive: true, force: true });
    live.delete(dir);
  }

  /** Rebuild a leftover folder's recording from its events.jsonl; null when there is nothing to write up. */
  async function readLeftover(dir: string): Promise<{ meta: Meta; example: RecordingExample } | null> {
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as Meta;
    if (typeof meta.threadId !== 'string' || typeof meta.startedAt !== 'number') return null;
    if (Date.now() - meta.startedAt > RECOVER_FOR_MS) return null;
    const steps: RecordedStep[] = [];
    const seen: SeenText[] = [];
    const shots: Shot[] = [];
    const notes: string[] = [];
    const raw = await readFile(join(dir, 'events.jsonl'), 'utf8').catch(() => '');
    for (const line of raw.split('\n')) {
      let entry: Logged;
      try {
        entry = JSON.parse(line) as Logged;
      } catch {
        continue; // the line being written when the app went down
      }
      if (entry.k === 'step') steps.push(entry.step);
      else if (entry.k === 'seen') seen.push(entry.seen);
      else if (entry.k === 'shot') shots.push(entry.shot);
      else if (entry.k === 'note') notes.push(entry.note);
    }
    if (!steps.some((step) => step.kind !== 'switch')) return null;
    const durationMs = Math.max(0, ...steps.map((step) => step.t));
    return { meta, example: buildExample({ steps, seen: seen.slice(-400), shots, startedAt: new Date(meta.startedAt), durationMs, notes: [...notes, QUIT_NOTE] }) };
  }

  async function recoverAll(): Promise<void> {
    await swept;
    for (const name of await readdir(root()).catch(() => [] as string[])) {
      const dir = join(root(), name);
      if (live.has(dir)) continue;
      let leftover: Awaited<ReturnType<typeof readLeftover>>;
      try {
        leftover = await readLeftover(dir);
      } catch {
        leftover = null;
      }
      if (!leftover) {
        await rm(dir, { recursive: true, force: true });
        continue;
      }
      log('recorder', 'writing up a recording a quit left behind', { threadId: leftover.meta.threadId, steps: leftover.example.steps.length });
      try {
        await deps.invoke('skills:record', [leftover.meta.threadId, leftover.example, leftover.meta.draftId]);
        await rm(dir, { recursive: true, force: true });
      } catch (e) {
        // Kept for the next reconnect (until RECOVER_FOR_MS): the server may be mid-restart.
        log('recorder', 'could not write up the left-behind recording', { error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  return {
    start,
    stop,
    togglePause,
    cancel,
    access,
    state: () => current,
    recover() {
      if (!supported) return Promise.resolve();
      recovering ??= recoverAll().finally(() => {
        recovering = null;
      });
      return recovering;
    },
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
        // Kept: its folder has every event so far, and recover() writes it up
        // the next time the server is reachable.
        log('recorder', 'Stem quit during a recording; kept for the next launch', { threadId: s.threadId, steps: s.steps.length });
        clearInterval(s.tick);
        clearTimeout(s.cutoff);
        s.events.end();
        s.helper.kill();
        session = null;
      }
      pill.destroy();
    }
  };
}
