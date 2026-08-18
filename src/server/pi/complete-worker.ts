import { join } from 'node:path';
import type { PiInvocation } from './locate';
import { emptyCompleteError } from './complete-errors';
import { PiProcess, stderrReason, type PiEvent } from './rpc';

// Shared helpers for one-shot LLM completes (exec safety judge, Recall distill).
// Kept out of PiRuntime so readiness + prompt ack can be unit-tested without a
// full Electron spawn. The warm worker lives in PiRuntime; this module runs one
// prompt on an already-started PiProcess (or cold-starts a throwaway child).

/** Budget for get_state after spawn — fail fast instead of burning the LLM timer. */
export const COMPLETE_READY_TIMEOUT_MS = 20_000;

/**
 * Queue a complete() waiter. Priority entries (the exec safety judge) insert
 * before the first non-priority waiter, so a burst of Recall distills cannot
 * leave a command's safety check waiting behind all of them.
 */
export function insertCompleteWaiter<T extends { priority: boolean }>(waiters: T[], entry: T): void {
  if (!entry.priority) {
    waiters.push(entry);
    return;
  }
  const idx = waiters.findIndex((w) => !w.priority);
  if (idx === -1) waiters.push(entry);
  else waiters.splice(idx, 0, entry);
}

export const COMPLETE_SYSTEM_PROMPT =
  'You are a precise extraction engine. Follow the instructions exactly and output only what is requested.';

export interface CompleteChildOptions {
  pi: PiInvocation;
  cwd: string;
  env: NodeJS.ProcessEnv;
  provider: string;
  modelId: string;
}

/** Spawn a --no-session complete child, start it, and wait until get_state succeeds. */
export async function spawnReadyCompleteChild(opts: CompleteChildOptions): Promise<PiProcess> {
  const child = new PiProcess({
    command: opts.pi.command,
    prefixArgs: opts.pi.prefixArgs,
    cwd: opts.cwd,
    env: opts.env,
    args: [
      '--no-session',
      '--no-builtin-tools',
      '--no-skills',
      '--provider',
      opts.provider,
      '--model',
      opts.modelId,
      '--system-prompt',
      COMPLETE_SYSTEM_PROMPT
    ]
  });
  child.start();
  try {
    const state = await child.request({ type: 'get_state' }, COMPLETE_READY_TIMEOUT_MS);
    if (!state.success) {
      throw new Error(state.error ?? 'pi complete worker failed get_state.');
    }
  } catch (e) {
    const reason = stderrReason(child.stderr);
    // quiet: the throw below carries why the worker never came up, which is the
    // error worth having. dispose() already resolves on exit with a SIGKILL
    // backstop, so what a rejection here could leave is a child whose pipes are
    // closed and which the app's own exit reaps.
    void child.dispose().catch(() => {});
    const err = e instanceof Error ? e : new Error(String(e));
    if (reason && !err.message.includes(reason)) {
      throw new Error(`${err.message} pi said: ${reason}`);
    }
    throw err;
  }
  return child;
}

/**
 * Clear the worker's conversation before reusing it.
 *
 * pi RPC holds ONE in-memory session per process, and `--no-session` only stops
 * it being written to disk — it does not make prompts independent. Without this,
 * a reused worker carries every previous prompt forward: a Recall distill's
 * memory text lands in the exec judge's context (and the judge's verdicts in the
 * next distill's), and the context grows without bound until it overflows.
 *
 * Throws when pi will not reset the session; the caller must retire the worker
 * rather than prompt it again, since there is no other way to get a clean one.
 * Note that new_session also drops the model selection, so the caller has to
 * re-apply it afterwards.
 */
export async function resetCompleteConversation(child: PiProcess): Promise<void> {
  const res = await child.request({ type: 'new_session' }, COMPLETE_READY_TIMEOUT_MS);
  if (!res.success) throw new Error(res.error ?? 'pi could not reset the complete worker session.');
}

/**
 * Switch the complete child's model when it differs from the last known key.
 * Returns the new `provider/modelId` key.
 */
