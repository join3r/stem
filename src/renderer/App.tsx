import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SquarePen, PanelRight } from 'lucide-react';
import type {
  AuthProviderId,
  ChatListResult,
  ChatSummary,
  EscapeAction,
  MessageMeta,
  ModelSummary,
  ReleaseNotesSnapshot,
  RuntimeStatus,
  ScheduledTask,
  TaskNotifyPayload,
  TurnAttachment,
  ThreadStatus,
  UpdateStatus
} from '../shared/types';
import { AUTH_PROVIDER_IDS, providerName } from '../shared/providers';
import { emptyInboxState, isUnread, placement } from '../shared/inbox';
import { resendAttachments } from './attachments';
import { ChatView, type ChatViewHandle } from './chat/ChatView';
import { OnboardingGate } from './onboarding/OnboardingGate';
import { ShortcutHint, glyphsFor, useShortcut } from './shortcuts';
import { ManagePanel } from './manage/ManagePanel';
import { McpApprovalCard } from './manage/McpApprovalCard';
import { InstructionsApprovalCard } from './manage/InstructionsApprovalCard';
import { SkillApprovalCard } from './manage/SkillApprovalCard';
import { SkillsResetDialog } from './manage/SkillsResetDialog';
import { ExecApprovalCard } from './manage/ExecApprovalCard';
import { DeleteThreadDialog } from './DeleteThreadDialog';
import { SnoozeMenu } from './chats/SnoozeMenu';
import type { InboxSelectionApi } from './chats/ChatList';
import { ActivityIndicator } from './ui/ActivityIndicator';
import { TaskAlertModal } from './TaskAlertModal';
import { ReleaseNotesModal } from './ReleaseNotesModal';
import { DropOverlay } from './files/DropOverlay';
import { useWebSearch } from './webSearch';
import { useAutoHideScroll } from './hooks/useAutoHideScroll';
import { useOffline } from './hooks/useServerReachable';
import { useShallowStable } from './hooks/useShallowStable';
import {
  EMPTY_STATE,
  appendSystemMessage,
  mergeDraftIntoReal,
  mergeHydratedThread,
  mergeQuickChatHandoff,
  type ThreadState
} from './chatState';
import {
  applyLiveTurns,
  attachBackendEvents,
  createSessionCore,
  deleteFromTurn,
  interruptActiveTurn,
  removeFailedSend,
  rerunFromTurn as rerunFromTurnShared,
  sendTurn,
  type SessionCore
} from './session/turns';
import { useThreadStates } from './session/store';
import { deletePendingIfCurrent, rekeyPendingIfCurrent } from './pendingTurn';
import { RequestGate } from './requestGate';
import { dismissTaskAlert, enqueueTaskAlert } from './taskAlerts';

// Sentinel key for a brand-new chat that has no backend thread id yet. Its slice is
// migrated to the real thread id once the first turn returns one.
const DRAFT = '__draft__';

// "This smells like an auth failure" match on a failed turn's error text. Used as
// the fallback classifier for API-key/local providers, where the getApiKey probe
// can't validate a stored key server-side. (OAuth providers are classified by the
// authoritative probe instead, so they don't rely on this.) A false positive only
// shows the re-sign-in screen, which has a "Back to chat" escape — but keep it tight.
const AUTH_ERROR_RE =
  /\b401\b|\b403\b|unauthori[sz]ed|invalid[_ ]?(api[_ ]?key|grant|token)|token.*(expired|revoked)|re-?authenticat|oauth|credential|sign[- ]?in|log[- ]?in.*(expired|required)/i;

