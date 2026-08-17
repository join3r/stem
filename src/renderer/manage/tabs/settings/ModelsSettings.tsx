import { useCallback, useEffect, useRef, useState } from 'react';
import { Plug, Globe, HardDrive, Plus, Minus, X, Check, RefreshCw } from 'lucide-react';
import type {
  AuthProviderId,
  ApiKeyProviderId,
  ExecSettings,
  WebSearchSettings,
  LocalProviderApi,
  LocalProviderId,
  LocalProvidersSettings,
  LocalProviderTestResult,
  PiModelsOverlayProvider
} from '../../../../shared/types';
import { API_KEY_PROVIDER_IDS, AUTH_PROVIDER_IDS, isLocalProviderId, providerName } from '../../../../shared/providers';
import { resolveBackgroundModel, resolveMemoryModel, resolveRoleEffort, resolveSkillsModel } from '../../../../shared/modelRoles';
import { clampEffort, EffortSelect, effortsOf } from '../../../ui/EffortSelect';
import { localProbeTarget, probeStillDescribes } from '../../../localProbe';
import { RequestGate } from '../../../requestGate';
import { InfoTip } from '../../../ui/InfoTip';
import { ModelPicker } from '../../../ui/ModelPicker';
import type { ModelTabProps } from '../shared';
import {
  backendOptionLabel,
  backendSections,
  backendState,
  credentialInputType,
  credentialLabel,
  credentialRequirement,
  SEARCH_BACKENDS,
  SEARCH_ENDPOINTS
} from '../../searchBackends';

/**
 * Settings → Models: who Stem is signed in to, which model does which job, and
 * who answers a search.
 *
 * Three lists that look unrelated and aren't — and they are ordered by
 * dependency. The AI providers come first because they are who Stem is allowed
 * to ask at all: until one is connected, every role picker below is an empty
 * list (and the dead-credential red dot that pulls the panel open is about a
 * provider row, so that row should not sit below the roles wall). Model roles
 * then say what each job runs on. And the search backend is who Stem asks when
 * the answer isn't in a model; it shares credentials with the providers above,
 * so a ChatGPT sign-in made here is also a search backend below, and the picker
 * says so.
 */
export function ModelsSettings({ models, modelId, onSelectModel, deadProvider }: ModelsSettingsProps) {
  // Connected AI providers, so the search picker can tell you which backends
  // already work on a sign-in you have. Kept in step with the Providers section,
  // which broadcasts on every connect/disconnect.
  const [providers, setProviders] = useState<string[]>([]);

  useEffect(() => {
    const load = (): void => {
      void window.stem.runtimeStatus().then((s) => setProviders(s.providers ?? []));
    };
    load();
    window.addEventListener('stem:providers-changed', load);
    return () => window.removeEventListener('stem:providers-changed', load);
  }, []);

  return (
    <div>
      <ProvidersSection deadProvider={deadProvider} />
      <ModelRolesSection models={models} modelId={modelId} onSelectModel={onSelectModel} />
      <WebSearchSection providers={providers} />
    </div>
  );
}

type ModelsSettingsProps = ModelTabProps & { deadProvider?: string | null };

/**
 * Every job Stem runs a model for, in one list.
 *
 * Two of them are decisions: the model you chat with, and the one Quick tasks
 * falls back to. The rest are grouped by what the job NEEDS, not by where it
 * runs — everything here runs in the background, which is why the group used to
 * be called "Background work" and why that name was wrong. Quick Chat, memory
 * and skills follow the model you chat with: you read the first, and the other
 * two are judgment work that fails quietly on a model too small for it. Chat
 * subjects and the safety check follow Quick tasks: both are extraction on a
 * latency budget, so the common want ("stop spending my good model on chat
 * subjects") is one picker — and it can no longer degrade skills on the way
 * past, which is exactly what the old grouping did.
 *
 * Every picker says which rung it landed on: a role's own pin, else the group's
 * fallback. Stem does not guess a cheaper model, because it cannot — pi's
 * catalog carries names, a reasoning flag and a context window, and nothing
 * about price or size. Guessing from names is what used to put the safety check
 * on a mini variant while a newer, cheaper, better small model sat next to it in
 * the list.
 *
 * Effort sits under the model it will be spent on, and follows the same two
 * rungs: a role's own level, else the group's. The levels offered are the ones
 * the model it resolves to actually has, so the list changes when the picker
 * above it does — and a level the new model can't do is cleared rather than left
 * showing as a choice that isn't.
 *
 * The two Quick tasks jobs each get their own effort, because "cheap" is not
 * one decision for both: the safety check is a latency budget (it stands
 * between you and every command), and chat subjects are three words off a
 * sentence. Left alone they end at a level chosen per job rather than at
 * "whatever pi picks" (see ROLE_EFFORT_FLOOR), and each says underneath what
 * that comes out as, so the default is legible without reading the chain.
 *
 * A role that is switched off elsewhere still shows its model, with a line
 * saying it is idle. An overview that hid them would answer "what is running on
 * what" with a different list every time you changed a mode.
 */
