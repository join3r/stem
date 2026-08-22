import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import type {
  ChatsSettings,
  ChatSubjectMode,
  CustomEmbedModel,
  CustomInstructionsSettings,
  CustomModelResult,
  CustomRerankModel,
  DefaultsSettings,
  EmbeddingsMode,
  EmbeddingsSettings,
  EscapeAction,
  ExecSettings,
  HarnessSettings,
  OnboardingSettings,
  LocalEmbedModelId,
  LocalModelDtype,
  LocalProviderApi,
  LocalProviderId,
  LocalProviderSettings,
  LocalProvidersSettings,
  LocalRerankModelId,
  MemoryModelSettings,
  WebSearchSettings,
  PartialRetrievalSettings,
  QuickChatSettings,
  RerankerMode,
  RerankerSettings,
  RetrievalSettings,
  ServerSettings,
  SkillsSettings,
  TaskNotifyMode,
  TasksSettings
} from '../../shared/types';
import { type BackgroundRole, resolveRoleEffort } from '../../shared/modelRoles';
import { degrade } from '../degrade';
import { DEFAULT_SCRATCH_TTL_DAYS } from '../exec/scratch';
import { customModelId, EMBED_CATALOG } from '../recall/embed-catalog';
import { DEFAULT_LOCAL_RERANK_MODEL, RERANK_CATALOG } from '../recall/rerank-catalog';
import { settingsStorePath } from './paths';

// Stem-owned app settings. Like the chat store, kept deliberately tiny and
// resilient — a corrupt/missing file degrades to defaults rather than breaking
// startup. The defaults match the product spec: medium effort and Fast speed.
//
// Stem-owned, and only Stem-owned. Three Quick Chat fields and the whole
// "what's new" marker used to live here and no longer do: a hotkey, an overlay's
// Spaces behavior and the version installed on a particular Mac are facts about
// a MACHINE, and a server may be answering several of them (see ClientSettings
// in shared/types.ts, stored by src/desktop/client-store.ts). `coerce` simply
// stops reading those keys, so an existing settings.json still parses and sheds
// them on its next write — after the client has taken a copy.

type QuickChatServerSettings = ServerSettings['quickChat'];

const DEFAULTS: ServerSettings = {
  quickChat: {
    defaultModel: null,
    defaultEffort: 'medium',
    defaultServiceTier: 'priority',
    // After 5 minutes idle, re-summoning the overlay starts a fresh thread.
    newThreadTimeoutMs: 5 * 60_000,
    // Opt-in chime when a turn finishes while the pill is visible.
    finishSound: false,
    // Quick chats land in the Inbox like any other thread unless opted out.
    skipInbox: false
  },
  // Web search defaults on for both contexts, on every provider. `auto` walks
  // pi-web-access's backend chain, which ends at keyless Exa MCP — so search
  // works on a fresh install with no account, no key and no configuration.
  webSearch: { main: true, quickChat: true, provider: 'auto', credentials: {} },
  // Memory distillation/tidy-up; null = the model you chat with, and its default
  // effort. Deliberately not the shared background model — see MemoryModelSettings.
  memory: { model: null, effort: null },
  // Skills model (authoring + curation); null = the model you chat with, like
  // memory — deliberately NOT the shared quick-tasks model, so making the
  // background cheap can't quietly hand skill-writing to the cheapest model.
  // `ask` is the default mode: the library this replaces was built by a pass that
  // wrote silently, and 23 of its 25 skills were never used once. Showing the user
  // what is about to be saved is the cheapest available check on that.
  skills: { model: null, effort: null, mode: 'ask' },
  // Chats: Stem writes each new thread a subject and uses it as the thread's name,
  // because the alternative default — the first 80 characters of whatever you
  // typed — is what the Inbox rows are trying to get away from. `everywhere`
  // keeps one name per thread (list, search, window title all agree); a name the
  // user typed is never overwritten in any mode. Two preview lines under each
  // Inbox row, which is what makes the list readable without opening anything.
  chats: { subjects: 'everywhere', subjectModel: null, subjectEffort: null, previewLines: 2 },
  // Scheduled tasks: a run that calls notify_user takes the screen by default —
  // the watch tasks this was built for ("tell me when the build goes red") are
  // worth an interruption, and a native OS notification was judged too easy to
  // miss. `nudge` and `inbox` are for the user who disagrees: both still leave
  // the run's chat bold in the Inbox, they just stop it grabbing focus.
  tasks: { notify: 'alert' },
  // Command execution: on by default with the tiered policy as the guard rail.
  // approvalMode is Stem-wide — it governs run_command AND the commands a
  // coding agent asks to run (harness/service.ts), even when exec.enabled is
  // off. 'assisted' = allowlist → LLM judge → approval card ('manual' skips
  // the judge, 'yolo' skips everything but the protected-roots guard);
  // judgeModel null = the shared background model, else the chat's own model;
  // the allowlist grows via the approval card's "Always allow" button.
  exec: {
    enabled: true,
    approvalMode: 'assisted',
    judgeModel: null,
    judgeEffort: null,
    allowlist: [],
    deviceAllowlists: {},
    scratchTtlDays: DEFAULT_SCRATCH_TTL_DAYS,
    // Prefer Git Bash on Windows (auto-detect bash.exe; cmd.exe if Git is missing).
    windowsShell: 'git-bash',
    gitBashPath: null
  },
  // Coding agents (coding_agent): OFF by default — an external coding agent
  // runs with the user's own logins and disk, and switching that on is the
  // user's decision, not an install default. agents holds acpx registry
  // overrides (name -> command); empty means the built-in registry.
  harness: {
    enabled: false,
    agents: {}
  },
  // Embeddings + reranker for relevance-ranking facts at inject time. Embeddings
  // default to the bundled local model (multilingual, in-process, nothing leaves
  // the machine); weights download once on first need, and until they're ready
  // fact selection stays lexical/recency-based. Remote URL/model defaults match
  // a local Ollama setup for users who switch to their own endpoint.
  retrieval: {
    embeddings: {
      mode: 'local',
      localModel: 'multilingual-e5-small',
      baseUrl: 'http://localhost:11434',
      // 4b, not 8b: measured best cross-language fact recall on Ollama (2026-07-04).
      model: 'qwen3-embedding:4b',
      apiKey: null
    },
    reranker: {
      // On by default since the reranker became the fact-injection GATE
      // (inject.ts): without it, selection degrades to the scale-free fallback
      // tiers, which recall-bench/ measured as materially worse. The model
      // (~570 MB) downloads lazily on first use; until it is ready, turns
      // degrade gracefully rather than wait.
      mode: 'local',
      localModel: 'bge-reranker-v2-m3',
      baseUrl: 'http://localhost:8080',
      model: '',
      apiKey: null
    },
    // Models the user brought themselves that Stem has no catalog entry for.
    // Empty on every install until somebody imports one.
    customEmbedModels: [],
    customRerankModels: []
  },
  // Escape-to-retract is opt-in: off until the user picks single/two-stage.
  escapeAction: 'off',
  // Standing custom instructions; empty until the user (or Stem) sets them.
  customInstructions: { main: '', quickChat: '' },
  // First-run wizard: not completed until the user signs in (or the app first
  // reaches an authenticated status, e.g. seeded from an existing ~/.pi).
  onboarding: { completed: false },
  // App-level default model ('provider/modelId'); null = built-in constant.
  // Set after onboarding to match the provider the user signed in with, and
  // rewritten every time the model picker changes — background jobs read it as
  // "the model you chat with", which is only true if it keeps up.
  // backgroundModel null = those jobs run on `model` too.
  defaults: { model: null, backgroundModel: null, backgroundEffort: null },
  // OpenAI-compatible servers (registered with the backend via the pi-home
  // models.json). Base URLs are the servers' standard defaults; disabled until
  // the user opts in. `custom` has no default URL — the user supplies it.
  localProviders: {
    ollama: { enabled: false, baseUrl: 'http://localhost:11434' },
    lmstudio: { enabled: false, baseUrl: 'http://localhost:1234' },
    custom: { enabled: false, baseUrl: '' }
  }
};

