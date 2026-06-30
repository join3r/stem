import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type {
  AppSettings,
  CustomInstructionsSettings,
  EscapeAction,
  MemoryModelSettings,
  NativeWebSearchSettings,
  PartialRetrievalSettings,
  QuickChatSettings,
  RetrievalEndpointSettings,
  RetrievalSettings,
  SkillsModelSettings
} from '../../shared/types';
import { settingsStorePath } from './paths';

// Stem-owned app settings. Like the chat store, kept deliberately tiny and
// resilient — a corrupt/missing file degrades to defaults rather than breaking
// startup. The defaults match the product spec: medium effort, Fast speed, and
// the overlay floating across all displays; the shortcut is unset until the
// user records one in Settings.

const DEFAULTS: AppSettings = {
  quickChat: {
    shortcut: null,
    defaultModel: null,
    defaultEffort: 'medium',
    defaultServiceTier: 'priority',
    showOnAllDisplays: true,
    // After 5 minutes idle, re-summoning the overlay starts a fresh thread.
    newThreadTimeoutMs: 5 * 60_000,
    // Show the progress pill for main-window threads when the main window loses
    // focus (switch Spaces/apps), so an active thread stays visible.
    followAcrossSpaces: true,
    // Opt-in chime when a turn finishes while the pill is visible.
    finishSound: false
  },
  // Native web search defaults on for both contexts; surfaced in the UI only when
  // the relevant model's provider supports it (currently ChatGPT/openai-codex).
  nativeWebSearch: { main: true, quickChat: true },
  // Memory distillation/tidy-up model; null = the backend default.
  memory: { model: null },
  // Background skills-curator model; null = the backend default. Separate from the
  // memory model so curation (which can be a harder task) can use a stronger model.
  skills: { model: null },
  // Embeddings + reranker endpoints for relevance-ranking facts at inject time.
  // Off by default: until the user points these at a server, fact selection stays
  // recency-based (no network). Default URL/model match a local Ollama setup.
  retrieval: {
    embeddings: { baseUrl: 'http://localhost:11434', model: 'qwen3-embedding:8b', apiKey: null, enabled: false },
    reranker: { baseUrl: 'http://localhost:8080', model: '', apiKey: null, enabled: false }
  },
  // Escape-to-retract is opt-in: off until the user picks single/two-stage.
  escapeAction: 'off',
  // Standing custom instructions; empty until the user (or Stem) sets them.
  customInstructions: { main: '', quickChat: '' }
};

const ESCAPE_ACTIONS: readonly EscapeAction[] = ['off', 'single', 'twoStage'];

function coerceEndpoint(
  raw: Partial<RetrievalEndpointSettings> | undefined,
  def: RetrievalEndpointSettings
): RetrievalEndpointSettings {
  const r = raw ?? {};
  return {
    baseUrl: typeof r.baseUrl === 'string' && r.baseUrl.trim() ? r.baseUrl.trim() : def.baseUrl,
    model: typeof r.model === 'string' ? r.model.trim() : def.model,
    apiKey: typeof r.apiKey === 'string' && r.apiKey.trim() ? r.apiKey : null,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled
  };
}