function ModelRolesSection({ models, modelId, onSelectModel }: ModelTabProps) {
  const [background, setBackground] = useState<string | null>(null);
  const [backgroundEffort, setBackgroundEffort] = useState<string | null>(null);
  const [quickChatModel, setQuickChatModel] = useState<string | null>(null);
  const [subjectModel, setSubjectModel] = useState<string | null>(null);
  const [subjectEffort, setSubjectEffort] = useState<string | null>(null);
  const [subjectsOff, setSubjectsOff] = useState(false);
  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const [judgeEffort, setJudgeEffort] = useState<string | null>(null);
  const [judgeIdle, setJudgeIdle] = useState<string | null>(null);
  const [memoryModel, setMemoryModel] = useState<string | null>(null);
  const [memoryEffort, setMemoryEffort] = useState<string | null>(null);
  const [skillsModel, setSkillsModel] = useState<string | null>(null);
  const [skillsEffort, setSkillsEffort] = useState<string | null>(null);
  const [folderOverrides, setFolderOverrides] = useState(0);

  useEffect(() => {
    void window.stem.getSettings().then((s) => {
      setBackground(s.defaults.backgroundModel);
      setBackgroundEffort(s.defaults.backgroundEffort);
      setQuickChatModel(s.quickChat.defaultModel);
      setSubjectModel(s.chats.subjectModel);
      setSubjectEffort(s.chats.subjectEffort);
      setSubjectsOff(s.chats.subjects === 'off');
      setJudgeModel(s.exec.judgeModel);
      setJudgeEffort(s.exec.judgeEffort);
      setJudgeIdle(judgeIdleReason(s.exec));
      setMemoryModel(s.memory.model);
      setMemoryEffort(s.memory.effort);
      setSkillsModel(s.skills.model);
      setSkillsEffort(s.skills.effort);
    });
    void window.stem
      .listConnectedFolders()
      .then((folders) => setFolderOverrides(folders.filter((f) => f.learnModel).length))
      .catch(() => undefined);
  }, []);

  // What an unpinned role runs on today. `modelId` is the live pick from this
  // very panel, so the notes move the instant you change it — before the model
  // list has been refetched with a new isDefault.
  const backgroundResolved = resolveBackgroundModel(null, background, modelId);
  const memoryResolved = resolveMemoryModel(memoryModel, modelId);
  const skillsResolved = resolveSkillsModel(skillsModel, modelId);

  return (
    <>
      <div className="grp-head grp-head-row">
        Model roles
        <InfoTip label="About model roles">
          Stem runs more than one model. The one you chat with writes the replies; the rest work in
          the background, on jobs you never watch. A role left unset falls back to its group —
          Quick Chat, memory and skills to the model you chat with, chat subjects and the safety
          check to <strong>Quick tasks</strong> — and every picker says underneath where it landed.
          The split is by what a job needs, not where it runs: quick tasks are extraction a small
          fast model does well, while memory and skills are judgment work that quietly degrades on
          one. Stem never picks a cheaper model for you: the catalog it gets carries no prices, so
          it would be guessing from names.
        </InfoTip>
      </div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Chatting with you{' '}
            <InfoTip label="About the model you chat with">
              Writes every reply in the main window, and it is the only role whose output you read
              word for word. <strong>Give it your best model</strong> — everything below exists so
              that this one does not have to be cheap.
            </InfoTip>
          </span>
          <ModelPicker
            models={models}
            value={modelId}
            onChange={(id) => onSelectModel(id ?? '')}
            ariaLabel="Model"
          />
        </div>

        <div className="set-block fg-divider">
          <span className="set-sub">
            Quick Chat{' '}
            <InfoTip label="About the Quick Chat model">
              The overlay you summon from anywhere, for short questions you want answered before you
              have finished thinking about them. You do read this one, so it follows the model you
              chat with rather than Quick tasks — though{' '}
              <strong>speed matters more than depth here</strong>, and a fast mid-tier model often
              serves it better.
            </InfoTip>
          </span>
          <ModelPicker
            models={models}
            value={quickChatModel}
            onChange={(id) => {
              setQuickChatModel(id);
              window.stem.updateQuickChat({ defaultModel: id }).then((s) => setQuickChatModel(s.quickChat.defaultModel));
            }}
            emptyLabel="Same as main"
            ariaLabel="Quick Chat default model"
            resolvedDefault={modelId}
          />
        </div>

        <div className="set-block">
          <span className="set-sub">
            Memory{' '}
            <InfoTip label="About the memory model">
              Reads finished conversations in the background, decides what is worth keeping, and
              merges or drops what it already has. <strong>This role is not part of Background
              work</strong>, on purpose: it works against a long transcript plus everything already
              remembered, and a model too small to hold that does not fail — it replies with
              truncated nonsense, and memory quietly stops learning without saying so. Making the
              background cheap must not be able to do that, so an unset memory model follows the
              model you chat with. Pin a solid mid-tier model here if you would rather not spend
              your best one on it.
            </InfoTip>
          </span>
          <ModelPicker
            models={models}
            value={memoryModel}
            onChange={(id) => {
              setMemoryModel(id);
              const effort = clampEffort(models, resolveMemoryModel(id, modelId), memoryEffort);
              setMemoryEffort(effort);
              window.stem.updateMemorySettings({ model: id, effort }).then((s) => {
                setMemoryModel(s.memory.model);
                setMemoryEffort(s.memory.effort);
              });
            }}
            emptyLabel="Same as main"
            ariaLabel="Memory model"
            resolvedDefault={modelId}
          />
          <EffortSelect
            label="Memory effort"
            value={memoryEffort}
            efforts={effortsOf(models, memoryResolved)}
            onChange={(effort) => {
              setMemoryEffort(effort);
              window.stem.updateMemorySettings({ effort }).then((s) => setMemoryEffort(s.memory.effort));
            }}
          />
          {folderOverrides > 0 && (
            <em className="mp-resolved">
              {folderOverrides} connected folder{folderOverrides === 1 ? '' : 's'} override
              {folderOverrides === 1 ? 's' : ''} this — Sources › Connected folders
            </em>
          )}
        </div>

        <div className="set-block">
          <span className="set-sub">
            Skills{' '}
            <InfoTip label="About the skills model">
              Writes and maintains your skills library: it authors a new skill (or improves an
              existing one) after a turn that earned it, handles <code>/learn</code>, and runs the
              tidy-up pass that merges duplicates. Like memory, it is deliberately{' '}
              <strong>not part of Quick tasks</strong>: writing a skill is judgment work, and a
              library authored by your cheapest model is worse than none. Left unset it follows the
              model you chat with; pin a solid mid-tier model here if you would rather not spend
              your best one on it. Retiring skills unused for 90 days is a plain clock and uses no
              model at all.
            </InfoTip>
          </span>
          <ModelPicker
            models={models}
            value={skillsModel}
            onChange={(id) => {
              setSkillsModel(id);
              const effort = clampEffort(models, resolveSkillsModel(id, modelId), skillsEffort);
              setSkillsEffort(effort);
              window.stem.updateSkillsSettings({ model: id, effort }).then((s) => {
                setSkillsModel(s.skills.model);
                setSkillsEffort(s.skills.effort);
              });
            }}
            emptyLabel="Same as main"
            ariaLabel="Skills model"
            resolvedDefault={modelId}
          />
          <EffortSelect
            label="Skills effort"
            value={skillsEffort}
            efforts={effortsOf(models, skillsResolved)}
            onChange={(effort) => {
              setSkillsEffort(effort);
              window.stem.updateSkillsSettings({ effort }).then((s) => setSkillsEffort(s.skills.effort));
            }}
          />
        </div>

        <div className="set-block fg-divider">
          <span className="set-sub">
            Quick tasks{' '}
            <InfoTip label="About the quick-tasks model">
              The fallback for the two jobs that want a <strong>small, fast model</strong>: chat
              subjects and the command safety check. Both are extraction rather than reasoning,
              they run constantly and unattended, and{' '}
              <strong>a cheap model here is the single biggest saving available</strong> — set it
              once and both follow; pin one individually to take it out of the deal. Memory and
              skills are deliberately not in this group: they are judgment work, so they follow the
              model you chat with and have their own pickers above.
              <br />
              <strong>Effort</strong> is the same bargain by a different route: how much these jobs
              are allowed to think before answering. <strong>Low is a good place to start</strong> —
              the safety check in particular sits between you and every command you run, where
              waiting costs more than depth buys. Each job below can override it with a level of
              its own; left alone they follow this one — and where this is left on{' '}
              <em>Model default</em>, they end at a level chosen for that job rather than at
              whatever pi picks, which each of them says underneath.
            </InfoTip>
          </span>
          <ModelPicker
            models={models}
            value={background}
            onChange={(id) => {
              // Optimistic, then reconciled from what was actually saved.
              setBackground(id);
              const effort = clampEffort(models, resolveBackgroundModel(null, id, modelId), backgroundEffort);
              setBackgroundEffort(effort);
              window.stem.updateDefaults({ backgroundModel: id, backgroundEffort: effort }).then((s) => {
                setBackground(s.defaults.backgroundModel);
                setBackgroundEffort(s.defaults.backgroundEffort);
              });
            }}
            emptyLabel="Same as main"
            ariaLabel="Quick tasks model"
            resolvedDefault={modelId}
          />
          <EffortSelect
            label="Quick tasks effort"
            value={backgroundEffort}
            efforts={effortsOf(models, backgroundResolved)}
            onChange={(effort) => {
              setBackgroundEffort(effort);
              window.stem
                .updateDefaults({ backgroundEffort: effort })
                .then((s) => setBackgroundEffort(s.defaults.backgroundEffort));
            }}
          />
        </div>

        <div className="set-block">
          <span className="set-sub">
            Chat subjects{' '}
            <InfoTip label="About the subject model">
              Writes each chat a short subject the way an email names a thread — once its first
              reply has landed, then rarely, so a chat that drifts onto something else stops
              carrying the name it opened with. <strong>The smallest, cheapest model you have is
              plenty</strong> — this is a few words off the conversation, not a summary of it. It
              also runs with <strong>reasoning off</strong> unless you say otherwise: naming a
              thread is extraction, and thinking about it is time spent before the chat you
              actually opened can be found again. Turn subjects on or off under Chat.
            </InfoTip>
          </span>
          <ModelPicker
            models={models}
            value={subjectModel}
            onChange={(id) => {
              setSubjectModel(id);
              const effort = clampEffort(models, id ?? backgroundResolved, subjectEffort);
              setSubjectEffort(effort);
              window.stem.updateChatsSettings({ subjectModel: id, subjectEffort: effort }).then((s) => {
                setSubjectModel(s.chats.subjectModel);
                setSubjectEffort(s.chats.subjectEffort);
                window.dispatchEvent(new CustomEvent('stem:chat-settings'));
              });
            }}
            emptyLabel="Quick tasks"
            ariaLabel="Subject model"
            resolvedDefault={subjectsOff ? null : backgroundResolved}
          />
          <EffortSelect
            label="Subject effort"
            value={subjectEffort}
            efforts={effortsOf(models, subjectModel ?? backgroundResolved)}
            emptyLabel="Quick tasks"
            resolved={resolveRoleEffort('subject', null, backgroundEffort)}
            onChange={(effort) => {
              setSubjectEffort(effort);
              window.stem
                .updateChatsSettings({ subjectEffort: effort })
                .then((s) => setSubjectEffort(s.chats.subjectEffort));
            }}
          />
          {subjectsOff && <em className="mp-resolved">not running — subjects are off under Chat</em>}
        </div>

        <div className="set-block">
          <span className="set-sub">
            Command safety check{' '}
            <InfoTip label="About the safety-check model">
              Reads a shell command before it runs and decides whether it serves what you asked for;
              anything it flags stops for your approval. It runs on <em>every</em> command that is
              not allowlisted, so <strong>this is the role that most wants a cheap fast model</strong>
              . It is a heuristic, not a security boundary, and a bigger model does not change that.
              It thinks at <strong>Low</strong> unless you say otherwise — enough to judge whether a
              command matches what you asked for, without making you wait for it.
            </InfoTip>
          </span>
          <ModelPicker
            models={models}
            value={judgeModel}
            onChange={(id) => {
              setJudgeModel(id);
              const effort = clampEffort(models, id ?? backgroundResolved, judgeEffort);
              setJudgeEffort(effort);
              window.stem.updateExecSettings({ judgeModel: id, judgeEffort: effort }).then((s) => {
                setJudgeModel(s.exec.judgeModel);
                setJudgeEffort(s.exec.judgeEffort);
                setJudgeIdle(judgeIdleReason(s.exec));
              });
            }}
            emptyLabel="Quick tasks"
            ariaLabel="Safety-check model"
            resolvedDefault={judgeIdle ? null : backgroundResolved}
          />
          <EffortSelect
            label="Safety-check effort"
            value={judgeEffort}
            efforts={effortsOf(models, judgeModel ?? backgroundResolved)}
            emptyLabel="Quick tasks"
            resolved={resolveRoleEffort('judge', null, backgroundEffort)}
            onChange={(effort) => {
              setJudgeEffort(effort);
              window.stem.updateExecSettings({ judgeEffort: effort }).then((s) => setJudgeEffort(s.exec.judgeEffort));
            }}
          />
          {judgeIdle && <em className="mp-resolved">{judgeIdle}</em>}
        </div>
      </div>
    </>
  );
}