const ESCAPE_ACTIONS: readonly EscapeAction[] = ['off', 'single', 'twoStage'];
const SUBJECT_MODES: readonly ChatSubjectMode[] = ['off', 'inbox', 'everywhere'];
const TASK_NOTIFY_MODES: readonly TaskNotifyMode[] = ['alert', 'nudge', 'inbox'];

/**
 * Reasoning-effort levels a background role may be pinned to, matching the ones
 * the composer offers. Anything else — including a level saved against a model
 * that has since been replaced — coerces to null, which leaves the model on its
 * own default rather than sending pi a level it will reject.
 */
const EFFORT_LEVELS: readonly string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function coerceEffort(raw: unknown): string | null {
  return typeof raw === 'string' && EFFORT_LEVELS.includes(raw) ? raw : null;
}

// ---- imported (non-catalog) models ----
//
// Weights the user brought that Stem has no entry for, described once at import
// time and stored here. Checked as strictly as anything else that comes off
// disk, and for one extra reason: the repo id names a folder under the model
// cache, so it is the only settings string that becomes a path.

const DTYPES: readonly LocalModelDtype[] = ['q8', 'q4', 'fp32'];
const RERANK_SCORINGS: readonly CustomRerankModel['scoring'][] = ['classifier', 'causal-yes-no'];

/** `org/name` and nothing that could climb out of the model cache. */
function isSafeRepoId(repo: unknown): repo is string {
  if (typeof repo !== 'string') return false;
  const parts = repo.split('/');
  return parts.length === 2 && parts.every((p) => p !== '.' && p !== '..' && /^[A-Za-z0-9._-]+$/.test(p));
}

/** The fields both kinds share, or null when the entry can't name a model at all. */
function coerceCustomBase(
  raw: unknown
): Pick<CustomEmbedModel, 'id' | 'repo' | 'label' | 'dtype' | 'approxSizeMB'> | null {
  if (!isRecord(raw) || !isSafeRepoId(raw.repo) || !DTYPES.includes(raw.dtype as LocalModelDtype)) return null;
  const size = typeof raw.approxSizeMB === 'number' && Number.isFinite(raw.approxSizeMB) ? raw.approxSizeMB : 0;
  return {
    // Derived from the repo rather than read: one entry per model folder, and an
    // id nobody can hand-write into a collision with a catalog model.
    id: customModelId(raw.repo),
    repo: raw.repo,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : raw.repo,
    dtype: raw.dtype as LocalModelDtype,
    approxSizeMB: Math.max(0, Math.round(size))
  };
}

/** One imported embedder, or null when it is not describable. */
export function coerceCustomEmbedModel(raw: unknown): CustomEmbedModel | null {
  const base = coerceCustomBase(raw);
  if (!base) return null;
  const r = raw as Record<string, unknown>;
  const p = isRecord(r.prefixes) ? r.prefixes : {};
  return {
    ...base,
    // Only ever written by the load probe, so a missing or nonsense value means
    // "hasn't loaded yet" rather than something to fall back from.
    dim: typeof r.dim === 'number' && Number.isFinite(r.dim) && r.dim > 0 ? Math.round(r.dim) : null,
    prefixes: {
      query: typeof p.query === 'string' ? p.query : '',
      passage: typeof p.passage === 'string' ? p.passage : ''
    }
  };
}

