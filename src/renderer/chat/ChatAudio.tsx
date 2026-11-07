import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Check, Download, Pause, Play, TriangleAlert } from 'lucide-react';
import type { ChatAudioRef } from '../../shared/types';

// Sounds share_audio put in a chat, shown under the assistant reply as a
// player card: play/pause, a waveform you can click or drag to seek, the time,
// and Download. Like GeneratedImage, the history and the event stream carry
// only refs; each card fetches its bytes once over `chats:audio`.
//
// The bytes become a blob: URL for an <audio> element (the CSP allows blob:
// media and nothing remote), and the waveform comes from decoding the same
// bytes once with Web Audio.

const BARS = 72;
const CACHE_MAX_ENTRIES = 16;

interface Loaded {
  dataUrl: string;
  url: string;
  peaks: number[] | null;
  duration: number | null;
}

const cache = new Map<string, Loaded>();
const inflight = new Map<string, Promise<Loaded | null>>();

function remember(key: string, value: Loaded): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const gone = cache.get(oldest);
    cache.delete(oldest);
    // Revoke only what no card on screen still plays: a mounted card keeps its own Loaded.
    if (gone) setTimeout(() => URL.revokeObjectURL(gone.url), 60_000);
  }
}

function bytesOf(dataUrl: string): { mime: string; bytes: Uint8Array<ArrayBuffer> } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1], bytes };
}

/** Peak level per bar, 0..1, from the decoded samples. Null when the browser cannot decode it. */
async function peaksOf(bytes: Uint8Array<ArrayBuffer>): Promise<{ peaks: number[]; duration: number } | null> {
  const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(bytes.slice().buffer);
    const data = buf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / BARS));
    const peaks: number[] = [];
    for (let b = 0; b < BARS; b++) {
      let max = 0;
      const end = Math.min(data.length, (b + 1) * step);
      // Every 8th sample is plenty for a bar's height.
      for (let i = b * step; i < end; i += 8) max = Math.max(max, Math.abs(data[i]!));
      peaks.push(max);
    }
    const top = Math.max(...peaks, 0.001);
    return { peaks: peaks.map((p) => Math.max(0.08, p / top)), duration: buf.duration };
  } catch {
    // quiet: no waveform; the card still plays through <audio>.
    return null;
  } finally {
    void ctx.close().catch(() => undefined);
  }
}