function coerce(parsed: Partial<AppSettings> | null): AppSettings {
  const qc = (parsed?.quickChat ?? {}) as Partial<QuickChatSettings>;
  const d = DEFAULTS.quickChat;
  const rawNws = (parsed?.nativeWebSearch ?? {}) as Partial<NativeWebSearchSettings>;
  const nws: NativeWebSearchSettings = {
    main: typeof rawNws.main === 'boolean' ? rawNws.main : DEFAULTS.nativeWebSearch.main,
    quickChat: typeof rawNws.quickChat === 'boolean' ? rawNws.quickChat : DEFAULTS.nativeWebSearch.quickChat
  };
  const rawMem = (parsed?.memory ?? {}) as Partial<MemoryModelSettings>;
  const mem: MemoryModelSettings = {
    model: typeof rawMem.model === 'string' && rawMem.model.trim() ? rawMem.model : null
  };
  const rawSkills = (parsed?.skills ?? {}) as Partial<SkillsModelSettings>;
  const skills: SkillsModelSettings = {
    model: typeof rawSkills.model === 'string' && rawSkills.model.trim() ? rawSkills.model : null
  };
  const rawRet = (parsed?.retrieval ?? {}) as Partial<RetrievalSettings>;
  const retrieval: RetrievalSettings = {
    embeddings: coerceEndpoint(rawRet.embeddings, DEFAULTS.retrieval.embeddings),
    reranker: coerceEndpoint(rawRet.reranker, DEFAULTS.retrieval.reranker)
  };
  const escapeAction: EscapeAction = ESCAPE_ACTIONS.includes(parsed?.escapeAction as EscapeAction)
    ? (parsed!.escapeAction as EscapeAction)
    : DEFAULTS.escapeAction;
  const rawCi = (parsed?.customInstructions ?? {}) as Partial<CustomInstructionsSettings>;
  const customInstructions: CustomInstructionsSettings = {
    main: typeof rawCi.main === 'string' ? rawCi.main : DEFAULTS.customInstructions.main,
    quickChat: typeof rawCi.quickChat === 'string' ? rawCi.quickChat : DEFAULTS.customInstructions.quickChat
  };
  return {
    quickChat: {
      shortcut: typeof qc.shortcut === 'string' && qc.shortcut.trim() ? qc.shortcut : null,
      defaultModel: typeof qc.defaultModel === 'string' && qc.defaultModel.trim() ? qc.defaultModel : null,
      defaultEffort: typeof qc.defaultEffort === 'string' ? qc.defaultEffort : d.defaultEffort,
      // 'priority' (Fast) or explicit null (Standard); anything else → default.
      defaultServiceTier:
        qc.defaultServiceTier === 'priority' ? 'priority' : qc.defaultServiceTier === null ? null : d.defaultServiceTier,
      showOnAllDisplays: typeof qc.showOnAllDisplays === 'boolean' ? qc.showOnAllDisplays : d.showOnAllDisplays,
      newThreadTimeoutMs:
        typeof qc.newThreadTimeoutMs === 'number' && qc.newThreadTimeoutMs >= 0
          ? qc.newThreadTimeoutMs
          : d.newThreadTimeoutMs,
      followAcrossSpaces: typeof qc.followAcrossSpaces === 'boolean' ? qc.followAcrossSpaces : d.followAcrossSpaces,
      finishSound: typeof qc.finishSound === 'boolean' ? qc.finishSound : d.finishSound
    },
    nativeWebSearch: nws,
    memory: mem,
    skills,
    retrieval,
    escapeAction,
    customInstructions
  };
}

export async function readSettings(): Promise<AppSettings> {
  try {
    return coerce(JSON.parse(await readFile(settingsStorePath(), 'utf8')) as Partial<AppSettings>);
  } catch {
    return coerce(null);
  }
}

// Serialize writes through a promise chain (see chats.ts) so concurrent IPC
// can't interleave a read-modify-write and lose updates.
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function writeSettings(settings: AppSettings): Promise<void> {
  const path = settingsStorePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
  await rename(tmp, path);
}

/** Patch the Quick Chat settings and persist atomically; returns the full settings. */
export function updateQuickChat(patch: Partial<QuickChatSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, quickChat: { ...cur.quickChat, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the per-context native-web-search toggles and persist; returns full settings. */
export function updateNativeWebSearch(patch: Partial<NativeWebSearchSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, nativeWebSearch: { ...cur.nativeWebSearch, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Set the main-composer Escape-to-retract behavior and persist; returns full settings. */
export function updateEscapeAction(action: EscapeAction): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, escapeAction: action });
    await writeSettings(next);
    return next;
  });
}

/** Patch the memory-model setting and persist; returns the full settings. */
export function updateMemorySettings(patch: Partial<MemoryModelSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, memory: { ...cur.memory, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the standing custom instructions (per surface) and persist; returns full settings. */
export function updateCustomInstructions(patch: Partial<CustomInstructionsSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, customInstructions: { ...cur.customInstructions, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the skills-curator model setting and persist; returns the full settings. */
export function updateSkillsSettings(patch: Partial<SkillsModelSettings>): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({ ...cur, skills: { ...cur.skills, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the retrieval endpoints (deep-merged per stage) and persist; returns full settings. */
export function updateRetrievalSettings(patch: PartialRetrievalSettings): Promise<AppSettings> {
  return enqueue(async () => {
    const cur = await readSettings();
    const next = coerce({
      ...cur,
      retrieval: {
        embeddings: { ...cur.retrieval.embeddings, ...patch.embeddings },
        reranker: { ...cur.retrieval.reranker, ...patch.reranker }
      }
    });
    await writeSettings(next);
    return next;
  });
}