/**
 * The curated model that scores the same way, whose floors an imported reranker
 * starts from. Borrowed, not measured: they are calibrated to another model's
 * logit scale, which is why the import dialog says so out loud.
 */
function curatedRerankFloors(scoring: CustomRerankModel['scoring']): {
  minRelevantScore: number;
  factGateScore: number;
} {
  const donor =
    Object.values(RERANK_CATALOG).find((s) => s.scoring === scoring) ?? RERANK_CATALOG[DEFAULT_LOCAL_RERANK_MODEL];
  return { minRelevantScore: donor.minRelevantScore, factGateScore: donor.factGateScore };
}

/** One imported reranker, or null when it is not describable. */
export function coerceCustomRerankModel(raw: unknown): CustomRerankModel | null {
  const base = coerceCustomBase(raw);
  if (!base) return null;
  const r = raw as Record<string, unknown>;
  const scoring = RERANK_SCORINGS.includes(r.scoring as CustomRerankModel['scoring'])
    ? (r.scoring as CustomRerankModel['scoring'])
    : 'classifier';
  const fallback = curatedRerankFloors(scoring);
  const instruct = typeof r.instruct === 'string' && r.instruct.trim() ? r.instruct.trim() : null;
  // The floors are raw logits on an unbounded scale — every finite number is a
  // legitimate answer, so being one is the whole check.
  const floor = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  return {
    ...base,
    scoring,
    ...(instruct ? { instruct } : {}),
    minRelevantScore: floor(r.minRelevantScore, fallback.minRelevantScore),
    factGateScore: floor(r.factGateScore, fallback.factGateScore)
  };
}

