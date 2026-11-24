// Voice chat: OpenAI's realtime voice model on the user's ChatGPT subscription.
//
// The client owns the audio (a WebRTC peer connection with the microphone and
// an `oai-events` data channel); the server only answers its SDP offer, so the
// ChatGPT token never leaves this process and a thin client reaches it through
// the ordinary /rpc channel. The realtime model is only the voice: every real
// request goes back through its `ask_stem` tool, which the client runs as an
// ordinary turn in the open chat (memory, personas, tools, transcript).
//
// Money: measured 2026-10-25, a ChatGPT-token realtime call draws on the
// plan's Codex usage budget and left the account's paid credit balance
// untouched. Past the plan's limit OpenAI bills credits instead, so every
// connect — and the client's periodic check during a call — refuses once the
// plan window is spent, or when it cannot be read at all.

import type { PlanUsage, PlanUsageWindow, VoiceAllowance } from '../../shared/types';
import { ASK_STEM_TOOL } from '../../shared/voice';

export const REALTIME_CALLS_URL = 'https://api.openai.com/v1/realtime/calls';
export const PLAN_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
export const VOICE_MODEL = 'gpt-realtime';
export const VOICE_NAME = 'marin';

const AUTH_CLAIM = 'https://api.openai.com/auth';

type Fetch = typeof fetch;

/** The ChatGPT account id carried in a Codex access token (a JWT). */
export function accountIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
      string,
      { chatgpt_account_id?: unknown } | undefined
    >;
    const id = payload[AUTH_CLAIM]?.chatgpt_account_id;
    return typeof id === 'string' && id.trim() ? id : null;
  } catch {
    // quiet: a token without the claim simply has no account header to send.
    return null;
  }
}

function authHeaders(token: string): Record<string, string> {
  const account = accountIdFromToken(token);
  return { Authorization: `Bearer ${token}`, ...(account ? { 'chatgpt-account-id': account } : {}) };
}

export const VOICE_INSTRUCTIONS = [
  "You are the voice of Stem, the user's personal assistant. You are only the voice. Stem itself, reached through the ask_stem tool, holds the user's memory, chats, mail, files, tools, web access and judgment.",
  '- Call ask_stem for every request except pure small talk (greetings, thanks, "can you hear me"). That includes questions you think you can answer: Stem knows the user and you do not.',
  "- Pass the request in the user's own words and language, complete, with anything from earlier in this conversation it depends on. Do not answer it, turn it into a different question, or add assumptions.",
  '- Before calling, say a very short acknowledgement of two to four words, such as "Let me check.", then call. Stem can take a while.',
  "- When ask_stem returns, speak its reply. Keep its facts and substance exactly. Never add to it, contradict it, or say you cannot do something Stem did. Make it sound spoken: no markdown, links, tables or code; read lists naturally; give a long reply in a few sentences and offer the rest.",
  '- If ask_stem returns an error, say in one sentence that it did not work and why.',
  '- While Stem is still working on a request, a new request goes to ask_stem too; Stem answers them in order.',
  "- Speak the user's language. Be brief and warm."
].join('\n');

/** The session the call starts with — sent with the SDP offer, so audio can flow at once. */
export function voiceSession(): Record<string, unknown> {
  return {
    type: 'realtime',
    model: VOICE_MODEL,
    instructions: VOICE_INSTRUCTIONS,
    audio: {
      input: {
        // The overlay shows what was heard; the model itself listens to the audio.
        transcription: { model: 'gpt-4o-mini-transcribe' },
        noise_reduction: { type: 'near_field' },
        turn_detection: { type: 'semantic_vad' }
      },
      output: { voice: VOICE_NAME }
    },
    tools: [
      {
        type: 'function',
        name: ASK_STEM_TOOL,
        description:
          "Hand the user's request to Stem, which does the real work and returns its reply text. Takes seconds to minutes.",
        parameters: {
          type: 'object',
          properties: { request: { type: 'string', description: "The user's request, in their words and language." } },
          required: ['request']
        }
      }
    ],
    tool_choice: 'auto'
  };
}

export type PlanAllowance = VoiceAllowance;

/**
 * Whether the ChatGPT plan's own usage window still has room. Anything short
 * of a readable "allowed, not reached" answer is a refusal: past the limit
 * voice would be paid from credits, which the user ruled out.
 */
