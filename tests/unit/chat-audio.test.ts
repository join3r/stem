// Sounds share_audio puts in a chat: the store copies them out of the places
// the assistant may read, normalize forwards only a ref, the reducer puts it on
// the turn's bubble, and a reopened chat rebuilds the same refs.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { deleteChatAudio, readChatAudio, shareAudio, sniffAudioMime } from '../../src/server/files/chat-audio';
import type { BrowserSourceDeps } from '../../src/server/files/browser-sources';
import { threadWorkspaceDir, workspaceRoot } from '../../src/server/workspace/paths';
import { PiRuntime } from '../../src/server/pi/runtime';
import { newTurnContext, normalizePiEvent } from '../../src/server/pi/normalize';
import { applyBackendEventToThread, type ThreadState } from '../../src/shared/chatState';
import type { BackendEventEnvelope } from '../../src/shared/types';

const store = mkdtempSync(join(tmpdir(), 'stem-chat-audio-'));
const prevStore = process.env.STEM_CHAT_AUDIO_DIR;
process.env.STEM_CHAT_AUDIO_DIR = store;
const outside = mkdtempSync(join(tmpdir(), 'stem-chat-audio-outside-'));

const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.alloc(32)]);

const deps: BrowserSourceDeps = {
  findThreadImage: async () => null,
  readRoots: () => [workspaceRoot(), threadWorkspaceDir('').replace(/\/$/, '')]
};

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
afterAll(async () => {
  if (prevStore === undefined) delete process.env.STEM_CHAT_AUDIO_DIR;
  else process.env.STEM_CHAT_AUDIO_DIR = prevStore;
  await rm(store, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('sniffAudioMime', () => {
  it('knows the formats the chat plays and nothing else', () => {
    expect(sniffAudioMime(MP3)).toBe('audio/mpeg');
    expect(sniffAudioMime(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe('audio/mpeg');
    expect(sniffAudioMime(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toBe('audio/aac');
    expect(sniffAudioMime(WAV)).toBe('audio/wav');
    expect(sniffAudioMime(Buffer.from('OggS\0\0\0\0'))).toBe('audio/ogg');
    expect(sniffAudioMime(Buffer.from('fLaC\0\0\0\0'))).toBe('audio/flac');
    expect(sniffAudioMime(Buffer.from('\0\0\0\x20ftypM4A \0\0'))).toBe('audio/mp4');
    expect(sniffAudioMime(Buffer.from('\0\0\0\x20ftypqt  \0\0'))).toBeNull();
    expect(sniffAudioMime(Buffer.from('89504e470d0a1a0a', 'hex'))).toBeNull();
    expect(sniffAudioMime(Buffer.from('hello world'))).toBeNull();
  });
});

describe('shareAudio', () => {
  it('copies a scratch sound into the store and serves it by id', async () => {
    mkdirSync(threadWorkspaceDir('thread-a'), { recursive: true });
    writeFileSync(join(threadWorkspaceDir('thread-a'), 'clip.mp3'), MP3);
    const res = await shareAudio('thread-a', { from: 'clip.mp3', title: '  Datacenters\n· 03:50–07:30 ' }, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.audio).toMatchObject({ threadId: 'thread-a', mime: 'audio/mpeg', title: 'Datacenters · 03:50–07:30', bytes: MP3.length });
    expect(res.audio.id).toMatch(/^aud_[0-9a-f]{10}$/);
    // A later change to the source does not change what the chat plays.
    writeFileSync(join(threadWorkspaceDir('thread-a'), 'clip.mp3'), WAV);
    const hit = await readChatAudio('thread-a', res.audio.id);
    expect(hit?.mime).toBe('audio/mpeg');
    expect(hit?.data.equals(MP3)).toBe(true);
    // Only its own thread, only real ids.
    expect(await readChatAudio('thread-b', res.audio.id)).toBeNull();
    expect(await readChatAudio('thread-a', '../x')).toBeNull();
    expect(await readChatAudio('../thread-a', res.audio.id)).toBeNull();
    await deleteChatAudio('thread-a');
    expect(await readChatAudio('thread-a', res.audio.id)).toBeNull();
  });

  it('refuses files that are not sounds and files outside the readable places', async () => {
    mkdirSync(threadWorkspaceDir('thread-a'), { recursive: true });
    writeFileSync(join(threadWorkspaceDir('thread-a'), 'notes.txt'), 'not a sound');
    const txt = await shareAudio('thread-a', { from: 'notes.txt' }, deps);
    expect(!txt.ok && txt.error).toContain('not an audio file');
    writeFileSync(join(outside, 'secret.mp3'), MP3);
    const out = await shareAudio('thread-a', { from: join(outside, 'secret.mp3') }, deps);
    expect(out.ok).toBe(false);
    const none = await shareAudio('thread-a', {}, deps);
    expect(!none.ok && none.error).toContain('Pass `from`');
  });
});

const stemAudio = { id: 'aud_0a1b2c3d4e', mime: 'audio/mpeg', title: 'Clip', bytes: 67 };

function toolResult(id = 'call-1') {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'share_audio',
    content: [{ type: 'text', text: 'Shared.' }],
    details: { stemAudio },
    isError: false
  };
}

describe('normalize + reducer: share_audio', () => {
  it('forwards the ref and puts it on an audio-only bubble once', () => {
    const ctx = newTurnContext('thread-1', 'turn-1');
    normalizePiEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'share_audio', args: { from: 'clip.mp3' } }, ctx);
    const ended = normalizePiEvent(
      { type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'share_audio', result: toolResult(), isError: false },
      ctx
    ).events;
    const done = ended.find((e) => e.method === 'item/completed')!;
    const item = (done.params as { item: { audio?: unknown } }).item;
    expect(item.audio).toEqual({ ...stemAudio, threadId: 'thread-1' });

    const base = {
      messages: [{ id: 'user-1', role: 'user', content: 'cut it', turnId: 'turn-1' }],
      running: true,
      streamingId: null,
      activity: null,
      activities: [{ id: 'call-1', kind: 'tool', type: 'mcpToolCall', name: 'share_audio', status: 'running' }],
      activeTurnId: 'turn-1',
      status: 'running'
    } as unknown as ThreadState;
    const completed = { method: 'item/completed', params: { threadId: 'thread-1', turnId: 'turn-1', item } } as BackendEventEnvelope;
    let s = applyBackendEventToThread(base, completed)!;
    expect(s.messages.find((m) => m.id === 'assistant-turn-1')!.audio?.map((a) => a.id)).toEqual(['aud_0a1b2c3d4e']);
    s = applyBackendEventToThread({ ...s, activities: s.activities.map((a) => ({ ...a, status: 'running' as const })) }, completed)!;
    expect(s.messages.find((m) => m.id === 'assistant-turn-1')!.audio).toHaveLength(1);
  });
});

describe('readThread: share_audio', () => {
  it('puts the sound on the reply that follows it, and keeps an audio-only reply', async () => {
    const root = await mkdtemp(join(tmpdir(), 'stem-audio-history-'));
    cleanup.push(root);
    const sessions = join(root, 'pi', 'sessions');
    const workspace = join(root, 'workspace');
    await Promise.all([mkdir(sessions, { recursive: true }), mkdir(workspace, { recursive: true })]);
    const runtime = new PiRuntime({ piHome: join(root, 'pi'), sessionsDir: sessions, workspaceRoot: workspace, seedGlobalAuth: false });
    const lines = [
      { type: 'session', id: 'aud-session', timestamp: '2026-11-07T10:00:00.000Z', cwd: '/tmp' },
      { type: 'message', id: 'u1', message: { role: 'user', content: [{ type: 'text', text: 'Cut it' }] } },
      { type: 'message', id: 'a1', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'share_audio', arguments: {} }] } },
      { type: 'message', id: 't1', message: toolResult() },
      { type: 'message', id: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'Here is the clip.' }], stopReason: 'stop' } },
      { type: 'message', id: 'u2', message: { role: 'user', content: [{ type: 'text', text: 'Another' }] } },
      { type: 'message', id: 'a3', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-2', name: 'share_audio', arguments: {} }] } },
      { type: 'message', id: 't2', message: { ...toolResult('call-2'), details: { stemAudio: { ...stemAudio, id: 'aud_ffffffffff' } } } }
    ];
    await writeFile(join(sessions, 's.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n'));
    const { messages } = await runtime.readThread('aud-session');
    const replies = messages.filter((m) => m.role === 'assistant');
    expect(replies[0].content).toBe('Here is the clip.');
    expect(replies[0].audio).toEqual([{ ...stemAudio, threadId: 'aud-session' }]);
    expect(replies.map((m) => m.audio?.map((a) => a.id))).toEqual([['aud_0a1b2c3d4e'], ['aud_ffffffffff']]);
  });
});