/** Drop unusable entries; last one wins per model, so re-importing updates rather than duplicates. */
function coerceCustomModels<T extends { id: string }>(raw: unknown, one: (v: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, T>();
  for (const entry of raw) {
    const model = one(entry);
    if (model) byId.set(model.id, model);
  }
  return [...byId.values()];
}

const RERANKER_MODES: readonly RerankerMode[] = ['off', 'local', 'remote'];
// Derived from the catalog, not written out by hand: a hand-kept copy silently
// rejected 'qwen3-reranker-0.6b' when it was added everywhere but here, and
// "selecting the new model silently reverts to the old one" is the failure mode.
const LOCAL_RERANK_MODELS: readonly LocalRerankModelId[] = Object.keys(
  RERANK_CATALOG
) as LocalRerankModelId[];

function coerceReranker(
  raw: (Partial<RerankerSettings> & { enabled?: unknown }) | undefined,
  def: RerankerSettings,
  custom: CustomRerankModel[]
): RerankerSettings {
  const r = raw ?? {};
  // Migration from the pre-mode shape ({ enabled: boolean } + endpoint fields):
  // enabled:true meant "user pointed us at their own /rerank server" → remote;
  // anything else takes the default. An explicit mode ('off' included) is
  // always preserved — defaulting the gate on must not override a user who
  // turned it off.
  const mode: RerankerMode = RERANKER_MODES.includes(r.mode as RerankerMode)
    ? (r.mode as RerankerMode)
    : r.enabled === true
      ? 'remote'
      : def.mode;
  return {
    mode,
    // Catalog ∪ imported: the set is only closed until someone brings their own
    // weights, and an id that names neither would leave the stage pointing at a
    // model nothing can describe.
    localModel:
      LOCAL_RERANK_MODELS.includes(r.localModel as LocalRerankModelId) ||
      custom.some((m) => m.id === r.localModel)
        ? (r.localModel as string)
        : def.localModel,
    baseUrl: typeof r.baseUrl === 'string' && r.baseUrl.trim() ? r.baseUrl.trim() : def.baseUrl,
    model: typeof r.model === 'string' ? r.model.trim() : def.model,
    apiKey: typeof r.apiKey === 'string' && r.apiKey.trim() ? r.apiKey : null
  };
}

const EMBEDDINGS_MODES: readonly EmbeddingsMode[] = ['off', 'local', 'remote'];
// Same rule as LOCAL_RERANK_MODELS: the catalog is the one source of truth.
const LOCAL_EMBED_MODELS: readonly LocalEmbedModelId[] = Object.keys(
  EMBED_CATALOG
) as LocalEmbedModelId[];

function coerceEmbeddings(
  raw: (Partial<EmbeddingsSettings> & { enabled?: unknown }) | undefined,
  def: EmbeddingsSettings,
  custom: CustomEmbedModel[]
): EmbeddingsSettings {
  const r = raw ?? {};
  // Migration from the pre-mode shape ({ enabled: boolean } + endpoint fields):
  // enabled:true meant "user pointed us at their own server" → remote. enabled:false
  // is indistinguishable from "never touched" (defaults persist to settings.json),
  // so it takes the new local default; an explicit Off mode remains available.
  const mode: EmbeddingsMode = EMBEDDINGS_MODES.includes(r.mode as EmbeddingsMode)
    ? (r.mode as EmbeddingsMode)
    : r.enabled === true
      ? 'remote'
      : def.mode;
  return {
    mode,
    // Catalog ∪ imported — see coerceReranker.
    localModel:
      LOCAL_EMBED_MODELS.includes(r.localModel as LocalEmbedModelId) || custom.some((m) => m.id === r.localModel)
        ? (r.localModel as string)
        : def.localModel,
    baseUrl: typeof r.baseUrl === 'string' && r.baseUrl.trim() ? r.baseUrl.trim() : def.baseUrl,
    model: typeof r.model === 'string' ? r.model.trim() : def.model,
    apiKey: typeof r.apiKey === 'string' && r.apiKey.trim() ? r.apiKey : null
  };
}

/**
 * The address `tailscale serve` publishes the bridge under, normalized to a bare
 * origin ("https://host" — no path, no trailing slash) so the pairing URL can be
 * assembled by concatenation. Anything unparseable becomes empty, which the
 * pairing panel reads as "not set up yet" rather than as a broken URL.
 */
/** True for a plain object usable as a string map (not null, not an array). */
function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function coerce(parsed: Partial<ServerSettings> | null): ServerSettings {
  const qc = (parsed?.quickChat ?? {}) as Partial<QuickChatServerSettings>;
  const d = DEFAULTS.quickChat;
  // `nativeWebSearch` is the pre-pi-web-access key name: same two per-context
  // booleans, back when search was an openai-codex-only injection. Read it as a
  // fallback so an existing install keeps whatever the user had toggled; the
  // rewritten file uses the new key and the old one simply stops being read.
  // `nativeWebSearch` is the pre-pi-web-access key name: same two per-context
  // booleans, back when search was an openai-codex-only injection. Read it as a
  // fallback so an existing install keeps whatever the user had toggled; the
  // rewritten file uses the new key and the old one simply stops being read.
  const legacy = parsed as {
    nativeWebSearch?: Partial<WebSearchSettings>;
    webSearch?: { apiKeys?: unknown; searxngUrl?: unknown };
  } | null;
  const rawWs = (parsed?.webSearch ?? legacy?.nativeWebSearch ?? {}) as Partial<WebSearchSettings>;
  // Credentials were briefly split across `apiKeys` + a `searxngUrl` that used the
  // wrong field name (pi-web-access reads `searxngBaseUrl`). Fold both into the
  // single passthrough map, so nothing the user already typed is lost.
  const rawCreds: Record<string, unknown> = {
    ...(isRecord(legacy?.webSearch?.apiKeys) ? legacy.webSearch.apiKeys : {}),
    ...(typeof legacy?.webSearch?.searxngUrl === 'string' && legacy.webSearch.searxngUrl
      ? { searxngBaseUrl: legacy.webSearch.searxngUrl }
      : {}),
    ...(isRecord(rawWs.credentials) ? rawWs.credentials : {})
  };
  const ws: WebSearchSettings = {
    main: typeof rawWs.main === 'boolean' ? rawWs.main : DEFAULTS.webSearch.main,
    quickChat: typeof rawWs.quickChat === 'boolean' ? rawWs.quickChat : DEFAULTS.webSearch.quickChat,
    provider: typeof rawWs.provider === 'string' && rawWs.provider.trim() ? rawWs.provider : DEFAULTS.webSearch.provider,
    credentials: Object.fromEntries(
      Object.entries(rawCreds).filter(([, v]) => typeof v === 'string' && v.trim())
    ) as Record<string, string>
  };
  const rawMem = (parsed?.memory ?? {}) as Partial<MemoryModelSettings>;
  const mem: MemoryModelSettings = {
    model: typeof rawMem.model === 'string' && rawMem.model.trim() ? rawMem.model : null,
    effort: coerceEffort(rawMem.effort)
  };
  const rawSkills = (parsed?.skills ?? {}) as Partial<SkillsSettings>;
  const skills: SkillsSettings = {
    model: typeof rawSkills.model === 'string' && rawSkills.model.trim() ? rawSkills.model : null,
    effort: coerceEffort(rawSkills.effort),
    // Anything unrecognized falls back to the default rather than to `off`: a
    // settings file written by an older build has no `mode` at all, and silently
    // turning the feature off for those users is the wrong failure direction.
    mode: rawSkills.mode === 'off' || rawSkills.mode === 'auto' ? rawSkills.mode : DEFAULTS.skills.mode
  };
  const rawChats = (parsed?.chats ?? {}) as Partial<ChatsSettings>;
  const chats: ChatsSettings = {
    // Same failure direction as skills.mode: an unrecognized (or absent) value
    // falls back to the default rather than to `off`.
    subjects: SUBJECT_MODES.includes(rawChats.subjects as ChatSubjectMode)
      ? (rawChats.subjects as ChatSubjectMode)
      : DEFAULTS.chats.subjects,
    subjectModel:
      typeof rawChats.subjectModel === 'string' && rawChats.subjectModel.trim() ? rawChats.subjectModel : null,
    subjectEffort: coerceEffort(rawChats.subjectEffort),
    previewLines:
      rawChats.previewLines === 0 || rawChats.previewLines === 1 || rawChats.previewLines === 2
        ? rawChats.previewLines
        : DEFAULTS.chats.previewLines
  };
  const rawTasks = (parsed?.tasks ?? {}) as Partial<TasksSettings>;
  const tasks: TasksSettings = {
    // Same failure direction as skills.mode and chats.subjects: an unrecognized
    // (or absent) value takes the default rather than the quietest option, so a
    // settings file written by an older build cannot silence a watch task.
    notify: TASK_NOTIFY_MODES.includes(rawTasks.notify as TaskNotifyMode)
      ? (rawTasks.notify as TaskNotifyMode)
      : DEFAULTS.tasks.notify
  };
  const rawExec = (parsed?.exec ?? {}) as Partial<ExecSettings>;
  const exec: ExecSettings = {
    enabled: typeof rawExec.enabled === 'boolean' ? rawExec.enabled : DEFAULTS.exec.enabled,
    approvalMode:
      rawExec.approvalMode === 'manual' || rawExec.approvalMode === 'yolo' ? rawExec.approvalMode : 'assisted',
    judgeModel: typeof rawExec.judgeModel === 'string' && rawExec.judgeModel.trim() ? rawExec.judgeModel : null,
    judgeEffort: coerceEffort(rawExec.judgeEffort),
    // Dedupe + trim, drop empties, and cap size so a runaway writer can't bloat
    // settings.json (the allowlist is matched per command, so order is cosmetic).
    allowlist: [
      ...new Set(
        (Array.isArray(rawExec.allowlist) ? rawExec.allowlist : [])
          .filter((p): p is string => typeof p === 'string')
          .map((p) => p.trim())
          .filter((p) => p && p.length <= 200)
      )
    ].slice(0, 200),
    // The per-device buckets get the same laundering as the shared list, per
    // bucket, and the same caps — a device id key that is not a string array is
    // dropped whole rather than half-read.
    deviceAllowlists: Object.fromEntries(
      Object.entries(
        rawExec.deviceAllowlists && typeof rawExec.deviceAllowlists === 'object' ? rawExec.deviceAllowlists : {}
      )
        .filter(([, list]) => Array.isArray(list))
        .map(([deviceId, list]) => [
          deviceId,
          [
            ...new Set(
              (list as unknown[])
                .filter((p): p is string => typeof p === 'string')
                .map((p) => p.trim())
                .filter((p) => p && p.length <= 200)
            )
          ].slice(0, 200)
        ])
        .filter(([, list]) => (list as string[]).length > 0)
        .slice(0, 50)
    ),
    // null is a real choice here ("Never"), so only an absent/nonsensical value
    // takes the default — a 0 or a negative would otherwise read as "sweep
    // everything immediately", which is the one answer nobody picked.
    scratchTtlDays:
      rawExec.scratchTtlDays === null
        ? null
        : typeof rawExec.scratchTtlDays === 'number' && Number.isFinite(rawExec.scratchTtlDays) && rawExec.scratchTtlDays > 0
          ? Math.floor(rawExec.scratchTtlDays)
          : DEFAULTS.exec.scratchTtlDays,
    gitBashPath:
      typeof rawExec.gitBashPath === 'string' && rawExec.gitBashPath.trim()
        ? rawExec.gitBashPath.trim().slice(0, 500)
        : null,
    // git-bash without a saved path still means "prefer Git Bash": spawn-time
    // resolveHostShell auto-detects bash.exe and falls back to cmd if missing.
    windowsShell:
      rawExec.windowsShell === 'cmd'
        ? 'cmd'
        : rawExec.windowsShell === 'git-bash'
          ? 'git-bash'
          : DEFAULTS.exec.windowsShell
  };
  const rawHarness = (parsed?.harness ?? {}) as Partial<HarnessSettings>;
  const harness: HarnessSettings = {
    enabled: typeof rawHarness.enabled === 'boolean' ? rawHarness.enabled : DEFAULTS.harness.enabled,
    // Same laundering stance as the exec allowlists: only string fields
    // survive, trimmed and capped; an entry needs at least one of them.
    agents: (() => {
      const raw = rawHarness.agents && typeof rawHarness.agents === 'object' ? rawHarness.agents : {};
      const agents: Record<string, { command?: string; model?: string }> = {};
      for (const [rawName, value] of Object.entries(raw)) {
        if (Object.keys(agents).length >= 25) break;
        const name = rawName.trim();
        const fields = value && typeof value === 'object' ? (value as { command?: unknown; model?: unknown }) : {};
        const command = typeof fields.command === 'string' && fields.command.trim() ? fields.command.trim().slice(0, 500) : undefined;
        const model = typeof fields.model === 'string' && fields.model.trim() ? fields.model.trim().slice(0, 100) : undefined;
        if (!name || name.length > 64 || (!command && !model)) continue;
        agents[name] = { ...(command ? { command } : {}), ...(model ? { model } : {}) };
      }
      return agents;
    })()
  };
  const rawRet = (parsed?.retrieval ?? {}) as Partial<RetrievalSettings>;
  // Imported models first: they are half of what a stage's model id is allowed
  // to be, so an entry that doesn't survive coercion must not leave the stage
  // selecting it.
  const customEmbedModels = coerceCustomModels(rawRet.customEmbedModels, coerceCustomEmbedModel);
  const customRerankModels = coerceCustomModels(rawRet.customRerankModels, coerceCustomRerankModel);
  const retrieval: RetrievalSettings = {
    embeddings: coerceEmbeddings(rawRet.embeddings, DEFAULTS.retrieval.embeddings, customEmbedModels),
    reranker: coerceReranker(rawRet.reranker, DEFAULTS.retrieval.reranker, customRerankModels),
    customEmbedModels,
    customRerankModels
  };
  const escapeAction: EscapeAction = ESCAPE_ACTIONS.includes(parsed?.escapeAction as EscapeAction)
    ? (parsed!.escapeAction as EscapeAction)
    : DEFAULTS.escapeAction;
  const rawCi = (parsed?.customInstructions ?? {}) as Partial<CustomInstructionsSettings>;
  const customInstructions: CustomInstructionsSettings = {
    main: typeof rawCi.main === 'string' ? rawCi.main : DEFAULTS.customInstructions.main,
    quickChat: typeof rawCi.quickChat === 'string' ? rawCi.quickChat : DEFAULTS.customInstructions.quickChat
  };
  const rawOb = (parsed?.onboarding ?? {}) as Partial<OnboardingSettings>;
  const onboarding: OnboardingSettings = {
    completed: typeof rawOb.completed === 'boolean' ? rawOb.completed : DEFAULTS.onboarding.completed
  };
  const rawDef = (parsed?.defaults ?? {}) as Partial<DefaultsSettings>;
  const defaults: DefaultsSettings = {
    model: typeof rawDef.model === 'string' && rawDef.model.trim() ? rawDef.model : null,
    backgroundModel:
      typeof rawDef.backgroundModel === 'string' && rawDef.backgroundModel.trim()
        ? rawDef.backgroundModel
        : null,
    backgroundEffort: coerceEffort(rawDef.backgroundEffort)
  };
  const rawLp = (parsed?.localProviders ?? {}) as Partial<Record<LocalProviderId, Partial<LocalProviderSettings>>>;
  const coerceLocal = (id: LocalProviderId): LocalProviderSettings => {
    const r = rawLp[id] ?? {};
    const def = DEFAULTS.localProviders[id];
    // apiKey/models stay absent rather than empty when unset, so a keyless server
    // with a server-provided catalog round-trips to exactly the old shape.
    const apiKey = typeof r.apiKey === 'string' ? r.apiKey.trim() : '';
    const models = Array.isArray(r.models)
      ? r.models.filter((m): m is string => typeof m === 'string' && !!m.trim()).map((m) => m.trim())
      : [];
    // API flavor: only `custom` may opt into anthropic-messages. Ollama/LM Studio
    // are always openai-completions — a hand-edited settings.json cannot switch
    // them; the field would be ignored downstream anyway. Persist the flavor
    // verbatim (both `openai-completions` and `anthropic-messages`) so a saved
    // settings.json is self-describing and future debugging can tell an explicit
    // openai-completions pick from an absent field (= not yet configured).
    const api: LocalProviderApi | undefined =
      id === 'custom' && (r.api === 'anthropic-messages' || r.api === 'openai-completions') ? r.api : undefined;
    // Per-model overrides: `custom` only, and coerced only as far as its shape —
    // an entry that fails the deeper guard (pi/model-overrides.ts) is KEPT here
    // and dropped at sync time instead. Losing the text on read is the exact
    // failure the feature exists to end; the box has to still show what was
    // typed so it can be corrected.
    const rawOverrides = r.modelOverrides;
    const overrides =
      id === 'custom' && isRecord(rawOverrides)
        ? Object.fromEntries(Object.entries(rawOverrides).filter(([k, v]) => k.trim() && isRecord(v)))
        : {};
    return {
      enabled: typeof r.enabled === 'boolean' ? r.enabled : def.enabled,
      baseUrl: typeof r.baseUrl === 'string' && r.baseUrl.trim() ? r.baseUrl.trim() : def.baseUrl,
      ...(api ? { api } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(models.length ? { models } : {}),
      ...(Object.keys(overrides).length ? { modelOverrides: overrides } : {})
    };
  };
  const localProviders: LocalProvidersSettings = {
    ollama: coerceLocal('ollama'),
    lmstudio: coerceLocal('lmstudio'),
    custom: coerceLocal('custom')
  };
  return {
    quickChat: {
      defaultModel: typeof qc.defaultModel === 'string' && qc.defaultModel.trim() ? qc.defaultModel : null,
      defaultEffort: typeof qc.defaultEffort === 'string' ? qc.defaultEffort : d.defaultEffort,
      // 'priority' (Fast) or explicit null (Standard); anything else → default.
      defaultServiceTier:
        qc.defaultServiceTier === 'priority' ? 'priority' : qc.defaultServiceTier === null ? null : d.defaultServiceTier,
      newThreadTimeoutMs:
        typeof qc.newThreadTimeoutMs === 'number' && qc.newThreadTimeoutMs >= 0
          ? qc.newThreadTimeoutMs
          : d.newThreadTimeoutMs,
      finishSound: typeof qc.finishSound === 'boolean' ? qc.finishSound : d.finishSound,
      skipInbox: typeof qc.skipInbox === 'boolean' ? qc.skipInbox : d.skipInbox
    },
    webSearch: ws,
    memory: mem,
    skills,
    chats,
    tasks,
    exec,
    harness,
    retrieval,
    escapeAction,
    customInstructions,
    onboarding,
    defaults,
    localProviders
  };
}

async function loadSettings(): Promise<ServerSettings> {
  return coerce(JSON.parse(await readFile(settingsStorePath(), 'utf8')) as Partial<ServerSettings>);
}

/**
 * Read for display and for decisions. Anything unreadable reads as defaults,
 * because a settings screen that will not open is worse than one showing the
 * factory values — and every caller here only reads.
 */
export async function readSettings(): Promise<ServerSettings> {
  try {
    return await loadSettings();
  } catch (error) {
    // Defaults are exactly what a first launch looks like, so ENOENT says nothing.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      degrade('settings', 'fell back to default settings', error);
    }
    return coerce(null);
  }
}

/**
 * Read as the first half of a read-modify-write, where the forgiving version is
 * the bug: the mutators below persist whatever this returns, so defaults from a
 * settings.json that is merely unreadable — EACCES after a permission change,
 * EIO on a failing disk — go straight back to disk over the user's custom
 * instructions, model choices, retrieval config and local-provider API keys.
 * Absent is still a first launch and still defaults; anything else refuses, and
 * the mutation fails visibly instead of quietly costing the user their setup.
 */
async function readForUpdate(): Promise<ServerSettings> {
  try {
    return await loadSettings();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return coerce(null);
    degrade('settings', 'refused to write settings over a file it could not read', error);
    throw error;
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

async function writeSettings(settings: ServerSettings): Promise<void> {
  const path = settingsStorePath();
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), 'utf8');
  await rename(tmp, path);
}

/**
 * Patch the Quick Chat settings and persist atomically; returns the full settings.
 *
 * A patch carrying the machine-owned fields as well is fine and expected — the
 * client sends the user's whole patch and `coerce` keeps only what belongs here,
 * which is one less thing for either side to get exactly right.
 */
export function updateQuickChat(patch: Partial<QuickChatSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    // The cast is what lets the machine-owned keys through to `coerce`, which is
    // the single place that decides what settings.json is allowed to hold.
    const next = coerce({ ...cur, quickChat: { ...cur.quickChat, ...patch } } as Partial<ServerSettings>);
    await writeSettings(next);
    return next;
  });
}