/** Why the safety check isn't running, or null when it is. */
function judgeIdleReason(exec: ExecSettings): string | null {
  if (!exec.enabled) return 'not running — command execution is off under Chat';
  if (exec.approvalMode === 'manual') return 'not running — approval mode is Manual';
  if (exec.approvalMode === 'yolo') return 'not running — approval mode is Yolo';
  return null;
}

/**
 * Which service answers a web search, and the keys for the ones that need them.
 * Independent of the chat model on purpose — see the ⓘ.
 */
function WebSearchSection({ providers }: { providers: string[] }) {
  const [ws, setWs] = useState<WebSearchSettings>({
    main: true,
    quickChat: true,
    provider: 'auto',
    credentials: {}
  });
  // The all-backends key list is collapsed by default: most people configure one
  // backend, and a wall of empty key fields would bury the picker.
  const [showSearchKeys, setShowSearchKeys] = useState(false);

  useEffect(() => {
    void window.stem.getSettings().then((s) => setWs(s.webSearch));
  }, []);

  function updateWebSearch(patch: Partial<WebSearchSettings>) {
    setWs((cur) => ({ ...cur, ...patch })); // optimistic; reconcile below
    window.stem.updateWebSearch(patch).then((s) => setWs(s.webSearch));
  }

  /**
   * Patch one credential. Sent as the whole map because the IPC merges settings
   * shallowly — a partial `credentials` would drop every other backend's key.
   */
  function setCredential(field: string, value: string) {
    updateWebSearch({ credentials: { ...ws.credentials, [field]: value } });
  }

  const activeBackend = SEARCH_BACKENDS.find((b) => b.id === ws.provider) ?? null;
  const activeState = activeBackend ? backendState(activeBackend, ws.credentials, providers) : null;

  return (
    <>
      <div className="grp-head">Web search</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Search backend{' '}
            <InfoTip label="About search backends">
              This is independent of the model you chat with — a local Ollama chat can search
              through Exa, a ChatGPT chat through SearXNG. <strong>Automatic</strong> tries each
              backend you have configured and ends at one that needs no key, so search works with
              no setup at all. <strong>All at once</strong> queries every configured backend and
              combines the answers. Keys below are kept for every backend, so switching between
              them never means re-entering one.
              <br />
              Automatic orders that chain by cost, not by what you have signed into: every backend
              that looks something up in an index comes first, then Exa’s keyless route, and only
              then the ones that spend a whole model inference to run the query for you. So a
              ChatGPT subscription does <em>not</em> mean your searches go through ChatGPT — it
              is the fallback for when everything above it is missing or failing. Pick{' '}
              <strong>ChatGPT / OpenAI</strong> by name if you want it every time.
              <br />
              The list is grouped by what each backend still wants from you.{' '}
              <strong>Works with no key</strong> holds the ones you can pick right now — ChatGPT
              rides the sign-in you already have under AI Providers, billing searches to that
              subscription, and Exa searches through its public endpoint. That public endpoint is
              a shared free allowance that resets at midnight UTC, so rows marked{' '}
              <em>free limit, no key</em> work today but will stop once you run it out. A key
              from dashboard.exa.ai is the fix, and Exa’s own free tier is far larger.
              <br />
              A few backends — Grok, AnySearch, Bright Data, SerpBase — are never reached by
              Automatic or All at once, whatever you configure. They answer only when selected by
              name.
            </InfoTip>
          </span>
          <select
            className="ifield"
            aria-label="Search backend"
            value={ws.provider}
            onChange={(e) => updateWebSearch({ provider: e.target.value })}
          >
            {/* Grouped by what each backend still wants from you, so the rows
                stay bare names and the heading carries the answer. */}
            {backendSections(ws.credentials, providers).map((section) => (
              <optgroup key={section.label} label={section.label}>
                {section.backends.map((b) => (
                  <option key={b.id} value={b.id}>
                    {backendOptionLabel(b, ws.credentials, providers)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {/* The selected backend's own field, inline — the common case is
              "pick one, paste its key" without opening anything else. */}
          {activeBackend?.field && (
            <input
              className="ifield"
              type={credentialInputType(activeBackend.field)}
              placeholder={
                activeBackend.placeholder
                  ? `${activeBackend.placeholder}${activeState?.ready ? ' (optional)' : ''}`
                  : activeState?.ready
                    ? 'Optional'
                    : undefined
              }
              aria-label={credentialLabel(activeBackend)}
              value={ws.credentials[activeBackend.field] ?? ''}
              onChange={(e) => setCredential(activeBackend.field as string, e.target.value)}
            />
          )}
          {/* Bright Data's second half. Inline beside the key rather than hidden in
              the full key list, because a key on its own leaves the backend dead
              and the status line right below already says so. */}
          {activeBackend?.also && (
            <input
              className="ifield"
              type={credentialInputType(activeBackend.also.field)}
              placeholder={activeBackend.also.placeholder}
              aria-label={activeBackend.also.label}
              value={ws.credentials[activeBackend.also.field] ?? ''}
              onChange={(e) => setCredential(activeBackend.also!.field, e.target.value)}
            />
          )}
          {activeBackend && activeState && (
            // Three states, not two: broken, fine, and fine-until-it-isn't. The
            // last one has to be visible without reading as an error.
            //
            // The line itself stays a glanceable verdict. Everything that explains
            // it — why this backend is in that state, and how the chain treats it —
            // goes behind the (i), because the version that ran the whole
            // explanation inline was long enough that nobody read either half.
            <em className={activeState.ready && !activeState.capped ? 'muted' : 'muted set-warn'}>
              {!activeState.ready ? '!' : activeState.capped ? '⚠' : '✓'} {activeState.status}
              {(activeState.detail || activeBackend.note) && (
                <>
                  {' '}
                  <InfoTip label={`About ${activeBackend.label}`}>
                    {activeState.detail}
                    {activeState.detail && activeBackend.note && <br />}
                    {activeBackend.note}
                  </InfoTip>
                </>
              )}
            </em>
          )}
        </div>

        <div className="set-block">
          <button className="push" onClick={() => setShowSearchKeys((v) => !v)} aria-expanded={showSearchKeys}>
            {showSearchKeys ? 'Hide' : 'Show'} all backend keys
          </button>
          {showSearchKeys && (
            <>
              {SEARCH_BACKENDS.filter((b) => b.field).map((b) => (
                <label className="set-block" key={b.field}>
                  <span className="set-sub">
                    {credentialLabel(b)}{' '}
                    {/* Which of these you can leave blank, without selecting each
                        backend in turn to read its status line. */}
                    <em className="set-opt">{credentialRequirement(b, ws.credentials, providers)}</em>
                  </span>
                  <input
                    className="ifield"
                    type={credentialInputType(b.field as string)}
                    placeholder={b.placeholder}
                    aria-label={credentialLabel(b)}
                    value={ws.credentials[b.field as string] ?? ''}
                    onChange={(e) => setCredential(b.field as string, e.target.value)}
                  />
                  {b.also && (
                    <>
                      <span className="set-sub">
                        {b.also.label} <em className="set-opt">(required)</em>
                      </span>
                      <input
                        className="ifield"
                        type={credentialInputType(b.also.field)}
                        placeholder={b.also.placeholder}
                        aria-label={b.also.label}
                        value={ws.credentials[b.also.field] ?? ''}
                        onChange={(e) => setCredential(b.also!.field, e.target.value)}
                      />
                      {b.also.hint && <em className="muted">{b.also.hint}</em>}
                    </>
                  )}
                </label>
              ))}
              {SEARCH_ENDPOINTS.map((f) => (
                <label className="set-block" key={f.field}>
                  <span className="set-sub">{f.label}</span>
                  <input
                    className="ifield"
                    type={f.field.endsWith('ApiKey') ? 'password' : 'url'}
                    placeholder={f.placeholder}
                    aria-label={f.label}
                    value={ws.credentials[f.field] ?? ''}
                    onChange={(e) => setCredential(f.field, e.target.value)}
                  />
                  <em className="muted">{f.hint}</em>
                </label>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
}


const OAUTH_CHOICES: { id: AuthProviderId; hint: string }[] = [
  { id: 'openai-codex', hint: 'Sign in with a ChatGPT Plus or Pro subscription.' },
  { id: 'anthropic', hint: 'Sign in with a Claude Pro or Max subscription.' },
  { id: 'xai', hint: 'Sign in with a SuperGrok or X Premium subscription.' }
];

/** How a connected provider signed in — shown as the row's secondary line. */
function providerKind(id: string): string {
  if (id === 'openai-codex') return 'ChatGPT subscription';
  if (isLocalProviderId(id)) return 'Server';
  return 'API key / subscription';
}

/**
 * Provider management, mirroring the MCP Servers tab: connected providers as a
 * grouped list with a +/− gutter; the + button opens an Add Provider form with
 * an account / API key / local-server segmented choice. Runs against the same
 * auth IPC as the onboarding wizard.
 */
function ProvidersSection({ deadProvider }: { deadProvider?: string | null }) {
  const [providers, setProviders] = useState<string[]>([]);
  const [local, setLocal] = useState<LocalProvidersSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // The Add Provider form is collapsed behind the + button (like the MCP tab's
  // Add Server) so the steady state is a calm list of connected providers.
  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<'account' | 'apikey' | 'local'>('account');
  // Disconnect of a Custom endpoint that still has copied extras needs a second
  // click: those extras live only in Stem, and a silent minus would drop them.
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  // In-flight OAuth attempt (null = none). Mirrors the onboarding wizard's
  // oauthWait/manualInput steps in miniature; completion resolves the
  // providerLogin promise, so `done` events only clear transient state.
  const [oauth, setOauth] = useState<{
    provider: AuthProviderId;
    authUrl: string | null;
    // Device-code flows (Grok) never send an auth-url: the browser opens on a
    // page that asks for this code, so dropping it would leave the user staring
    // at "Waiting for your browser…" with nothing to type.
    deviceCode: { userCode: string; verificationUri: string } | null;
    progress: string | null;
    input: { requestId: string; message: string; placeholder?: string } | null;
  } | null>(null);

  const refresh = useCallback(async () => {
    const [status, settings] = await Promise.all([window.stem.runtimeStatus(), window.stem.getSettings()]);
    setProviders(status.providers ?? []);
    setLocal(settings.localProviders);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      window.stem.onAuthEvent((e) => {
        setOauth((cur) => {
          if (!cur) return cur;
          switch (e.kind) {
            case 'auth-url':
              return { ...cur, authUrl: e.url };
            case 'device-code':
              return { ...cur, deviceCode: { userCode: e.userCode, verificationUri: e.verificationUri } };
            case 'progress':
              return { ...cur, progress: e.message };
            case 'input-request':
              return { ...cur, input: { requestId: e.requestId, message: e.message, placeholder: e.placeholder } };
            default:
              return cur;
          }
        });
      }),
    []
  );

  /** Providers changed: refresh this section AND tell App to reload status+models. */
  const changed = useCallback(async () => {
    await refresh();
    window.dispatchEvent(new CustomEvent('stem:providers-changed'));
  }, [refresh]);

  function closeForm() {
    setAdding(false);
    setMode('account');
  }

  async function startOAuth(provider: AuthProviderId) {
    setError(null);
    setOauth({ provider, authUrl: null, deviceCode: null, progress: null, input: null });
    try {
      const res = await window.stem.providerLogin(provider);
      if (!res.ok) setError(res.error ?? 'Sign-in failed.');
      else {
        await changed();
        closeForm();
      }
    } finally {
      setOauth(null);
    }
  }

  function cancelOAuth() {
    void window.stem.providerLoginCancel();
    setOauth(null);
  }

  async function disconnect(id: string) {
    setBusy(true);
    setError(null);
    setConfirmDisconnect(false);
    try {
      const res = await window.stem.disconnectProvider(id);
      if (!res.ok) setError(res.error ?? 'Could not disconnect.');
      else {
        setSelected(null);
        await changed();
      }
    } finally {
      setBusy(false);
    }
  }

  // Cloud rows come from auth.json keys; local rows from enabled servers.
  const cloudProviders = providers.filter((p) => !isLocalProviderId(p));
  const enabledLocals = local ? (Object.keys(local) as LocalProviderId[]).filter((id) => local[id].enabled) : [];
  const rows = [
    ...cloudProviders.map((id) => ({ id, local: false, detail: providerKind(id) })),
    // A custom endpoint is registered the same way but needn't be on this box, so
    // it keeps the remote icon.
    ...enabledLocals.map((id) => ({ id, local: id !== 'custom', detail: local![id].baseUrl }))
  ];

  return (
    <>
      <div className="grp-head">AI Providers</div>
      {rows.length === 0 ? (
        <div className="group">
          <div className="group-row">
            <span className="row-main">
              <em>No providers yet. Add one with the + button.</em>
            </span>
          </div>
        </div>
      ) : (
        <div className="group">
          {rows.map((row) => (
            <div
              key={row.id}
              className={`group-row${selected === row.id ? ' selected' : ''}`}
              onClick={() => {
                setConfirmDisconnect(false);
                setSelected(row.id);
              }}
            >
              <span className={`row-icon ${row.local ? 'local' : 'remote'}`}>
                {row.local ? <HardDrive size={14} /> : <Globe size={14} />}
              </span>
              <span className="row-main">
                <strong>{providerName(row.id)}</strong>
                <em>{row.detail}</em>
              </span>
              {row.id === deadProvider && (
                <button
                  className="pill danger row-reconnect"
                  title="Session expired — reconnect"
                  onClick={(e) => {
                    e.stopPropagation();
                    if ((AUTH_PROVIDER_IDS as string[]).includes(row.id)) void startOAuth(row.id as AuthProviderId);
                  }}
                >
                  Session expired · Reconnect
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="gutter">
        <button title="Add provider" onClick={() => setAdding(true)}>
          <Plus size={15} />
        </button>
        <button
          title="Reconnect selected"
          onClick={() => {
            if (selected && (AUTH_PROVIDER_IDS as string[]).includes(selected)) {
              void startOAuth(selected as AuthProviderId);
            }
          }}
          disabled={!selected || busy || !(AUTH_PROVIDER_IDS as string[]).includes(selected ?? '')}
        >
          <RefreshCw size={15} />
        </button>
        <button
          title="Disconnect selected"
          onClick={() => {
            if (!selected) return;
            if (selected === 'custom' && local?.custom.preserveModelsConfig && !confirmDisconnect) {
              setConfirmDisconnect(true);
              return;
            }
            void disconnect(selected);
          }}
          disabled={!selected || busy}
        >
          <Minus size={15} />
        </button>
      </div>
      {confirmDisconnect && selected === 'custom' && (
        <p className="muted memory-reset-confirm">
          This removes the copied extras from Stem. Your own files are not changed.{' '}
          <button className="link-btn danger" onClick={() => void disconnect('custom')}>
            Disconnect
          </button>
          <button className="link-btn" onClick={() => setConfirmDisconnect(false)}>
            Cancel
          </button>
        </p>
      )}

      {selected === 'custom' && local?.custom.enabled && !adding && (
        <>
          <div className="grp-head">Custom endpoint extras</div>
          <div className="formgroup">
            {local.custom.preserveModelsConfig ? (
              <p className="muted">
                Stem keeps these extras on the Custom endpoint and will not overwrite them until you
                replace them or disconnect.
              </p>
            ) : (
              <p className="muted">
                Paste a models.json or give a path to copy thinking and max-token extras onto this
                endpoint. Stem&apos;s other providers stay as they are.
              </p>
            )}
            <CustomOverlayFields
              locked={!!local.custom.preserveModelsConfig}
              onCopied={changed}
              onError={setError}
            />
          </div>
        </>
      )}

      {adding && (
        <>
          <div className="grp-head">Add Provider</div>
          <div className="formgroup">
            {!oauth && (
              <>
                <div className="seg-ctl">
                  <button className={mode === 'account' ? 'active' : ''} onClick={() => setMode('account')}>
                    Account
                  </button>
                  <button className={mode === 'apikey' ? 'active' : ''} onClick={() => setMode('apikey')}>
                    API key
                  </button>
                  {/* "Server", not "Local server": the same form now also takes a
                      custom endpoint, which needn't be on this machine. */}
                  <button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}>
                    Server
                  </button>
                </div>
                {mode === 'account' && (
                  <ProviderAccountForm onConnect={(id) => void startOAuth(id)} onCancel={closeForm} />
                )}
                {mode === 'apikey' && (
                  <ProviderApiKeyForm
                    onSaved={async () => {
                      await changed();
                      closeForm();
                    }}
                    onError={setError}
                    onCancel={closeForm}
                  />
                )}
                {mode === 'local' && local && (
                  <LocalServerAddForm
                    settings={local}
                    onSaved={async () => {
                      await changed();
                      closeForm();
                    }}
                    onError={setError}
                    onCancel={closeForm}
                  />
                )}
              </>
            )}

            {oauth && !oauth.input && (
              <div className="set-block">
                <span className="set-sub">Waiting for your browser…</span>
                <p className="muted">
                  Finish signing in to {providerName(oauth.provider)} in your browser — Stem continues automatically.
                </p>
                {oauth.deviceCode && (
                  <p className="muted">
                    Enter code <code className="gate-code">{oauth.deviceCode.userCode}</code> at{' '}
                    {oauth.deviceCode.verificationUri}
                  </p>
                )}
                {oauth.authUrl && (
                  <p className="muted">
                    Nothing happened? Open this link yourself: <code className="login-cmd">{oauth.authUrl}</code>
                  </p>
                )}
                {oauth.progress && <p className="muted">{oauth.progress}</p>}
                <div className="push-row">
                  <button className="push" onClick={cancelOAuth}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {oauth?.input && (
              <ProviderManualCode
                message={oauth.input.message}
                placeholder={oauth.input.placeholder}
                onSubmit={(value) => {
                  void window.stem.providerLoginRespond(oauth.input!.requestId, value);
                  setOauth({ ...oauth, input: null });
                }}
                onCancel={cancelOAuth}
              />
            )}
          </div>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </>
  );
}

/** Subscription sign-in (ChatGPT / Claude): pick the account, then Connect. */
function ProviderAccountForm({
  onConnect,
  onCancel
}: {
  onConnect: (id: AuthProviderId) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<AuthProviderId>('openai-codex');
  const choice = OAUTH_CHOICES.find((c) => c.id === provider)!;
  return (
    <div className="set-block">
      <select
        className="ifield"
        aria-label="Account provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as AuthProviderId)}
      >
        {OAUTH_CHOICES.map((c) => (
          <option key={c.id} value={c.id}>
            {providerName(c.id)}
          </option>
        ))}
      </select>
      <p className="muted">{choice.hint}</p>
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="push default" onClick={() => onConnect(provider)}>
          Connect
        </button>
      </div>
    </div>
  );
}

function ProviderManualCode({
  message,
  placeholder,
  onSubmit,
  onCancel
}: {
  message: string;
  placeholder?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <form
      className="set-block"
      onSubmit={(e) => {
        e.preventDefault();
        const value = inputRef.current?.value.trim();
        if (value) onSubmit(value);
      }}
    >
      <span className="set-sub">{message}</span>
      <input ref={inputRef} className="ifield" type="text" placeholder={placeholder ?? 'Paste the code here'} autoFocus />
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="push default">
          Continue
        </button>
      </div>
    </form>
  );
}

function ProviderApiKeyForm({
  onSaved,
  onError,
  onCancel
}: {
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
  onCancel: () => void;
}) {
  const [provider, setProvider] = useState<ApiKeyProviderId>('anthropic');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <form
      className="set-block"
      onSubmit={async (e) => {
        e.preventDefault();
        const trimmed = key.trim();
        if (!trimmed) return;
        setSaving(true);
        onError(null);
        try {
          const res = await window.stem.setApiKey(provider, trimmed);
          if (!res.ok) onError(res.error ?? 'The API key could not be saved.');
          else {
            setKey('');
            await onSaved();
          }
        } finally {
          setSaving(false);
        }
      }}
    >
      <select
        className="ifield"
        aria-label="API key provider"
        value={provider}
        onChange={(e) => setProvider(e.target.value as ApiKeyProviderId)}
      >
        {API_KEY_PROVIDER_IDS.map((id) => (
          <option key={id} value={id}>
            {providerName(id)}
          </option>
        ))}
      </select>
      <input
        className="ifield"
        type="password"
        placeholder="sk-…"
        aria-label="API key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        autoFocus
      />
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="push default" disabled={saving || !key.trim()}>
          {saving ? 'Saving…' : 'Save key'}
        </button>
      </div>
    </form>
  );
}

/**
 * Add an OpenAI-compatible server (Ollama / LM Studio / a custom endpoint): pick
 * the server, adjust the URL if needed, optionally Test, then Enable. Editing
 * later = disconnect (−) and re-add, matching the MCP servers list.
 *
 * The custom endpoint adds a key field and swaps model discovery for a typed
 * list: an arbitrary endpoint may not serve GET /v1/models at all (or may serve
 * far more than the key can reach), so Test becomes a convenience that fills the
 * field in rather than the thing that decides the catalog.
 *
 * The how-it-works prose for all three lives in the header InfoTip, not inline —
 * the fields differ by selection and a paragraph per branch buries the form.
 */
function LocalServerAddForm({
  settings,
  onSaved,
  onError,
  onCancel
}: {
  settings: LocalProvidersSettings;
  onSaved: () => Promise<void>;
  onError: (message: string | null) => void;
  onCancel: () => void;
}) {
  const [server, setServer] = useState<LocalProviderId>('ollama');
  const [baseUrl, setBaseUrl] = useState(settings.ollama.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState('');
  // API flavor for the Custom endpoint. Ollama/LM Studio ignore it — always
  // openai-completions. `null` = auto-detect (default): the Test probe
  // classifies which chat route the endpoint exposes and snaps the dropdown to
  // that value. Enable requires a concrete flavor; the button stays disabled
  // until Test succeeds or the user picks one explicitly.
  const [api, setApi] = useState<LocalProviderApi | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<LocalProviderTestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState(false);
  // The probe runs for seconds against a URL the user is still typing into, so a
  // late answer must prove it still belongs to this form before it may speak for
  // it: a crossed result restores a cleared badge and fills one endpoint's model
  // ids into another, which Enable then writes to models.json verbatim. The
  // gate covers switching servers or submitting; the value snapshot covers edits
  // to the URL or key, which leave the request itself outstanding. `formRef`
  // mirrors the live values because the post-await closure sees only the ones
  // captured when the test started.
  const testGateRef = useRef(new RequestGate());
  const formRef = useRef({ server, baseUrl, apiKey, models, api });
  formRef.current = { server, baseUrl, apiKey, models, api };
  const custom = server === 'custom';
  const modelList = models
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  function pick(id: LocalProviderId) {
    testGateRef.current.invalidate();
    setServer(id);
    setBaseUrl(settings[id].baseUrl);
    setApiKey('');
    setModels('');
    // Custom starts on Auto-detect; Ollama/LM Studio are always openai-completions.
    setApi(id === 'custom' ? null : 'openai-completions');
    setTest(null);
    setTesting(false);
    setConfirmEnable(false);
  }

  async function runTest() {
    const request = testGateRef.current.begin();
    // Auto-detect on Custom sends `undefined` so main runs the OPTIONS probe on
    // both chat routes; a concrete pick from the dropdown short-circuits that.
    // Ollama/LM Studio always name their flavor: they can't be anything but
    // OpenAI-compatible, so sending it spares them two pointless round-trips.
    const probeApi: LocalProviderApi | undefined =
      server === 'custom' ? (api ?? undefined) : 'openai-completions';
    const tested = localProbeTarget(server, baseUrl, apiKey, probeApi ?? 'openai-completions');
    const speaksForTheForm = () => {
      const form = formRef.current;
      const formProbe: LocalProviderApi =
        form.server === 'custom' ? (form.api ?? 'openai-completions') : 'openai-completions';
      return (
        testGateRef.current.isCurrent(request) &&
        probeStillDescribes(tested, localProbeTarget(form.server, form.baseUrl, form.apiKey, formProbe))
      );
    };
    setTesting(true);
    setTest(null);
    try {
      const result = await window.stem.testLocalProvider(
        tested.server,
        tested.baseUrl,
        custom ? tested.apiKey : undefined,
        probeApi
      );
      if (speaksForTheForm()) {
        setTest(result);
        // Auto-detect success snaps the dropdown to what actually answered, so
        // Enable writes the flavor that just tested green.
        if (custom && result.ok && result.api && api === null) setApi(result.api);
        // A listing endpoint that does answer saves the typing — but never
        // overwrite ids the user already chose.
        if (custom && result.ok && result.models?.length && !formRef.current.models.trim())
          setModels(result.models.join(', '));
      }
    } catch {
      if (speaksForTheForm()) setTest({ ok: false, error: 'request failed' });
    } finally {
      // Not snapshot-guarded: an edit mid-probe must still release the button.
      if (testGateRef.current.isCurrent(request)) setTesting(false);
    }
  }

  async function enable() {
    // Nothing in flight may label the form once it has been submitted — and the
    // discarded probe no longer owns the button it left in its testing state.
    if (custom && settings.custom.preserveModelsConfig && !confirmEnable) {
      setConfirmEnable(true);
      return;
    }
    testGateRef.current.invalidate();
    setTesting(false);
    setSaving(true);
    onError(null);
    try {
      const res = await window.stem.updateLocalProvider(server, {
        enabled: true,
        baseUrl: baseUrl.trim(),
        // API flavor only meaningful for `custom`; the coercion in settings
        // strips it for other providers. Enable is disabled below when a custom
        // endpoint is still on Auto-detect, so `api` is guaranteed non-null here.
        api: custom ? (api ?? 'openai-completions') : 'openai-completions',
        // Sent even when empty so re-adding a previously keyed endpoint without
        // one clears the stored key instead of silently inheriting it.
        apiKey: custom ? apiKey.trim() : '',
        models: custom ? modelList : [],
        // Typed IDs replace a copied overlay: drop extras so sync writes `{ id }`
        // stubs again instead of keeping the previous thinking/max-token flags.
        ...(custom
          ? { preserveModelsConfig: false, modelExtras: [], providerCompat: {}, providerHeaders: {} }
          : {})
      });
      if (!res.ok) onError(res.error ?? 'Could not enable the server.');
      else await onSaved();
    } finally {
      setSaving(false);
      setConfirmEnable(false);
    }
  }

  const flavorLabel = (a: LocalProviderApi): string =>
    a === 'anthropic-messages' ? 'Anthropic Messages' : 'OpenAI Chat Completions';
  const testLabel = test
    ? test.ok
      ? `${test.models?.length ?? 0} model${(test.models?.length ?? 0) === 1 ? '' : 's'} found` +
        (test.skippedNoTools ? ` (${test.skippedNoTools} without tool support hidden)` : '') +
        // When auto-detect classified the endpoint, name the flavor it picked so
        // the user can see (and re-confirm) the setting Enable will write.
        (custom && test.api ? ` — ${flavorLabel(test.api)}` : '')
      : test.error ?? 'failed'
    : null;

  return (
    <div className="set-block">
      <span className="set-sub">
        Server{' '}
        <InfoTip label="About servers">
          Any OpenAI-compatible or Anthropic-compatible server Stem can register itself, rather than one it already
          knows. <strong>Ollama</strong> and <strong>LM Studio</strong> run on this machine and report their own models
          — LM Studio loads one on first use, so its first reply can take a while. <strong>Custom endpoint</strong> is
          any other URL: a gateway, a proxy, a server elsewhere on your network. Leave the flavor on{' '}
          <em>Auto-detect</em> and Test connection classifies which chat route the endpoint exposes
          (<code>/v1/chat/completions</code> vs <code>/v1/messages</code>) before listing its models — or pick a
          flavor by hand if the server is picky about that OPTIONS probe. Stem strips a trailing <code>/v1</code>
          from your URL and lets the client add the versioned path itself. The key goes on the wire the way the
          target API expects (<code>Authorization: Bearer</code> for OpenAI-flavored servers, <code>X-Api-Key</code>
          for Anthropic). Test connection fills the model IDs in when the endpoint lists them; endpoints that serve
          no listing just need the IDs typed in. For a local vLLM (or similar) that does not advertise thinking
          flags, paste a models.json overlay or a path to one — Stem copies those extras onto this endpoint and
          does not replace Stem&apos;s Pi.
        </InfoTip>
      </span>
      <select
        className="ifield"
        aria-label="Server"
        value={server}
        onChange={(e) => pick(e.target.value as LocalProviderId)}
      >
        {(Object.keys(settings) as LocalProviderId[]).map((id) => (
          <option key={id} value={id}>
            {providerName(id)}
          </option>
        ))}
      </select>
      <input
        className="ifield"
        aria-label={`${providerName(server)} base URL`}
        placeholder={custom ? 'https://api.example.com/v1' : undefined}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      {custom && (
        <>
          <select
            className="ifield"
            aria-label="API flavor"
            value={api ?? ''}
            onChange={(e) => {
              // The probe classification depends on the chosen flavor — or on
              // its absence — so a mid-typed test loses relevance and any
              // auto-filled models were pulled under the old assumption. Clear
              // both like URL changes do.
              testGateRef.current.invalidate();
              const next = e.target.value as LocalProviderApi | '';
              setApi(next === '' ? null : next);
              setTest(null);
              setModels('');
            }}
          >
            <option value="">Auto-detect (Test to classify)</option>
            <option value="openai-completions">OpenAI Chat Completions</option>
            <option value="anthropic-messages">Anthropic Messages</option>
          </select>
          <input
            className="ifield"
            type="password"
            aria-label="API key"
            placeholder="API key (leave empty if the server needs none)"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <input
            className="ifield"
            aria-label="Model IDs"
            placeholder="Model IDs, comma-separated"
            value={models}
            onChange={(e) => setModels(e.target.value)}
          />
          <span className="set-sub">Model extras</span>
          <p className="muted">
            Optional. Paste a models.json or a path to copy thinking and max-token extras onto this
            endpoint.
          </p>
          <CustomOverlayFields
            locked={!!settings.custom.preserveModelsConfig}
            onCopied={onSaved}
            onError={onError}
            hints={{ baseUrl, apiKey, api }}
          />
        </>
      )}
      <div className="retrieval-test">
        <button
          className="retrieval-test-btn"
          onClick={() => void runTest()}
          disabled={testing}
          title={testing ? 'Testing…' : 'Test connection'}
          aria-label={`Test ${providerName(server)} connection`}
        >
          <Plug size={14} />
          <span>{testing ? 'Testing…' : 'Test connection'}</span>
        </button>
        {!testing && testLabel && (
          <span className={`retrieval-test-status ${test!.ok ? 'ok' : 'err'}`} title={testLabel}>
            {test!.ok ? <Check size={12} /> : <X size={12} />}
            {testLabel}
          </span>
        )}
      </div>
      <div className="push-row">
        <button type="button" className="push" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="push default"
          disabled={saving || !baseUrl.trim() || (custom && modelList.length === 0) || (custom && api === null)}
          onClick={() => void enable()}
        >
          {saving ? 'Enabling…' : confirmEnable ? 'Replace extras and enable' : 'Enable'}
        </button>
      </div>
      {confirmEnable && (
        <p className="muted">
          Enable with typed IDs replaces the copied extras on this endpoint. Your own files are not
          changed.
        </p>
      )}
    </div>
  );
}

/**
 * Paste JSON or a path to a Pi models.json; copy one provider's extras onto
 * Stem's Custom endpoint. Does not replace Stem's Pi.
 */
function CustomOverlayFields({
  locked,
  onCopied,
  onError,
  hints
}: {
  locked: boolean;
  onCopied: () => Promise<void>;
  onError: (message: string | null) => void;
  hints?: { baseUrl?: string; apiKey?: string; api?: LocalProviderApi | null };
}) {
  const [json, setJson] = useState('');
  const [path, setPath] = useState('');
  const [providers, setProviders] = useState<PiModelsOverlayProvider[] | null>(null);
  const [picked, setPicked] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  function source(): { json?: string; path?: string } {
    return json.trim() ? { json: json.trim() } : { path: path.trim() };
  }

  function resetPreview() {
    setProviders(null);
    setPicked('');
    setConfirmReplace(false);
  }

  async function preview() {
    setBusy(true);
    onError(null);
    resetPreview();
    try {
      const res = await window.stem.previewPiModels(source());
      if (!res.ok) onError(res.error ?? 'Could not read that overlay.');
      else {
        setProviders(res.providers ?? []);
        if (res.providers?.length === 1) setPicked(res.providers[0].id);
      }
    } catch {
      onError('Could not read that overlay.');
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!picked) return;
    if (locked && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setBusy(true);
    onError(null);
    try {
      const res = await window.stem.copyPiModels(source(), picked, {
        ...(hints?.baseUrl?.trim() ? { baseUrl: hints.baseUrl.trim() } : {}),
        ...(hints?.apiKey !== undefined ? { apiKey: hints.apiKey } : {}),
        ...(hints?.api ? { api: hints.api } : {})
      });
      if (!res.ok) onError(res.error ?? 'Could not copy extras onto Custom.');
      else await onCopied();
    } catch {
      onError('Could not copy extras onto Custom.');
    } finally {
      setBusy(false);
      setConfirmReplace(false);
    }
  }

  return (
    <div className="set-block">
      <textarea
        className="ci-textarea"
        rows={5}
        aria-label="models.json overlay"
        placeholder='Paste models.json here — {"providers": { "vllm": { … } }}'
        value={json}
        onChange={(e) => {
          setJson(e.target.value);
          resetPreview();
        }}
      />
      <input
        className="ifield"
        aria-label="Path to models.json"
        placeholder="Or a path to a models.json file"
        value={path}
        disabled={!!json.trim()}
        onChange={(e) => {
          setPath(e.target.value);
          resetPreview();
        }}
      />
      <div className="memory-view-actions">
        <button
          type="button"
          className="link-btn"
          disabled={busy || (!json.trim() && !path.trim())}
          onClick={() => void preview()}
        >
          {busy && !providers ? 'Reading…' : 'Read overlay'}
        </button>
      </div>
      {providers && providers.length > 1 && (
        <select
          className="ifield"
          aria-label="Provider to copy"
          value={picked}
          onChange={(e) => {
            setPicked(e.target.value);
            setConfirmReplace(false);
          }}
        >
          <option value="">Choose a provider</option>
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
              {p.modelIds.length ? ` (${p.modelIds.join(', ')})` : ''}
            </option>
          ))}
        </select>
      )}
      {providers && providers.length === 1 && (
        <p className="muted">
          {providers[0].id}
          {providers[0].modelIds.length ? ` — ${providers[0].modelIds.join(', ')}` : ''}
        </p>
      )}
      {providers && (
        <div className="memory-view-actions">
          <button
            type="button"
            className="link-btn"
            disabled={busy || !picked}
            onClick={() => void copy()}
          >
            {busy && providers ? 'Copying…' : confirmReplace ? 'Replace extras' : 'Copy into Stem'}
          </button>
        </div>
      )}
      {confirmReplace && (
        <p className="muted">
          This replaces the extras already on Custom. Stem&apos;s Pi and your own files stay as they
          are.
        </p>
      )}
    </div>
  );
}