export default function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  // Per-thread run/conversation state, keyed by thread id (or DRAFT for a new,
  // uncreated chat), owned by the shared session core. This is what lets several
  // chats run concurrently — each has its own messages/running/streaming slice
  // that events route into by threadId. The store reads synchronously, so async
  // continuations (startTurn resolution, openChat, events) never see stale state.
  const coreRef = useRef<SessionCore | null>(null);
  if (!coreRef.current) coreRef.current = createSessionCore();
  const core = coreRef.current;
  const threadStates = useThreadStates(core.store);
  const [showInspector, setShowInspector] = useState(true);
  // First-run wizard state (null until settings load). Completed=false + not
  // authenticated → the full welcome wizard; completed=true → the compact
  // re-sign-in variant.
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  // Set when a turn fails with an auth-looking error while status.ok — an expired
  // refresh token still leaves auth.json on disk, so status() can't detect it.
  // Renders the re-auth wizard over the app; cleared on re-login or dismiss.
  const [authProblem, setAuthProblem] = useState<string | null>(null);
  // The specific dead provider behind an authProblem, so the re-auth gate can
  // deep-link straight to it ("Reconnect ChatGPT") instead of the generic chooser.
  const [authProvider, setAuthProvider] = useState<AuthProviderId | null>(null);
  // Whether the full-screen re-auth gate is open. Detection only raises the
  // non-blocking banner (authProblem); the gate opens deliberately when the user
  // clicks Reconnect, so a dead token never hijacks the screen.
  const [reauthOpen, setReauthOpen] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // The active thread queued for deletion behind the ⌃X confirm popup (null = closed).
  const [pendingDelete, setPendingDelete] = useState<{ threadId: string; title: string } | null>(null);
  // The snooze picker opened by ⌘⇧S, and the threads it will apply to. The chat
  // list has its own for the click path; this one has to work without the list.
  const [snoozePicker, setSnoozePicker] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  // Scheduled tasks: the full list (drives chat badges) + FIFO notify_user alerts.
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [taskAlerts, setTaskAlerts] = useState<TaskNotifyPayload[]>([]);
  const taskAlert = taskAlerts[0] ?? null;
  // "What's new": set once, after onboarding, when this build has notes the user
  // hasn't been shown. Null the rest of the time — including for a fresh install,
  // which main seeds as already-seen so it never opens on a first launch.
  const [releaseNotes, setReleaseNotes] = useState<ReleaseNotesSnapshot | null>(null);
  const [releaseNotesShowAll, setReleaseNotesShowAll] = useState(false);
  // A newer release, as main last reported it. The banner only rises for the
  // two states worth interrupting for — downloaded-and-waiting (`ready`) or
  // available on an install that can't fetch it itself (`manual`) — and a
  // dismissal holds for this run; the update itself waits in Settings → App.
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  // The dialog only opens when the preference is on (main withholds `unseen`
  // otherwise), so `true` is the state it opens in — not an assumption.
  const [releaseNotesShowOnUpdate, setReleaseNotesShowOnUpdate] = useState(true);
  // Display-only mirror of pendingDraftFolderRef so the empty-state welcome can
  // tell the user which folder a new draft will be saved in (the ref itself is
  // non-reactive, used only on the send path).
  const [draftFolderId, setDraftFolderId] = useState<string | null>(null);
  // Memory debug: when on, the Facts tab previews which facts the current draft
  // would inject. Reset on send (the draft is consumed) and mirrors the live draft.
  const [previewActive, setPreviewActive] = useState(false);
  const [previewDraft, setPreviewDraft] = useState('');
  const [chatList, setChatList] = useState<ChatListResult>({
    chats: [],
    folders: [],
    inbox: emptyInboxState()
  });
  // Optimistic rows for chats created this session that the backend's thread/list hasn't
  // returned yet (a brand-new thread isn't listed until its first turn persists).
  // Keyed by threadId; dropped once the real list includes them.
  const [pendingChats, setPendingChats] = useState<Record<string, ChatSummary>>({});
  const inspectorRef = useAutoHideScroll<HTMLElement>();
  // Imperative handle to the active ChatView so the drop overlay can push files
  // ("Add to this conversation") into its composer.
  const chatViewRef = useRef<ChatViewHandle>(null);
  const onDropToChat = useCallback((files: File[]) => chatViewRef.current?.addAttachments(files), []);
  // Bumped by `newConversation`; the effect beside it focuses the composer.
  const [focusComposerSeq, setFocusComposerSeq] = useState(0);

  // Navigation state the event pipeline and IPC continuations need synchronously.
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  // Threads whose next open must reload from disk: a scheduled run streamed into a
  // thread the user never opened this session, so any slice built from background
  // events is partial (just the run, no prior history). Forcing a reload rebuilds
  // the full transcript — including the run, collapsed via its persisted marker.
  const forceReloadRef = useRef<Set<string>>(new Set());
  // Bumped every time the DRAFT slice is reset (New chat / Quick Chat). Captured
  // at send time so a turn that resolves late only adopts its real thread id when
  // the draft it was sent for is still the current one — otherwise the user has
  // moved on to a fresh draft and we must not steal focus into the old thread.
  const draftSeqRef = useRef(0);
  // Only the latest asynchronous sidebar open may select/replace a chat.
  const openGateRef = useRef(new RequestGate());
  // Folder a pending new draft should land in once its real thread is created
  // (set by the per-folder New-chat button; null for a root-level new chat).
  const pendingDraftFolderRef = useRef<string | null>(null);
  // Threads deleted this session — late backend events for them are ignored so a
  // dying turn can't resurrect a removed chat's slice.
  const deletedThreadsRef = useRef(new Set<string>());

  // The currently visible slice. DRAFT when no real thread is open yet.
  const activeKey = activeThreadId ?? DRAFT;
  const cur = threadStates[activeKey] ?? EMPTY_STATE;

  // Patch one thread's slice (functional, so concurrent updates never clobber).
  const setThread = useCallback(
    (key: string, patch: (s: ThreadState) => Partial<ThreadState>) => core.store.patch(key, patch),
    [core]
  );

  // Status-dot map for the chat rows, derived from the per-thread slices. Shallow-
  // stabilized so streaming deltas (new slice objects, same statuses) don't defeat
  // ManagePanel's memo.
  const threadStatuses = useShallowStable(
    useMemo(() => {
      const out: Record<string, ThreadStatus> = {};
      for (const [tid, s] of Object.entries(threadStates)) {
        if (tid === DRAFT) continue;
        out[tid] = s.status;
      }
      return out;
    }, [threadStates])
  );

  // Once the backend's list includes an optimistic chat, drop our stand-in for it so the
  // authoritative title/folder takes over (and we don't render a duplicate).
  useEffect(() => {
    setPendingChats((prev) => {
      const known = new Set(chatList.chats.map((c) => c.threadId));
      let changed = false;
      const next: Record<string, ChatSummary> = {};
      for (const [id, summary] of Object.entries(prev)) {
        if (known.has(id)) changed = true;
        else next[id] = summary;
      }
      return changed ? next : prev;
    });
  }, [chatList]);

  // Sidebar data: the backend's chats plus any session-created chats it hasn't listed yet,
  // so a brand-new chat has a row (and stays selectable) the moment it's created.
  const displayList = useMemo<ChatListResult>(() => {
    const known = new Set(chatList.chats.map((c) => c.threadId));
    const extras = Object.values(pendingChats).filter((c) => !known.has(c.threadId));
    return extras.length ? { ...chatList, chats: [...extras, ...chatList.chats] } : chatList;
  }, [chatList, pendingChats]);

  // Unread threads sitting in the Inbox — the count badge on the Chats tab. Only
  // the Inbox counts: an archived or snoozed thread is one you've decided about,
  // and a badge you can't clear without un-archiving would be a nag, not a signal.
  const inboxUnreadCount = useMemo(
    () =>
      displayList.chats.filter(
        (c) => placement(c, displayList.inbox, Date.now()) === 'inbox' && isUnread(c, displayList.inbox)
      ).length,
    [displayList]
  );

  // Thread ids that own at least one scheduled task → a clock badge on those chat rows.
  const scheduledThreadIds = useMemo(() => new Set(tasks.map((t) => t.threadId)), [tasks]);

  // Folder name shown on the new-chat welcome screen — only while a fresh draft is
  // current (activeThreadId === null) and it targets a folder.
  const draftFolderName = useMemo(
    () =>
      activeThreadId === null && draftFolderId
        ? chatList.folders.find((f) => f.id === draftFolderId)?.name ?? null
        : null,
    [activeThreadId, draftFolderId, chatList.folders]
  );

  // Model / effort / speed — per-turn overrides, remembered across launches.
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelId, setModelId] = useState<string | null>(() => localStorage.getItem('stem.modelId'));
  const [effort, setEffort] = useState<string | null>(() => localStorage.getItem('stem.effort'));
  const [serviceTier, setServiceTier] = useState<string | null>(
    () => localStorage.getItem('stem.serviceTier')
  );
  // Output format for the AI's reply — 'mdx' (rich components, default) or 'md' (plain Markdown).
  const [format, setFormat] = useState<'md' | 'mdx'>(
    () => (localStorage.getItem('stem.format') === 'md' ? 'md' : 'mdx')
  );
  // Web search for main-window turns. Unlike the pickers above this one lives in
  // settings rather than localStorage — it is the same switch Settings → Chat
  // shows, and the server reads it when the turn starts.
  const { enabled: webSearch, toggle: toggleWebSearch } = useWebSearch('main');
  const selectedModel = models.find((m) => m.id === modelId) ?? null;
  // Ref mirrors so the (mount-only) backend-event handler can resolve the failed
  // turn's provider from the latest models/selection without a stale closure.
  const modelsRef = useRef(models);
  modelsRef.current = models;
  const modelIdRef = useRef(modelId);
  modelIdRef.current = modelId;
  const authProviderRef = useRef(authProvider);
  authProviderRef.current = authProvider;

  // Escape-to-retract behavior (Settings → App → Input). Read from persisted settings;
  // re-read on window focus so a change in the Settings tab applies without a restart.
  const [escapeAction, setEscapeAction] = useState<EscapeAction>('off');
  useEffect(() => {
    const load = () => {
      if (window.stem)
        window.stem.getSettings().then((s) => {
          setEscapeAction(s.escapeAction);
          setOnboardingCompleted(s.onboarding.completed);
        });
    };
    load();
    // Re-read on focus (covers external edits) and on the in-window event the
    // Settings tab fires when the user changes the mode, so it applies immediately.
    const onChanged = (e: Event) => setEscapeAction((e as CustomEvent<EscapeAction>).detail);
    window.addEventListener('focus', load);
    window.addEventListener('stem:escape-action', onChanged as EventListener);
    return () => {
      window.removeEventListener('focus', load);
      window.removeEventListener('stem:escape-action', onChanged as EventListener);
    };
  }, []);

  // Raise the release notes once the wizard is behind us (main returns nothing
  // unseen before that). Fetched exactly once per launch — the notes ship inside
  // the build, so they cannot change while the app is open.
  const releaseNotesAskedRef = useRef(false);
  useEffect(() => {
    if (!onboardingCompleted || releaseNotesAskedRef.current || !window.stem) return;
    releaseNotesAskedRef.current = true;
    void window.stem.getReleaseNotes().then((snapshot) => {
      if (snapshot.unseen.length > 0) setReleaseNotes(snapshot);
    });
  }, [onboardingCompleted]);

  // Where the updater stands: asked once (the first push can predate this
  // window), then pushed on every change.
  useEffect(() => {
    if (!window.stem) return;
    void window.stem.getUpdateStatus().then(setUpdate);
    return window.stem.onUpdateStatus(setUpdate);
  }, []);

  // A retract request hands its captured text/attachments here; ChatView applies it
  // to the composer on the next render. Routed through App (not a direct setDraft)
  // because retracting a brand-new chat deletes it and remounts ChatView — the
  // restore must survive that remount, so whichever instance is mounted picks it up.
  const [pendingRestore, setPendingRestore] = useState<{
    text: string;
    attachments: TurnAttachment[];
    nonce: number;
  } | null>(null);
  const restoreNonceRef = useRef(0);

  const [bridgeError, setBridgeError] = useState<string | null>(null);

  /** The server has stopped answering: everything below is this Mac's cache. */
  const offline = useOffline();

  const refreshStatus = useCallback(async () => {
    if (!window.stem) {
      setBridgeError('The preload bridge failed to load (window.stem is undefined).');
      return;
    }
    setStatus(await window.stem.runtimeStatus());
  }, []);

  const refreshChats = useCallback(async () => {
    if (!window.stem) return;
    setChatList(await window.stem.listChats());
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Load the chat list once the runtime is ready (thread/list needs the server up).
  useEffect(() => {
    if (status?.ok) refreshChats();
  }, [status?.ok, refreshChats]);

  // The server changed the list without being asked — a background subject write
  // that has just renamed a thread. Push, so the row updates the moment it lands
  // instead of on whatever the next refresh happens to be.
  useEffect(() => window.stem?.onChatsChanged(() => void refreshChats()), [refreshChats]);

  // Fetch the model catalog once the runtime is ready; seed defaults from the backend
  // (the `isDefault` model + its default effort) when nothing is remembered yet.
  const refreshModels = useCallback(() => {
    window.stem.listModels().then((list) => {
      setModels(list);
      setModelId((cur) => {
        if (cur && list.some((m) => m.id === cur)) return cur;
        const fallback = list.find((m) => m.isDefault) ?? list[0];
        if (fallback) {
          setEffort((e) => e ?? fallback.defaultEffort);
          return fallback.id;
        }
        return cur;
      });
    });
  }, []);
  useEffect(() => {
    if (status?.ok) refreshModels();
  }, [status?.ok, refreshModels]);

  // Providers added/removed in Settings: the auth set (and with it the model
  // catalog) changed under us — re-pull both. Fired by the AI-providers section.
  useEffect(() => {
    const onChanged = () => {
      void refreshStatus();
      refreshModels();
    };
    window.addEventListener('stem:providers-changed', onChanged);
    return () => window.removeEventListener('stem:providers-changed', onChanged);
  }, [refreshStatus, refreshModels]);

  // Persist the remembered selections. The model goes to the SERVER as well as
  // localStorage: every background job (chat subjects, memory, skills curation,
  // the safety check) falls back to "the model you chat with", and for years
  // that meant `defaults.model`, which was written once at sign-in and never
  // again. Anyone who changed their model left the whole background running on
  // whatever the wizard picked — and Quick Chat's "Same as main" named it.
  useEffect(() => {
    if (!modelId) return;
    localStorage.setItem('stem.modelId', modelId);
    void window.stem.updateDefaults({ model: modelId }).catch(() => undefined);
  }, [modelId]);
  useEffect(() => {
    if (effort) localStorage.setItem('stem.effort', effort);
  }, [effort]);
  useEffect(() => {
    if (serviceTier) localStorage.setItem('stem.serviceTier', serviceTier);
    else localStorage.removeItem('stem.serviceTier');
  }, [serviceTier]);
  useEffect(() => {
    localStorage.setItem('stem.format', format);
  }, [format]);

  // Switching models: clamp effort to what the new model supports, and drop a
  // Fast selection when the new model has no priority (Fast) tier.
  const onSelectModel = useCallback(
    (id: string) => {
      const m = models.find((x) => x.id === id);
      setModelId(id);
      if (m) {
        setEffort((e) => (e && m.supportedEfforts.includes(e) ? e : m.defaultEffort));
        if (!m.serviceTiers.some((t) => t.id === 'priority')) setServiceTier(null);
      }
    },
    [models]
  );

  // Classify a failed turn (or a pi death during one) as an auth problem or not.
  // status.ok can't flip by itself — an expired token still leaves auth.json — so
  // this is how the re-sign-in screen gets raised. For OAuth providers we ask the
  // authoritative getApiKey probe (does the credential still yield a key?); for
  // API-key/local providers, which the probe can't validate server-side, we fall
  // back to the error-text heuristic.
  const handlePossibleAuthFailure = useCallback(
    async (err: string | undefined, turnId?: string): Promise<void> => {
      const modelForTurn = (turnId && core.turnMeta.get(turnId)?.model) || modelIdRef.current;
      const provider = modelForTurn ? modelsRef.current.find((m) => m.id === modelForTurn)?.provider : undefined;
      if (provider && (AUTH_PROVIDER_IDS as string[]).includes(provider)) {
        try {
          const { alive } = await window.stem.checkAuth(provider);
          if (!alive) {
            setAuthProblem(err ?? 'Your session has expired.');
            setAuthProvider(provider as AuthProviderId);
          }
          return;
        } catch {
          // Probe unavailable — fall through to the heuristic below.
        }
      }
      if (err && AUTH_ERROR_RE.test(err)) setAuthProblem(err);
    },
    [core]
  );

  // Install the shared backend-event pipeline: deltas coalesced to one state
  // update per frame, settled-turn/pending bookkeeping handled by the core; this
  // host supplies routing (drop deleted threads) and the status-dot policy.
  useEffect(() => {
    const events = attachBackendEvents(core, {
      routeEvent: (threadId) =>
        threadId && !deletedThreadsRef.current.has(threadId) ? threadId : null,
      settledStatus: (method, id) => {
        // A settled turn bumps the thread's mtime, which is what the Inbox reads as
        // "something happened here". If it happened in the chat you're looking at —
        // window focused, so you're actually seeing the answer — stamp it read so
        // your own reply can't mark the thread unread; otherwise leave it — the
        // mtime now sits past readAt and the row goes bold on its own (a blurred
        // window counts as away, and the reading-marks-read effect below consumes
        // the unread when focus returns). Either way refresh the list so the Inbox
        // and the tab badge stay honest.
        if (id) {
          if (id === activeThreadIdRef.current && document.hasFocus())
            void window.stem
              .setInboxRead([id], true)
              .then(setChatList)
              .catch(() => {});
          else void refreshChats();
        }
        if (method === 'turn/failed') return 'error';
        if (method === 'turn/completed') {
          // Mark unread (a solid dot) if it finished while another chat was open.
          return id === activeThreadIdRef.current ? 'idle' : 'done';
        }
        return 'idle';
      },
      onTurnFailed: (error, turnId) => void handlePossibleAuthFailure(error, turnId),
      // If a turn was in flight when pi died, a dead token may have killed it at
      // startup/stream (which never reaches turn/failed), so classify it too.
      onProcessExit: (wasRunning) => {
        if (wasRunning) void handlePossibleAuthFailure(undefined);
      }
    });
    return events.detach;
  }, [core, handlePossibleAuthFailure, refreshChats]);

  // Scheduled tasks: keep the list in sync (drives chat badges + the Tasks tab),
  // insert a collapsed run row into an open thread when a run starts, and raise the
  // alert modal when a run calls notify_user.
  useEffect(() => {
    window.stem.listTasks().then(setTasks);
    const offChanged = window.stem.onTasksChanged(setTasks);
    const offRun = window.stem.onScheduledRun((run) => {
      // If the thread isn't loaded, don't seed a partial slice from background events —
      // mark it so the next open reloads the full transcript from disk (where the run
      // is persisted with its collapse marker).
      if (!core.store.getThread(run.threadId)) {
        forceReloadRef.current.add(run.threadId);
        return;
      }
      setThread(run.threadId, (s) => {
        const id = `user-sched-${run.turnId}`;
        if (s.messages.some((m) => m.id === id)) return {};
        const bubble = {
          id,
          role: 'user' as const,
          content: run.prompt,
          turnId: run.turnId,
          scheduled: { at: run.at }
        };
        return { messages: [...s.messages, bubble] };
      });
    });
    const offNotify = window.stem.onTaskNotify((alert) => {
      setTaskAlerts((queue) => enqueueTaskAlert(queue, alert));
    });
    return () => {
      offChanged();
      offRun();
      offNotify();
    };
  }, [core, setThread]);

  const onSend = useCallback(
    async (text: string, attachments: TurnAttachment[] = []) => {
      // Where this turn's state lives: the open thread, or DRAFT for a new chat.
      const sendKey = activeThreadIdRef.current ?? DRAFT;
      // Capture ownership BEFORE any asynchronous work. A disk-image read must
      // not let navigation reclassify this send as belonging to a newer draft.
      const sendSeq = draftSeqRef.current;
      const sendFolder = pendingDraftFolderRef.current;
      const meta: MessageMeta = { model: modelId ?? undefined, effort: effort ?? undefined, serviceTier };
      // The draft is consumed — drop back to showing this chat's last injected set.
      setPreviewActive(false);
      await sendTurn(core, {
        key: sendKey,
        text,
        attachments,
        meta,
        isNewChat: sendKey === DRAFT,
        ...(sendKey === DRAFT ? { draftGeneration: sendSeq, captureDraftMessages: true } : {}),
        start: (input) =>
          window.stem.startTurn({
            input: input.text,
            threadId: sendKey === DRAFT ? undefined : sendKey,
            model: modelId ?? undefined,
            effort: effort ?? undefined,
            serviceTier,
            format,
            attachments: input.attachments.length ? input.attachments : undefined
          }),
        onStarted: (result, { pending, alreadySettled, userMsgId }) => {
          if (sendKey === DRAFT && result.threadId) {
            // First turn of a new chat. Adopt the real id only if this draft is
            // still the current one — i.e. the user hasn't opened another chat and
            // hasn't pressed New chat again since we sent.
            const realId = result.threadId;
            // Follow the slice onto the real id so a retract keyed by the active
            // thread id (now realId) still finds this send.
            pending.threadId = realId;
            if (!rekeyPendingIfCurrent(core.pendingSends, DRAFT, realId, pending)) {
              // A newer DRAFT replaced this key; keep it intact while retaining the
              // older background turn under its now-known real identity.
              core.pendingSends.set(realId, pending);
            }
            if (alreadySettled) deletePendingIfCurrent(core.pendingSends, realId, pending);
            const stillMine = draftSeqRef.current === sendSeq && activeThreadIdRef.current === null;
            core.store.update((prev) => {
              const next = { ...prev };
              const draftSnapshot: ThreadState = {
                ...EMPTY_STATE,
                messages: pending.draftMessages ?? [],
                running: !alreadySettled,
                activeTurnId: alreadySettled ? null : result.turnId ?? null,
                status: alreadySettled ? 'idle' : 'running'
              };
              const live = prev[realId];
              const draftSource = stillMine ? prev[DRAFT] ?? draftSnapshot : draftSnapshot;
              // Always move the sent snapshot to its real thread. Only focus/DRAFT
              // deletion are conditional on this still being the visible draft.
              const merged = mergeDraftIntoReal(draftSource, live);
              if (stillMine) {
                delete next[DRAFT];
              }
              const messages = merged.messages.map((m) => {
                if (m.id === userMsgId) return { ...m, turnId: result.turnId ?? undefined };
                if (result.turnId && m.id === `assistant-${result.turnId}` && !m.meta) {
                  return { ...m, meta: core.turnMeta.get(result.turnId) };
                }
                return m;
              });
              next[realId] = live
                ? { ...merged, messages }
                : {
                    ...merged,
                    messages,
                    running: !alreadySettled,
                    activeTurnId: alreadySettled ? null : result.turnId ?? null,
                    status: alreadySettled ? 'idle' : 'running'
                  };
              return next;
            });
            if (stillMine) {
              // Keep imperative handlers (notably Escape/Stop) on the real key in
              // the brief gap before React commits this state transition.
              activeThreadIdRef.current = realId;
              setActiveThreadId(realId);
              pendingDraftFolderRef.current = null;
            }
            // Show a sidebar row immediately — the backend won't list this thread until its
            // first turn persists, so without this the chat (and its highlight) is
            // invisible mid-turn and the user can't switch back to it.
            setPendingChats((p) => ({
              ...p,
              [realId]: {
                threadId: realId,
                title: text.trim() || 'New chat',
                folderId: sendFolder ?? null,
                createdAt: Date.now(),
                updatedAt: Date.now()
              }
            }));
            // Persist the folder assignment (if any) so it survives once the backend lists
            // the thread; otherwise just refresh the list.
            if (sendFolder) window.stem.setChatFolder(realId, sendFolder).then(setChatList);
            else refreshChats();
          } else {
            // Existing thread: record the turn id and stamp it onto the user bubble.
            pending.threadId = sendKey;
            if (alreadySettled) deletePendingIfCurrent(core.pendingSends, sendKey, pending);
            setThread(sendKey, (s) => ({
              activeTurnId: alreadySettled ? null : result.turnId ?? null,
              messages: s.messages.map((m) =>
                m.id === userMsgId ? { ...m, turnId: result.turnId ?? undefined } : m
              )
            }));
          }
        }
      });
    },
    [core, refreshChats, modelId, effort, serviceTier, format, setThread]
  );

  // Quick Chat hand-off → main window: adopt the overlay's conversation as the
  // active chat, seeding its slice from the overlay's in-memory messages (so it's
  // complete with user bubbles even mid-stream). Any still-in-flight turn now
  // streams here, since the main process re-routes the thread's events to us.
  useEffect(() => {
    return window.stem.onQuickChatAdopt((payload) => {
      const {
        threadId,
        messages: adopted,
        model,
        effort: aEffort,
        serviceTier: aTier,
        activeTurnId: transferredTurnId,
        running: transferredRunning
      } = payload;
      // A handoff is navigation away from any unresolved local draft. Its eventual
      // start response may still migrate in the background, but cannot steal focus.
      draftSeqRef.current += 1;
      openGateRef.current.invalidate();
      deletedThreadsRef.current.delete(threadId);
      const activeId = transferredTurnId ?? [...adopted].reverse().find((m) => m.turnId)?.turnId ?? null;
      if (activeId) core.turnMeta.set(activeId, { model: model ?? undefined, effort: aEffort ?? undefined, serviceTier: aTier });
      core.store.update((prev) => {
        const existing = prev[threadId];
        return { ...prev, [threadId]: mergeQuickChatHandoff(existing, payload) };
      });
      if (transferredRunning && transferredTurnId) {
        const lastUser = [...adopted].reverse().find((m) => m.role === 'user');
        if (lastUser) {
          core.pendingSends.set(threadId, {
            promise: Promise.resolve({ threadId, turnId: transferredTurnId }),
            turnId: transferredTurnId,
            threadId,
            isNewChat: adopted.filter((m) => m.role === 'user').length === 1,
            text: lastUser.content,
            attachments: resendAttachments(lastUser)
          });
        }
      }
      setActiveThreadId(threadId);
      setPendingChats((p) => ({
        ...p,
        [threadId]: {
          threadId,
          title: adopted.find((m) => m.role === 'user')?.content.trim() || 'New chat',
          folderId: null,
          createdAt: Date.now(),
          updatedAt: Date.now()
        }
      }));
      refreshChats();
    });
  }, [core, refreshChats]);

  // Quick Chat session started → show the thread in the sidebar immediately
  // (the backend won't list it until its first turn persists), reusing the optimistic
  // pending-chats mechanism.
  useEffect(() => {
    return window.stem.onQuickChatSessionStarted(({ threadId, title }) => {
      setPendingChats((p) => ({
        ...p,
        [threadId]: { threadId, title: title.trim() || 'New chat', folderId: null, createdAt: Date.now(), updatedAt: Date.now() }
      }));
    });
  }, []);

  // Main can be recreated after a task notification or Quick Chat handoff. Tell
  // it only after all push-event effects above have installed their listeners,
  // then main flushes anything that arrived during startup.
  useEffect(() => {
    window.stem.rendererReady();
  }, []);

  const onInterrupt = useCallback(async () => {
    // Stops only the chat you're viewing; background chats keep running.
    const key = activeThreadIdRef.current ?? DRAFT;
    await interruptActiveTurn(core, {
      pendingKey: key,
      resolveTargetKey: (pending) => pending?.threadId ?? activeThreadIdRef.current ?? key
    });
  }, [core]);

  // Sign-in finished (wizard or re-auth): adopt the fresh status and clear any
  // auth-failure gate so the app (re)mounts its normal effects.
  const onAuthenticated = useCallback((next: RuntimeStatus) => {
    setAuthProblem(null);
    setAuthProvider(null);
    setReauthOpen(false);
    setOnboardingCompleted(true);
    setStatus(next);
  }, []);

  // Proactive liveness: probe the active model's OAuth provider on launch and when
  // the window regains focus, so the "session expired" banner/dot appears before a
  // send fails. Reactive detection (handlePossibleAuthFailure) is the other source.
  const probeActiveAuth = useCallback(async () => {
    const provider = modelsRef.current.find((m) => m.id === modelIdRef.current)?.provider;
    if (!provider || !(AUTH_PROVIDER_IDS as string[]).includes(provider)) return;
    try {
      const { alive } = await window.stem.checkAuth(provider);
      if (!alive) {
        setAuthProblem((cur) => cur ?? `Your ${providerName(provider)} session has expired.`);
        setAuthProvider(provider as AuthProviderId);
      } else if (authProviderRef.current === provider) {
        // Recovered (reconnected, or the earlier failure was transient) — clear the cue.
        setAuthProblem(null);
        setAuthProvider(null);
      }
    } catch {
      // Probe unavailable — leave any existing cue as-is.
    }
  }, []);

  useEffect(() => {
    if (!models.length) return; // wait for models before the first probe
    void probeActiveAuth();
    const onFocus = () => void probeActiveAuth();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [models.length, probeActiveAuth]);

  const newConversation = useCallback(async (folderId: string | null = null) => {
    // Reset only the draft slice and switch to it — any chats running in the
    // background are left untouched and keep streaming. Bumping the draft seq
    // marks any in-flight draft turn as no-longer-current so it can't steal focus.
    draftSeqRef.current += 1;
    openGateRef.current.invalidate();
    pendingDraftFolderRef.current = folderId;
    setDraftFolderId(folderId);
    core.store.replace(DRAFT, EMPTY_STATE);
    setActiveThreadId(null);
    setFocusComposerSeq((n) => n + 1);
  }, [core]);

  // A brand-new chat is for typing into, so put the caret in the composer — from
  // ⌘N, the titlebar button, or the chat list. Deferred to an effect because
  // coming from an open thread remounts ChatView (it's keyed by thread), and the
  // handle only points at the new composer once that commit lands.
  useEffect(() => {
    if (focusComposerSeq === 0) return; // never on first mount
    chatViewRef.current?.focus();
  }, [focusComposerSeq]);

  // ⌘N / ⌘\ — mirror the titlebar buttons. (Composer shortcuts live in ChatView.)
  useShortcut('new-conversation', () => newConversation());
  useShortcut('toggle-inspector', () => setShowInspector((v) => !v));

  const openChat = useCallback(
    async (threadId: string) => {
      // Record navigation intent immediately, before the history IPC settles. A
      // pending first-turn response must not consider the old DRAFT still visible.
      draftSeqRef.current += 1;
      const request = openGateRef.current.begin();
      if (deletedThreadsRef.current.has(threadId)) return;
      // Opening is what marks a thread read — the persisted half of clearing the
      // unread dot below. Fire-and-forget: the row is already on screen and the
      // returned list only settles the bold/not-bold, never the navigation.
      void window.stem
        .setInboxRead([threadId], true)
        .then(setChatList)
        .catch(() => {});
      const existing = core.store.getThread(threadId);
      // A scheduled run streamed into this thread while it was never open → its slice
      // is partial. Reload from disk unless a turn is actively streaming (which we'd
      // clobber); clear the flag once consumed.
      const forceReload = forceReloadRef.current.has(threadId) && !existing?.running;
      // If we already hold a live or hydrated slice (e.g. a chat that ran in the
      // background), just switch to it — reloading from disk would clobber the
      // in-flight stream. Opening clears the unread (done) dot.
      if (!forceReload && existing && (existing.running || existing.messages.length > 0)) {
        if (!openGateRef.current.isCurrent(request)) return;
        setActiveThreadId(threadId);
        setThread(threadId, (s) => ({ status: s.status === 'done' ? 'idle' : s.status }));
        return;
      }
      const history = await window.stem.openChat(threadId);
      if (!openGateRef.current.isCurrent(request) || deletedThreadsRef.current.has(threadId)) return;
      core.store.update((prev) => ({
        ...prev,
        // An entire turn can start and settle while the disk read is pending, so
        // `running` alone cannot identify a raced live slice. Compare against the
        // state captured when the request began and merge any newer events.
        [history.threadId]: mergeHydratedThread(history.messages, prev[history.threadId], existing)
      }));
      if (forceReload) forceReloadRef.current.delete(threadId);
      setActiveThreadId(history.threadId);
    },
    [core, setThread]
  );

  // Reading is what marks a thread read, and "reading" means the thread is on
  // screen in a focused window — the same rule mail clients and Slack use.
  // `openChat` stamps the navigate-to-it order; this effect covers the other one:
  // unread lands in the thread you already have open (a reply from another
  // device, a scheduled run, a turn that settled while the window was blurred),
  // so re-check whenever the window gains focus or the list changes. A thread the
  // user explicitly marked unread stays that way — forcedUnread is a decision,
  // not something happening to be on screen may overrule. The (id, mtime) memo
  // keeps a stamp that didn't stick (offline, clock skew) from retrying forever.
  const readStampRef = useRef<{ id: string; updatedAt: number } | null>(null);
  useEffect(() => {
    const markVisibleRead = () => {
      const id = activeThreadIdRef.current;
      if (!id || !document.hasFocus()) return;
      if (displayList.inbox.entries[id]?.forcedUnread) return;
      const chat = displayList.chats.find((c) => c.threadId === id);
      if (!chat || !isUnread(chat, displayList.inbox)) return;
      const last = readStampRef.current;
      if (last && last.id === id && last.updatedAt === chat.updatedAt) return;
      readStampRef.current = { id, updatedAt: chat.updatedAt };
      void window.stem
        .setInboxRead([id], true)
        .then(setChatList)
        .catch(() => {});
    };
    markVisibleRead();
    window.addEventListener('focus', markVisibleRead);
    return () => window.removeEventListener('focus', markVisibleRead);
  }, [displayList, activeThreadId]);

  // ---- Coming back after the event stream was away ----
  //
  // Two pushes, in this order, and the order is what makes them work together.
  //
  // The live-turn snapshot lands first and settles what is and is not running.
  // Only then does the resync handler run, so `openChat` reads a `running` flag
  // that is already correct — and its own rule, never reload a thread from disk
  // while a turn is streaming into it, then does the right thing in both cases:
  // a settled thread is reread in full, and a live one is left to the stream
  // rather than clobbered by a file that does not have the answer in it yet.
  // Refetching first is the version of this that quietly drops the end of a
  // reply that is still being written.
  useEffect(() => window.stem?.onLiveTurns((turns) => applyLiveTurns(core, turns)), [core]);

  useEffect(
    () =>
      window.stem?.onResync(() => {
        // The gap was too old to replay, so nothing on screen can be assumed
        // current: the list may have gained threads, and the open one may have
        // gained a whole turn. Only the open thread is refetched — the rest are
        // read from disk when they are next opened anyway.
        void refreshChats();
        const open = activeThreadIdRef.current;
        if (!open) return;
        forceReloadRef.current.add(open);
        void openChat(open);
      }),
    [refreshChats, openChat]
  );

  // The same job, for coming back from being offline rather than from a gap in
  // the stream. Everything on screen while the server was unreachable came out
  // of this Mac's cache, and a cache is by definition behind — so the moment the
  // server answers again, ask it. Runs on the transition only (the ref), so a
  // window that was never offline never refetches for nothing.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (offline) {
      wasOffline.current = true;
      return;
    }
    if (!wasOffline.current) return;
    wasOffline.current = false;
    void refreshChats();
    const open = activeThreadIdRef.current;
    if (!open) return;
    forceReloadRef.current.add(open);
    void openChat(open);
  }, [offline, refreshChats, openChat]);

  // Folder mutations return the fresh list; apply it directly.
  const onCreateFolder = useCallback((name: string, parentId: string | null) => {
    window.stem.createFolder(name, parentId).then(setChatList);
  }, []);
  const onRenameFolder = useCallback((folderId: string, name: string) => {
    window.stem.renameFolder(folderId, name).then(setChatList);
  }, []);
  const onDeleteFolder = useCallback((folderId: string) => {
    window.stem.deleteFolder(folderId).then(setChatList);
  }, []);
  const onMoveFolder = useCallback((folderId: string, parentId: string | null) => {
    window.stem.moveFolder(folderId, parentId).then(setChatList);
  }, []);
  const onMoveChat = useCallback((threadId: string, folderId: string | null) => {
    window.stem.setChatFolder(threadId, folderId).then(setChatList);
  }, []);

  /**
   * Auto-advance: triaging the thread you are reading moves you on to the next
   * one waiting, so an Inbox can be emptied without a trip back to the list
   * between every row. When nothing is left to advance to, you get a new chat —
   * an empty Inbox should leave you ready to write, not staring at a thread you
   * have just dealt with.
   *
   * Only fires when the active thread is one of the ones being triaged: archiving
   * some other row is housekeeping, and must not yank you out of what you are
   * reading. Only leaving the Inbox counts — un-snoozing or restoring a thread is
   * how you go *to* it.
   *
   * Lives here rather than in the chat list because the triage shortcuts have to
   * work with the inspector hidden or parked on another tab, where the list is
   * unmounted; the list's buttons route through the same handlers.
   */
  const advanceAfter = useCallback(
    (threadIds: string[]) => {
      const active = activeThreadIdRef.current;
      if (!active || !threadIds.includes(active)) return;
      const going = new Set(threadIds);
      const now = Date.now();
      const order = displayList.chats
        .filter((c) => placement(c, displayList.inbox, now) === 'inbox')
        .map((c) => c.threadId);
      const from = order.indexOf(active);
      // The row below, as drawn — then the row above, so triaging the last thread
      // in the list doesn't fall straight through to a new chat.
      const next =
        order.slice(from + 1).find((id) => !going.has(id)) ??
        [...order.slice(0, Math.max(from, 0))].reverse().find((id) => !going.has(id));
      if (next) void openChat(next);
      else newConversation();
    },
    [displayList, openChat, newConversation]
  );

  // Inbox triage. Like the folder mutators, each returns the fresh list.
  const onArchive = useCallback(
    (threadIds: string[], archived: boolean) => {
      window.stem.setInboxArchived(threadIds, archived).then(setChatList);
      if (archived) advanceAfter(threadIds);
    },
    [advanceAfter]
  );
  const onSnooze = useCallback(
    (threadIds: string[], until: number | null) => {
      window.stem.snoozeChats(threadIds, until).then(setChatList);
      if (until !== null) advanceAfter(threadIds);
    },
    [advanceAfter]
  );
  const onSetRead = useCallback((threadIds: string[], read: boolean) => {
    window.stem.setInboxRead(threadIds, read).then(setChatList);
  }, []);
  const onMarkAllRead = useCallback(() => {
    window.stem.markInboxAllRead().then(setChatList);
  }, []);
  const onWriteSubject = useCallback((threadId: string) => {
    // Round-trips through a model, so this resolves in a second or two rather
    // than immediately; the row simply renames itself when it lands.
    window.stem.writeChatSubject(threadId).then(setChatList);
  }, []);
  const onRenameChat = useCallback(
    async (threadId: string, name: string) => {
      await window.stem.renameChat(threadId, name);
      refreshChats();
    },
    [refreshChats]
  );
  const onDeleteChat = useCallback((threadId: string) => {
    openGateRef.current.invalidate();
    // Guard against late events from this thread's in-flight turn resurrecting it.
    deletedThreadsRef.current.add(threadId);
    // Prune all UI state synchronously and optimistically — the backend delete is
    // gated behind any in-flight turn / background switch_session, so awaiting it
    // would leave the row on screen for seconds. The IPC never meaningfully
    // rejects (unlink/new_session/removeChat all swallow errors) and the ref above
    // guards against resurrection, so fire-and-forget is safe.
    core.store.remove(threadId);
    setPendingChats((prev) => {
      if (!prev[threadId]) return prev;
      const next = { ...prev };
      delete next[threadId];
      return next;
    });
    if (threadId === activeThreadIdRef.current) setActiveThreadId(null);
    // Prune the one row locally instead of re-scanning every session file on
    // disk (folders are untouched by a chat delete).
    setChatList((prev) => ({
      ...prev,
      chats: prev.chats.filter((c) => c.threadId !== threadId)
    }));
    window.stem.deleteChat(threadId).catch(() => {});
  }, [core]);

  // ⌃X — confirm-then-delete the active thread. Reuses onDeleteChat; reading
  // pendingDelete via the updater keeps the ⌃X-again confirm path free of stale
  // closures. Registered after onDeleteChat so the useCallback dep is initialized.
  const confirmDeleteThread = useCallback(() => {
    setPendingDelete((p) => {
      if (p) onDeleteChat(p.threadId);
      return null;
    });
  }, [onDeleteChat]);
  useShortcut('delete-thread', () => {
    if (pendingDelete) {
      // Popup already open — a second ⌃X confirms.
      confirmDeleteThread();
      return;
    }
    const id = activeThreadIdRef.current;
    if (!id) return; // Nothing open (draft/empty) — no-op.
    const title = displayList.chats.find((c) => c.threadId === id)?.title ?? '';
    setPendingDelete({ threadId: id, title });
  });

  // ---- inbox triage shortcuts ----
  // ⌘⇧A / ⌘⇧S / ⌘⇧U act on the multi-selection when the list is showing one, and
  // on the thread you are reading otherwise — the same two targets the row
  // buttons and the selection bar already act on. Registered here, not in the
  // list, so they survive a hidden inspector or a parked-on-Settings panel.
  const inboxSelection = useRef<InboxSelectionApi | null>(null);
  const onSelectionApi = useCallback((api: InboxSelectionApi | null) => {
    inboxSelection.current = api;
  }, []);

  const triageTargets = useCallback((): string[] => {
    const selected = inboxSelection.current?.ids ?? [];
    if (selected.length > 0) return selected;
    const id = activeThreadIdRef.current;
    return id ? [id] : [];
  }, []);

  /** Where the triaged threads sit right now — the direction each toggle reverses. */
  const triageWhere = useCallback(
    (threadIds: string[], want: 'inbox' | 'snoozed' | 'archived') => {
      const now = Date.now();
      return threadIds.every((id) => {
        const chat = displayList.chats.find((c) => c.threadId === id);
        return !!chat && placement(chat, displayList.inbox, now) === want;
      });
    },
    [displayList]
  );

  useShortcut('archive-thread', () => {
    const ids = triageTargets();
    if (ids.length === 0) return;
    // An all-archived target restores; anything else archives — the same rule the
    // selection bar uses, and the reversible direction when the target is mixed.
    onArchive(ids, !triageWhere(ids, 'archived'));
    inboxSelection.current?.clear();
  });

  useShortcut('snooze-thread', () => {
    const ids = triageTargets();
    if (ids.length === 0) return;
    if (triageWhere(ids, 'snoozed')) {
      onSnooze(ids, null); // Already snoozed → the shortcut wakes them.
      inboxSelection.current?.clear();
      return;
    }
    // Anchor the picker under the row it applies to when that row is on screen;
    // with the list hidden there is nothing to point at, so it opens up high and
    // centred rather than at a stale coordinate.
    const row = document.querySelector(`[data-thread-id="${CSS.escape(ids[0])}"]`);
    const rect = row?.getBoundingClientRect();
    setSnoozePicker({
      ids,
      x: rect ? rect.left + 24 : Math.round(window.innerWidth / 2) - 90,
      y: rect ? rect.bottom : Math.round(window.innerHeight / 4)
    });
  });

  useShortcut('toggle-read', () => {
    const ids = triageTargets();
    if (ids.length === 0) return;
    // Opening a thread marks it read, so on the thread you are reading this is
    // "mark unread and move on"; a selection with anything unread in it clears.
    const anyUnread = ids.some((id) => {
      const chat = displayList.chats.find((c) => c.threadId === id);
      return !!chat && isUnread(chat, displayList.inbox);
    });
    onSetRead(ids, anyUnread);
    inboxSelection.current?.clear();
  });

  // Roll back to (and including) a turn on the backend, drop that turn + everything
  // after it from the visible slice, then re-send `text` as a fresh turn. Shared by
  // retry (same text) and edit (new text). No-op while the thread is streaming.
  const rerunFromTurn = useCallback(
    async (turnId: string, text: string) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      await rerunFromTurnShared(core, { key: threadId, threadId, turnId, text, send: onSend });
    },
    [core, onSend]
  );

  const onRetry = useCallback(
    (turnId: string) => {
      const slice = core.store.getThread(activeThreadIdRef.current ?? '');
      const userMsg = slice?.messages.find((m) => m.turnId === turnId && m.role === 'user');
      if (userMsg) rerunFromTurn(turnId, userMsg.content);
    },
    [core, rerunFromTurn]
  );

  const onEditMessage = useCallback(
    (turnId: string, newText: string) => {
      if (newText.trim()) rerunFromTurn(turnId, newText.trim());
    },
    [rerunFromTurn]
  );

  // Branch the conversation into a new chat ending at `turnId`, inheriting the
  // source chat's folder, then open it. The original is left untouched.
  const onForkMessage = useCallback(
    async (turnId: string) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      try {
        const { threadId: newId } = await window.stem.forkThread(threadId, turnId);
        const sourceFolder = chatList.chats.find((c) => c.threadId === threadId)?.folderId ?? null;
        if (sourceFolder) await window.stem.setChatFolder(newId, sourceFolder);
        await refreshChats();
        await openChat(newId);
      } catch (e) {
        setThread(threadId, (s) => appendSystemMessage(s, e));
      }
    },
    [chatList, refreshChats, openChat, setThread]
  );

  // Delete this turn and everything after it. Reuses the rollbackToTurn truncation
  // (same JSONL trim as retry) but does NOT re-send. Deleting the first turn would
  // hit rollback's "no earlier history" guard, so that case removes the whole chat.
  const onDeleteFromTurn = useCallback(
    async (turnId: string) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      await deleteFromTurn(core, {
        key: threadId,
        threadId,
        turnId,
        onDeleteFirstTurn: () => onDeleteChat(threadId)
      });
    },
    [core, onDeleteChat]
  );

  // A send that startTurn rejected (e.g. "agent is already processing") never made
  // a turn — its bubble and error are local-only, so acting on them is a splice in
  // the visible slice plus (for retry/edit) a fresh send.
  const onRetryFailedSend = useCallback(
    (messageId: string) => {
      const restore = removeFailedSend(core, activeThreadIdRef.current ?? DRAFT, messageId);
      if (restore) void onSend(restore.text, restore.attachments);
    },
    [core, onSend]
  );
  const onEditFailedSend = useCallback(
    (messageId: string, newText: string) => {
      const restore = removeFailedSend(core, activeThreadIdRef.current ?? DRAFT, messageId);
      if (restore) void onSend(newText, restore.attachments);
    },
    [core, onSend]
  );
  const onDeleteFailedSend = useCallback(
    (messageId: string) => {
      removeFailedSend(core, activeThreadIdRef.current ?? DRAFT, messageId);
    },
    [core]
  );

  // Escape-to-retract: stop the running turn and pull the just-sent message back
  // into the composer, dropping it from the chat AND pi's session — as if it was
  // never sent. Captures the original text/attachments and hands them to ChatView
  // via `pendingRestore` (which survives the remount when a new chat is deleted).
  // The turn id may not be stamped yet if Escape lands right after Enter, so we
  // fall back to awaiting the in-flight send to learn it (and the real thread id).
  const onRetractActiveTurn = useCallback(async () => {
    const key = activeThreadIdRef.current ?? DRAFT;
    const pending = core.pendingSends.get(key);
    let turnId = core.store.getThread(key)?.activeTurnId ?? pending?.turnId ?? null;
    if (!turnId && pending) {
      // Escape beat startTurn's resolution — wait for it to learn the turn id.
      await pending.promise.catch(() => undefined);
      turnId = pending.turnId;
    }
    // Restore payload comes from the original send (lossless), falling back to the
    // last user bubble's text when there's no pending entry (attachments are lost).
    const restore = pending
      ? { text: pending.text, attachments: pending.attachments }
      : (() => {
          const slice = core.store.getThread(key);
          const last = slice ? [...slice.messages].reverse().find((m) => m.role === 'user') : undefined;
          return last ? { text: last.content, attachments: resendAttachments(last) } : null;
        })();
    const queueRestore = () => {
      if (restore) setPendingRestore({ ...restore, nonce: ++restoreNonceRef.current });
    };

    // Stop the turn (idempotent if a prior Escape already did in two-stage mode).
    if (turnId) await window.stem.interruptTurn(turnId);

    // A new chat's only turn has no earlier history to roll back to — delete the
    // whole chat (which also aborts it backend-side) and return to a fresh draft.
    if (pending?.isNewChat) {
      const realId = pending.threadId ?? activeThreadIdRef.current;
      core.pendingSends.delete(key);
      if (realId) {
        core.pendingSends.delete(realId);
        onDeleteChat(realId);
      } else {
        core.store.replace(DRAFT, EMPTY_STATE);
      }
      queueRestore();
      return;
    }

    const threadId = pending?.threadId ?? activeThreadIdRef.current;
    if (!threadId || !turnId) {
      // No backend turn to roll back; just stop locally and restore the text.
      setThread(key, () => ({ running: false, streamingId: null, activity: null, activeTurnId: null, status: 'idle' }));
      core.pendingSends.delete(key);
      queueRestore();
      return;
    }
    try {
      await window.stem.rollbackToTurn(threadId, turnId);
    } catch (e) {
      // Surface the failure rather than silently dropping the message.
      setThread(threadId, (s) => appendSystemMessage(s, e));
      return;
    }
    // Drop the user message + its partial reply from the visible slice.
    core.store.update((prev) => {
      const slice = prev[threadId];
      if (!slice) return prev;
      const idx = slice.messages.findIndex((m) => m.turnId === turnId && m.role === 'user');
      if (idx === -1) {
        return { ...prev, [threadId]: { ...slice, running: false, streamingId: null, activity: null, activeTurnId: null, status: 'idle' } };
      }
      return {
        ...prev,
        [threadId]: { ...slice, messages: slice.messages.slice(0, idx), running: false, streamingId: null, activity: null, activeTurnId: null, status: 'idle' }
      };
    });
    core.pendingSends.delete(threadId);
    queueRestore();
  }, [core, onDeleteChat, setThread]);

  // Stable callbacks for ManagePanel — inline closures here would defeat its memo.
  const onTogglePreview = useCallback(() => setPreviewActive((v) => !v), []);

  // Unified draggable toolbar wraps every view (window has no native title bar).
  // `toolbar` lets each view supply its own controls; gate/loading show just the title.
  const titleOnly = (
    <div className="toolbar-title">
      <strong>Stem</strong>
    </div>
  );
  const shell = (inner: ReactNode, toolbar: ReactNode = titleOnly) => (
    <div className="root-shell">
      <div className="toolbar">{toolbar}</div>
      {inner}
    </div>
  );

  if (bridgeError) {
    return shell(
      <div className="app gate">
        <div className="gate-card">
          <h1>Stem</h1>
          <p className="error">{bridgeError}</p>
        </div>
      </div>
    );
  }

  if (!status) {
    return shell(<div className="app loading">Starting Stem…</div>);
  }

  if (!status.ok) {
    if (status.authenticated === false) {
      // Wait for settings before picking the wizard variant — the gate mounts its
      // reducer once, so flipping variant after the fact wouldn't re-init it.
      if (onboardingCompleted === null) {
        return shell(<div className="app loading">Starting Stem…</div>);
      }
      // Not signed in: first-run welcome wizard, or the compact re-sign-in
      // variant when onboarding already happened (e.g. auth.json was deleted).
      return shell(
        <OnboardingGate
          variant={onboardingCompleted ? 'reauth' : 'firstRun'}
          onAuthenticated={onAuthenticated}
        />
      );
    }
    return shell(
      <div className="app gate">
        <div className="gate-card">
          <h1>Stem</h1>
          <p className="error">{status.error}</p>
          <button className="push" onClick={refreshStatus}>Retry</button>
        </div>
      </div>
    );
  }

  if (reauthOpen) {
    // The user clicked Reconnect (banner or Settings). Signed-in status but the
    // token is dead; deep-link the gate to that provider, with a way back.
    return shell(
      <OnboardingGate
        variant="reauth"
        reauthMessage={authProblem}
        initialProvider={authProvider ?? undefined}
        onAuthenticated={onAuthenticated}
        onDismissReauth={() => setReauthOpen(false)}
      />
    );
  }

  return shell(
    <>
      {offline && (
        // Said plainly, and said before anything else: what you are looking at
        // is this Mac's copy, and it is not going to change until Stem can reach
        // its server again. No Retry button — the client is already reconnecting
        // on its own, and a button that only restarts a loop that is running is
        // a button that teaches people to press it twice.
        <div className="offline-banner" role="status">
          <span className="offline-banner-msg">
            Stem can’t reach its server — you can read what’s already here, but not send. Memory, skills and
            search are unavailable until it’s back.
          </span>
        </div>
      )}
      {authProblem && (
        <div className="auth-banner" role="alert">
          <span className="auth-banner-msg">
            {authProvider ? `Your ${providerName(authProvider)} session has expired.` : authProblem} Reconnect to
            keep chatting.
          </span>
          <button className="auth-banner-btn" onClick={() => setReauthOpen(true)}>
            Reconnect
          </button>
        </div>
      )}
      {update &&
        !updateDismissed &&
        (update.state === 'ready' || (update.mode === 'manual' && !!update.available)) && (
          // Good news, said once: the update is either sitting downloaded (the
          // AppImage) or sitting on a web page (everywhere else). "Later" is a
          // real answer — a ready build installs itself on the next quit anyway,
          // and the row in Settings → App keeps the offer open.
          <div className="update-banner" role="status">
            <span className="update-banner-msg">
              {update.state === 'ready'
                ? `Stem ${update.available} is ready — it installs when you restart.`
                : `Stem ${update.available} is out. Yours keeps working; update when it suits you.`}
            </span>
            <button className="update-banner-btn" onClick={() => void window.stem.installUpdate()}>
              {update.state === 'ready' ? 'Restart now' : 'Get the update'}
            </button>
            <button className="update-banner-later" onClick={() => setUpdateDismissed(true)}>
              Later
            </button>
          </div>
        )}
      <div className={`app${showInspector ? '' : ' no-inspector'}`}>
        <main className="conversation">
          <ChatView
            key={activeKey}
          ref={chatViewRef}
          messages={cur.messages}
          running={cur.running}
          streamingId={cur.streamingId}
          activity={cur.activity}
          activities={cur.activities}
          onSend={onSend}
          onInterrupt={onInterrupt}
          escapeAction={escapeAction}
          onRetractActiveTurn={onRetractActiveTurn}
          pendingRestore={pendingRestore}
          onRestoreConsumed={() => setPendingRestore(null)}
          onRetry={onRetry}
          onEdit={onEditMessage}
          onFork={onForkMessage}
          onDelete={onDeleteFromTurn}
          onRetryFailedSend={onRetryFailedSend}
          onEditFailedSend={onEditFailedSend}
          onDeleteFailedSend={onDeleteFailedSend}
          models={models}
          model={selectedModel}
          effort={effort}
          serviceTier={serviceTier}
          format={format}
          draftFolderName={draftFolderName}
          threadId={activeThreadId}
          onChangeEffort={setEffort}
          onChangeSpeed={setServiceTier}
          onChangeFormat={setFormat}
          webSearch={webSearch}
          onToggleWebSearch={toggleWebSearch}
          reportDraft={previewActive}
          onDraftChange={setPreviewDraft}
        />
      </main>
      {showInspector && (
        <aside className="inspector" ref={inspectorRef}>
          <ManagePanel
            data={displayList}
            activeThreadId={activeThreadId}
            statuses={threadStatuses}
            scheduledThreadIds={scheduledThreadIds}
            models={models}
            modelId={modelId}
            onSelectModel={onSelectModel}
            onOpen={openChat}
            onNewChat={newConversation}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            onMoveFolder={onMoveFolder}
            onRenameChat={onRenameChat}
            onDeleteChat={onDeleteChat}
            onMoveChat={onMoveChat}
            onArchive={onArchive}
            onSnooze={onSnooze}
            onSetRead={onSetRead}
            onMarkAllRead={onMarkAllRead}
            onSelectionApi={onSelectionApi}
            onWriteSubject={onWriteSubject}
            inboxUnreadCount={inboxUnreadCount}
            activeRunning={cur.running}
            previewActive={previewActive}
            previewDraft={previewDraft}
            onTogglePreview={onTogglePreview}
            authDeadProvider={authProvider}
          />
        </aside>
      )}
      <DropOverlay onDropToChat={onDropToChat} />
      <McpApprovalCard />
      <InstructionsApprovalCard />
      <SkillApprovalCard />
      {/* Main window only. The skills migration asks the user to choose a standing
          setting and to accept a deletion — a settings-shaped decision, which the
          Quick Chat overlay is the wrong place for: it is opened for one question
          and dismissed. It waits here until the main window is opened. */}
      <SkillsResetDialog />
      <ExecApprovalCard />
      {pendingDelete && (
        <DeleteThreadDialog
          title={pendingDelete.title}
          onConfirm={confirmDeleteThread}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {snoozePicker && (
        <SnoozeMenu
          x={snoozePicker.x}
          y={snoozePicker.y}
          count={snoozePicker.ids.length}
          autoFocus
          onPick={(until) => {
            onSnooze(snoozePicker.ids, until);
            setSnoozePicker(null);
            inboxSelection.current?.clear();
          }}
          onClose={() => setSnoozePicker(null)}
        />
      )}
      {taskAlert && (
        <TaskAlertModal
          payload={taskAlert}
          onOpenChat={(threadId) => {
            setTaskAlerts((queue) => dismissTaskAlert(queue));
            void openChat(threadId);
          }}
          onDismiss={() => setTaskAlerts((queue) => dismissTaskAlert(queue))}
        />
      )}
      {releaseNotes && (
        <ReleaseNotesModal
          title={
            releaseNotesShowAll ? 'Release notes' : `What's new in Stem ${releaseNotes.appVersion}`
          }
          entries={
            releaseNotesShowAll
              ? releaseNotes.entries
              : releaseNotes.entries.filter((e) => releaseNotes.unseen.includes(e.version))
          }
          showOnUpdate={releaseNotesShowOnUpdate}
          onToggleShowOnUpdate={(value) => {
            setReleaseNotesShowOnUpdate(value);
            void window.stem.updateReleaseNotesSettings({ showOnUpdate: value });
          }}
          onShowAll={releaseNotesShowAll ? undefined : () => setReleaseNotesShowAll(true)}
          onClose={() => {
            setReleaseNotes(null);
            setReleaseNotesShowAll(false);
            // Mark read on dismissal, not on display: a popup the user never got
            // to (a crash mid-launch) should still be waiting next time.
            void window.stem.markReleaseNotesSeen();
          }}
        />
      )}
      </div>
    </>,
    <>
      <button
        className="tbtn"
        title={`New conversation (${glyphsFor('new-conversation')})`}
        onClick={() => newConversation()}
        // Allow a new chat even while another runs in the background. Only block
        // when the visible chat is empty, or its first turn hasn't yet produced a
        // thread id (DRAFT still running) — switching away would orphan it.
        disabled={cur.messages.length === 0 || (activeThreadId === null && cur.running)}
      >
        <SquarePen size={17} />
        <ShortcutHint id="new-conversation" />
      </button>
      <div className="toolbar-title">
        <strong>Stem</strong>
        {selectedModel && (
          <span>
            {selectedModel.displayName} · {selectedModel.providerName}
          </span>
        )}
      </div>
      <div className="toolbar-spacer" />
      <ActivityIndicator />
      <button
        className={`tbtn${showInspector ? ' active' : ''}`}
        title={`Toggle inspector (${glyphsFor('toggle-inspector')})`}
        onClick={() => setShowInspector((v) => !v)}
      >
        <PanelRight size={17} />
        <ShortcutHint id="toggle-inspector" placement="br" />
      </button>
    </>
  );
}