/** Patch the web-search toggles/backend and persist; returns full settings. */
export function updateWebSearch(patch: Partial<WebSearchSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, webSearch: { ...cur.webSearch, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Set the main-composer Escape-to-retract behavior and persist; returns full settings. */
export function updateEscapeAction(action: EscapeAction): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, escapeAction: action });
    await writeSettings(next);
    return next;
  });
}

/** Patch the memory-model setting and persist; returns the full settings. */
export function updateMemorySettings(patch: Partial<MemoryModelSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, memory: { ...cur.memory, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the standing custom instructions (per surface) and persist; returns full settings. */
export function updateCustomInstructions(patch: Partial<CustomInstructionsSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, customInstructions: { ...cur.customInstructions, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the skills model/effort/mode settings and persist; returns the full settings. */
export function updateSkillsSettings(patch: Partial<SkillsSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, skills: { ...cur.skills, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the Chats panel settings (subject mode/model, preview lines) and persist. */
export function updateChatsSettings(patch: Partial<ChatsSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, chats: { ...cur.chats, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the scheduled-task settings (notify prominence) and persist; returns full settings. */
export function updateTasksSettings(patch: Partial<TasksSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, tasks: { ...cur.tasks, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the command-execution policy and persist; returns the full settings. */
export function updateExecSettings(patch: Partial<ExecSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, exec: { ...cur.exec, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the coding-agents settings and persist; returns full settings. */
export function updateHarnessSettings(patch: Partial<HarnessSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, harness: { ...cur.harness, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/**
 * Mark the first-run wizard finished and persist; returns the full settings.
 *
 * It used to also seed the "what's new" marker to the running version, so a
 * brand-new user wasn't greeted by notes for releases they were never on. That
 * marker is a client's now — the running version is the *client's* version — so
 * the seeding rides along on this channel from the other side of the wire
 * (src/desktop/settings.ts).
 */
export function markOnboardingCompleted(): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, onboarding: { completed: true } });
    await writeSettings(next);
    return next;
  });
}

/** Patch the app-level model defaults ('provider/modelId' or null) and persist. */
export function updateDefaults(patch: Partial<DefaultsSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({ ...cur, defaults: { ...cur.defaults, ...patch } });
    await writeSettings(next);
    return next;
  });
}

/** Set the model you chat with. Kept as its own name because half the callers
 *  only ever touch this one, and a patch object reads worse at those sites. */
export function updateDefaultModel(model: string | null): Promise<ServerSettings> {
  return updateDefaults({ model });
}

/**
 * How a background job is to be run: which model, and how hard it may think.
 *
 * The two travel together because they are one decision — "spend less on this" —
 * and splitting them is how you end up with a role whose model comes from one
 * setting and whose effort comes from another. Both nullable, and null means the
 * same thing in both halves: don't specify, let the layer below decide.
 */
export interface RoleRun {
  /** `provider/modelId`, or null to fall through to `defaults.model`. */
  model: string | null;
  /** Reasoning effort, or null to leave the model on its own default. */
  effort: string | null;
}

/**
 * What one quick-tasks role pins for itself. Both halves nullable and read the
 * same way as {@link RoleRun}: null = don't specify here, fall through to the
 * shared Quick tasks setting.
 */
export interface RolePin {
  model: string | null;
  effort: string | null;
}

/**
 * What a quick-tasks role actually runs on: its own pin, else the shared
 * quick-tasks setting, else the fallback for that half — null for the model,
 * which sends it through complete()'s own fallback to `defaults.model`, the
 * model you chat with; and the role's {@link ROLE_EFFORT_FLOOR} for the effort.
 *
 * Effort falls through separately from the model, so pinning one does not pin the
 * other: the safety check can be moved to a bigger model and still be told to
 * answer fast, and a role left alone keeps following Quick tasks when that
 * changes.
 */
export function backgroundRunFor(settings: ServerSettings, role: BackgroundRole, pin: RolePin): RoleRun {
  return {
    model: pin.model ?? settings.defaults.backgroundModel,
    effort: resolveRoleEffort(role, pin.effort, settings.defaults.backgroundEffort)
  };
}

/** {@link backgroundRunFor} for the many call sites that have to read settings anyway. */
export async function backgroundRunOf(
  role: BackgroundRole,
  pin: (settings: ServerSettings) => RolePin
): Promise<RoleRun> {
  const settings = await readSettings();
  return backgroundRunFor(settings, role, pin(settings));
}

/**
 * What memory runs on. Its own settings only — the shared background model is
 * skipped, so making the background cheap cannot quietly make memory stop
 * learning. See MemoryModelSettings for why this role is the exception.
 *
 * `pinned` exists for connected folders, which may override the model for their
 * own fact-learning sweep while still counting as memory work.
 */
export function memoryRunFor(settings: ServerSettings, pinned: string | null): RoleRun {
  return { model: pinned, effort: settings.memory.effort };
}

/** {@link memoryRunFor} for call sites that have to read settings anyway. */
export async function memoryRunOf(pinned: (settings: ServerSettings) => string | null): Promise<RoleRun> {
  const settings = await readSettings();
  return memoryRunFor(settings, pinned(settings));
}

/**
 * What skills work runs on — authoring (the end-of-turn pass and `/learn`) and
 * curation alike. Memory's chain, not the quick-tasks one: an unpinned model
 * answers null, which complete() resolves to `defaults.model`, the model you
 * chat with. Skills used to ride the shared background model, which meant the
 * advertised move — "point Background work at something small" — silently had
 * your skills written by that small model too.
 */
export function skillsRunFor(settings: ServerSettings): RoleRun {
  return { model: settings.skills.model, effort: settings.skills.effort };
}

/** {@link skillsRunFor} for call sites that don't otherwise read settings. */
export async function skillsRunOf(): Promise<RoleRun> {
  return skillsRunFor(await readSettings());
}

/** Patch one local provider (Ollama / LM Studio / custom) and persist; returns the full settings. */
export function updateLocalProvider(id: LocalProviderId, patch: Partial<LocalProviderSettings>): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({
      ...cur,
      localProviders: { ...cur.localProviders, [id]: { ...cur.localProviders[id], ...patch } }
    });
    await writeSettings(next);
    return next;
  });
}

/** Patch the retrieval endpoints (deep-merged per stage) and persist; returns full settings. */
export function updateRetrievalSettings(patch: PartialRetrievalSettings): Promise<ServerSettings> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const next = coerce({
      ...cur,
      retrieval: {
        embeddings: { ...cur.retrieval.embeddings, ...patch.embeddings },
        reranker: { ...cur.retrieval.reranker, ...patch.reranker },
        // Lists, so replaced wholesale or left alone — there is no field-wise
        // merge of "which models exist".
        customEmbedModels: patch.customEmbedModels ?? cur.retrieval.customEmbedModels,
        customRerankModels: patch.customRerankModels ?? cur.retrieval.customRerankModels
      }
    });
    await writeSettings(next);
    return next;
  });
}

/**
 * Add or replace an imported model's description — the answers the import
 * dialog collected, or an edit of them later. Keyed by the model's repo, so
 * importing the same folder twice updates one entry instead of growing a
 * second. Does NOT select the model: import puts weights on disk and a name in
 * a list, and switching the stage under the user is a separate decision.
 */
export function saveCustomModel(stage: 'embed' | 'rerank', raw: unknown): Promise<CustomModelResult> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    let retrieval: RetrievalSettings;
    if (stage === 'embed') {
      const model = coerceCustomEmbedModel(raw);
      if (!model) return unusableModel;
      const rest = cur.retrieval.customEmbedModels.filter((m) => m.id !== model.id);
      retrieval = { ...cur.retrieval, customEmbedModels: [...rest, model] };
    } else {
      const model = coerceCustomRerankModel(raw);
      if (!model) return unusableModel;
      const rest = cur.retrieval.customRerankModels.filter((m) => m.id !== model.id);
      retrieval = { ...cur.retrieval, customRerankModels: [...rest, model] };
    }
    const next = coerce({ ...cur, retrieval });
    await writeSettings(next);
    return { ok: true, retrieval: next.retrieval };
  });
}