export async function ensureCompleteModel(
  child: PiProcess,
  provider: string,
  modelId: string,
  currentKey: string | null
): Promise<string> {
  const key = `${provider}/${modelId}`;
  if (currentKey === key) return key;
  const res = await child.request({ type: 'set_model', provider, modelId }, COMPLETE_READY_TIMEOUT_MS);
  if (!res.success) throw new Error(res.error ?? `pi could not select model "${key}".`);
  return key;
}

/**
 * Apply a reasoning level to the complete child when one is asked for.
 *
 * Returns the level now in force, for the caller to carry as its "last applied"
 * marker; `null` in means "leave it alone", and the marker is unchanged. Note
 * that `new_session` drops this along with the model selection, so the caller
 * has to clear its marker there too.
 *
 * Best-effort by design. A background job is a completion, not a thinking-level
 * negotiation: a model with no reasoning to configure, or a pi that doesn't take
 * the level, must produce an answer at whatever depth it does support rather
 * than fail the job. The level was an economy measure either way.
 */
export async function ensureCompleteThinking(
  child: PiProcess,
  level: string | null,
  currentLevel: string | null
): Promise<string | null> {
  if (!level || level === currentLevel) return currentLevel;
  const res = await child
    .request({ type: 'set_thinking_level', level }, COMPLETE_READY_TIMEOUT_MS)
    // quiet: the reason is the doc comment above — a pi that will not take the
    // level still answers the job, at whatever depth it does support.
    .catch(() => null);
  return res?.success ? level : currentLevel;
}

/**
 * Attach listeners, accept a prompt via RPC request (fail if rejected), then wait
 * for assistant text. The LLM timer starts only after the prompt is accepted.
 */
export async function promptComplete(
  child: PiProcess,
  prompt: string,
  llmTimeoutMs: number,
  logTimeout?: (info: { timeoutMs: number }) => void
): Promise<string> {
  let text = '';
  let settle!: (result: { ok: true; text: string } | { ok: false; error: Error }) => void;
  let settled = false;

  const outcome = new Promise<{ ok: true; text: string } | { ok: false; error: Error }>((resolve) => {
    settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
  });

  let timer: NodeJS.Timeout | null = null;
  const onEvent = (ev: PiEvent): void => {
    if (ev.type === 'message_end') {
      const msg = ev.message as { role?: string; content?: { type?: string; text?: string }[] } | undefined;
      if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
        const t = msg.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
        if (t) text = t;
      }
    } else if (ev.type === 'agent_end') {
      if (text) settle({ ok: true, text });
      else settle({ ok: false, error: emptyCompleteError(child.stderr) });
    }
  };
  const onExit = (): void => {
    if (text) settle({ ok: true, text });
    else settle({ ok: false, error: emptyCompleteError(child.stderr) });
  };

  child.on('event', onEvent);
  child.on('exit', onExit);

  const cleanup = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    child.off('event', onEvent);
    child.off('exit', onExit);
  };

  try {
    // Accepting a prompt is a local ack, not the completion — budget it like the
    // other RPCs. Passing llmTimeoutMs here made the worst case two full LLM
    // budgets back to back (a 60s judge blocking a tool call for 120s).
    const res = await child.request({ type: 'prompt', message: prompt }, COMPLETE_READY_TIMEOUT_MS);
    if (!res.success) {
      throw new Error(res.error ?? 'pi rejected the prompt.');
    }
    // LLM budget starts only after pi accepted the prompt (cold start is outside).
    timer = setTimeout(() => {
      logTimeout?.({ timeoutMs: llmTimeoutMs });
      settle({ ok: false, error: new Error('pi completion timed out.') });
    }, llmTimeoutMs);

    const result = await outcome;
    if (!result.ok) throw result.error;
    return result.text;
  } catch (e) {
    settle({ ok: false, error: e instanceof Error ? e : new Error(String(e)) });
    const result = await outcome;
    if (!result.ok) throw result.error;
    return result.text;
  } finally {
    cleanup();
  }
}

/** Join path for the complete child's cwd under the Stem workspace. */
export function completeInternalCwd(workspaceRoot: string): string {
  return join(workspaceRoot, '.stem-internal');
}