function load(ref: ChatAudioRef): Promise<Loaded | null> {
  const key = `${ref.threadId}/${ref.id}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  let pending = inflight.get(key);
  if (!pending) {
    pending = window.stem
      .getChatAudio(ref.threadId, ref.id)
      .then(async (res) => {
        const raw = res?.dataUrl ? bytesOf(res.dataUrl) : null;
        if (!res || !raw) return null;
        const url = URL.createObjectURL(new Blob([raw.bytes], { type: raw.mime }));
        const wave = await peaksOf(raw.bytes);
        const loaded: Loaded = { dataUrl: res.dataUrl, url, peaks: wave?.peaks ?? null, duration: wave?.duration ?? null };
        remember(key, loaded);
        return loaded;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  return pending;
}

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Only one card plays at a time: starting one pauses the one before. */
let playing: HTMLAudioElement | null = null;

export function ChatAudioCard({ audio }: { audio: ChatAudioRef }) {
  const key = `${audio.threadId}/${audio.id}`;
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(() => cache.get(key));
  const [isPlaying, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const el = useRef<HTMLAudioElement>(null);
  const dragging = useRef(false);
  const title = audio.title || 'Audio';

  useEffect(() => {
    let live = true;
    const hit = cache.get(key);
    if (hit) {
      setLoaded(hit);
      return;
    }
    setLoaded(undefined);
    load(audio).then(
      (l) => live && setLoaded(l),
      () => live && setLoaded(null)
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ref's identity
  }, [key]);

  // Leaving the chat stops the sound; the element is gone with the card.
  useEffect(
    () => () => {
      const a = el.current;
      if (a && playing === a) playing = null;
      a?.pause();
    },
    []
  );

  const total = duration ?? loaded?.duration ?? null;

  if (loaded === null) {
    return (
      <div className="chat-audio chat-audio-failed">
        <TriangleAlert size={16} />
        <span>This audio is no longer available</span>
      </div>
    );
  }

  const toggle = () => {
    const a = el.current;
    if (!a || !loaded) return;
    if (a.paused) {
      if (playing && playing !== a) playing.pause();
      playing = a;
      void a.play().catch(() => setPlaying(false));
    } else a.pause();
  };

  const seekTo = (fraction: number) => {
    const a = el.current;
    if (!a || !total) return;
    a.currentTime = Math.min(total, Math.max(0, fraction * total));
    setTime(a.currentTime);
  };

  const fractionAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return r.width ? (e.clientX - r.left) / r.width : 0;
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!total) return;
    const step = e.shiftKey ? 15 : 5;
    if (e.key === 'ArrowRight') seekTo((time + step) / total);
    else if (e.key === 'ArrowLeft') seekTo((time - step) / total);
    else if (e.key === 'Home') seekTo(0);
    else if (e.key === 'End') seekTo(1);
    else if (e.key === ' ' || e.key === 'Enter') toggle();
    else return;
    e.preventDefault();
  };

  const save = () => {
    if (!loaded) return;
    window.stem.saveAudioToDownloads(loaded.dataUrl, title).then(
      () => setFlash('Saved to Downloads'),
      (e: unknown) => setFlash(String((e as Error)?.message ?? e))
    );
    setTimeout(() => setFlash(null), 1800);
  };

  const progress = total ? Math.min(1, time / total) : 0;
  const peaks = loaded?.peaks ?? Array.from({ length: BARS }, () => 0.3);

  return (
    <div className={`chat-audio${loaded ? '' : ' chat-audio-loading'}`}>
      {loaded && (
        <audio
          ref={el}
          src={loaded.url}
          preload="metadata"
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
          onTimeUpdate={(e) => !dragging.current && setTime(e.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={(e) => {
            setPlaying(false);
            e.currentTarget.currentTime = 0;
            setTime(0);
          }}
        />
      )}
      <button
        type="button"
        className="chat-audio-play"
        aria-label={isPlaying ? `Pause ${title}` : `Play ${title}`}
        title={isPlaying ? 'Pause' : 'Play'}
        disabled={!loaded}
        onClick={toggle}
      >
        {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
      </button>
      <div className="chat-audio-body">
        <div className="chat-audio-title" title={title}>
          {title}
        </div>
        <div className="chat-audio-row">
          <div
            className="chat-audio-wave"
            role="slider"
            tabIndex={loaded ? 0 : -1}
            aria-label={`Seek in ${title}`}
            aria-valuemin={0}
            aria-valuemax={Math.round(total ?? 0)}
            aria-valuenow={Math.round(time)}
            aria-valuetext={clock(time)}
            onKeyDown={onKey}
            onPointerDown={(e) => {
              if (!total) return;
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              seekTo(fractionAt(e));
            }}
            onPointerMove={(e) => dragging.current && seekTo(fractionAt(e))}
            onPointerUp={() => {
              dragging.current = false;
            }}
            onPointerCancel={() => {
              dragging.current = false;
            }}
          >
            {peaks.map((p, i) => (
              <span
                key={i}
                className={(i + 0.5) / peaks.length <= progress ? 'played' : undefined}
                style={{ height: `${Math.round(p * 100)}%` }}
              />
            ))}
          </div>
          <span className="chat-audio-time">{total ? (time > 0 ? `${clock(time)} / ${clock(total)}` : clock(total)) : '–:––'}</span>
          <button type="button" className="chat-audio-save" title="Save to Downloads" aria-label={`Save ${title} to Downloads`} disabled={!loaded} onClick={save}>
            {flash === 'Saved to Downloads' ? <Check size={16} /> : <Download size={16} />}
          </button>
        </div>
        {flash && flash !== 'Saved to Downloads' && <div className="chat-audio-error">{flash}</div>}
      </div>
    </div>
  );
}

/** Every sound of one assistant turn. */
export function ChatAudioList({ audio }: { audio?: ChatAudioRef[] }) {
  if (!audio?.length) return null;
  return (
    <div className="chat-audio-list">
      {audio.map((a) => (
        <ChatAudioCard key={a.id} audio={a} />
      ))}
    </div>
  );
}