/** Said when a model description names nothing Stem could load or file on disk. */
export const UNUSABLE_MODEL_ERROR =
  'Stem could not make sense of that model description — it needs a repo id like org/name and a quantization.';

const unusableModel: CustomModelResult = { ok: false, error: UNUSABLE_MODEL_ERROR };

/**
 * The stored shape of an incoming model description, or null when it is not
 * one. Callers that need the repo id BEFORE saving (the import copy, which
 * turns it into a path) go through this rather than trusting what they were
 * handed.
 */
export function coerceCustomModel(
  stage: 'embed' | 'rerank',
  raw: unknown
): CustomEmbedModel | CustomRerankModel | null {
  return stage === 'embed' ? coerceCustomEmbedModel(raw) : coerceCustomRerankModel(raw);
}

/**
 * Drop an imported model's entry. The cached weights stay on disk — deleting
 * files somebody may have carried in on a USB stick is a different, much less
 * recoverable action than forgetting a name.
 */
export function removeCustomModel(stage: 'embed' | 'rerank', id: string): Promise<CustomModelResult> {
  return enqueue(async () => {
    const cur = await readForUpdate();
    const embed = stage === 'embed';
    const selected = embed ? cur.retrieval.embeddings.localModel : cur.retrieval.reranker.localModel;
    // Refused while selected, rather than quietly reverting: with the entry gone
    // coercion would move the stage to a curated model on the next read, and the
    // user would find a model switch they never made.
    if (selected === id) {
      return { ok: false, error: 'This is the selected model — choose another one first.' };
    }
    const list = embed ? cur.retrieval.customEmbedModels : cur.retrieval.customRerankModels;
    if (!list.some((m) => m.id === id)) return { ok: false, error: 'That model is not in the list.' };
    const retrieval: RetrievalSettings = embed
      ? { ...cur.retrieval, customEmbedModels: cur.retrieval.customEmbedModels.filter((m) => m.id !== id) }
      : { ...cur.retrieval, customRerankModels: cur.retrieval.customRerankModels.filter((m) => m.id !== id) };
    const next = coerce({ ...cur, retrieval });
    await writeSettings(next);
    return { ok: true, retrieval: next.retrieval };
  });
}