export async function planAllowance(token: string, fetchImpl: Fetch = fetch): Promise<PlanAllowance> {
  let body: { rate_limit?: { allowed?: unknown; limit_reached?: unknown } };
  try {
    const res = await fetchImpl(PLAN_USAGE_URL, { headers: authHeaders(token), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, reason: `Couldn't read your ChatGPT plan usage (HTTP ${res.status}).` };
    body = (await res.json()) as typeof body;
  } catch (e) {
    // quiet: the refusal carries the reason to the user, who sees it on the voice button.
    return { ok: false, reason: `Couldn't read your ChatGPT plan usage (${e instanceof Error ? e.message : String(e)}).` };
  }
  const limit = body.rate_limit;
  if (!limit || typeof limit.allowed !== 'boolean') return { ok: false, reason: "Couldn't read your ChatGPT plan usage." };
  if (limit.limit_reached === true || limit.allowed === false) {
    return { ok: false, reason: "Your ChatGPT plan's usage limit is reached. Voice chat comes back when it resets." };
  }
  return { ok: true };
}

function readWindow(raw: unknown, now: number): PlanUsageWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const w = raw as Record<string, unknown>;
  const used = w.used_percent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  const seconds = typeof w.limit_window_seconds === 'number' && w.limit_window_seconds > 0 ? w.limit_window_seconds : null;
  // reset_at is epoch seconds; reset_after_seconds is the fallback some answers carry.
  const resetsAt =
    typeof w.reset_at === 'number' && w.reset_at > 0
      ? w.reset_at * 1000
      : typeof w.reset_after_seconds === 'number' && w.reset_after_seconds >= 0
        ? now + w.reset_after_seconds * 1000
        : null;
  return { windowSeconds: seconds, usedPercent: Math.min(100, Math.max(0, used)), resetsAt };
}

/**
 * The plan's usage windows as ChatGPT reports them: the primary (5-hour) and
 * secondary (weekly) window, each with the share spent and when it resets.
 * The same unofficial endpoint the Codex CLI's /status reads.
 */
export async function planUsage(token: string, fetchImpl: Fetch = fetch, now = Date.now()): Promise<PlanUsage> {
  let body: { plan_type?: unknown; rate_limit?: Record<string, unknown> | null };
  try {
    const res = await fetchImpl(PLAN_USAGE_URL, { headers: authHeaders(token), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { ok: false, reason: `ChatGPT did not return plan usage (HTTP ${res.status}).` };
    body = (await res.json()) as typeof body;
  } catch (e) {
    // quiet: the reason is shown in Settings where the usage would be.
    return { ok: false, reason: `Couldn't read plan usage (${e instanceof Error ? e.message : String(e)}).` };
  }
  const limit = body.rate_limit;
  if (!limit || typeof limit !== 'object') return { ok: false, reason: 'ChatGPT returned no usage windows.' };
  const windows = [readWindow(limit.primary_window, now), readWindow(limit.secondary_window, now)].filter(
    (w): w is PlanUsageWindow => w !== null
  );
  if (!windows.length) return { ok: false, reason: 'ChatGPT returned no usage windows.' };
  return {
    ok: true,
    plan: typeof body.plan_type === 'string' && body.plan_type ? body.plan_type : null,
    limitReached: limit.limit_reached === true || limit.allowed === false,
    windows
  };
}

/** Answer the client's WebRTC offer: start the call and return OpenAI's SDP answer. */
export async function openVoiceCall(token: string, offerSdp: string, fetchImpl: Fetch = fetch): Promise<string> {
  const form = new FormData();
  form.set('sdp', offerSdp);
  form.set('session', JSON.stringify(voiceSession()));
  const res = await fetchImpl(REALTIME_CALLS_URL, {
    method: 'POST',
    headers: authHeaders(token),
    body: form,
    signal: AbortSignal.timeout(20_000)
  });
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
      if (typeof message === 'string') detail = message;
    } catch {
      // quiet: a non-JSON error body is shown as it came.
    }
    throw new Error(`OpenAI refused the voice call (HTTP ${res.status}): ${detail}`);
  }
  if (!text.startsWith('v=')) throw new Error('OpenAI answered the voice call without an SDP answer.');
  return text;
}
