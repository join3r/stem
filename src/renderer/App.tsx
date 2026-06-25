import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SquarePen, PanelRight } from 'lucide-react';
import type {
  ChatListResult,
  ChatSummary,
  BackendEventEnvelope,
  MessageMeta,
  ModelSummary,
  RuntimeStatus,
  TurnAttachment,
  ThreadStatus
} from '../shared/types';
import { toMessageAttachments } from './attachments';
import { ChatView, type ChatViewHandle } from './chat/ChatView';
import { ShortcutHint, useShortcut } from './shortcuts';
import { ManagePanel } from './manage/ManagePanel';
import { McpApprovalCard } from './manage/McpApprovalCard';
import { DeleteThreadDialog } from './DeleteThreadDialog';
import { DropOverlay } from './files/DropOverlay';
import { useAutoHideScroll } from './hooks/useAutoHideScroll';
import {
  EMPTY_STATE,
  appendSystemMessage,
  applyBackendEventToThread,
  applyProcessExitToThread,
  backendEventThreadId,
  type ThreadState
} from './chatState';

// Sentinel key for a brand-new chat that has no backend thread id yet. Its slice is
// migrated to the real thread id once the first turn returns one.
const DRAFT = '__draft__';

// Merge a DRAFT slice into the (possibly already-created) real-thread slice when a
// new chat's first turn returns its id. The draft holds the user bubble; the live
// slice may already hold assistant deltas that arrived before startTurn resolved.
// Keep the user bubble first, then any assistant messages not already present.
function mergeDraftIntoReal(draft: ThreadState, live: ThreadState | undefined): ThreadState {
  if (!live) return draft;
  const ids = new Set(draft.messages.map((m) => m.id));
  const extra = live.messages.filter((m) => !ids.has(m.id));
  return { ...live, messages: [...draft.messages, ...extra] };
}

export default function App() {
  const [status, setStatus] = useState<RuntimeStatus | null>(null);
  // Per-thread run/conversation state, keyed by thread id (or DRAFT for a new,
  // uncreated chat). This is what lets several chats run concurrently — each has
  // its own messages/running/streaming slice that events route into by threadId.
  const [threadStates, setThreadStates] = useState<Record<string, ThreadState>>({});
  const [signingIn, setSigningIn] = useState(false);
  const [showInspector, setShowInspector] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  // The active thread queued for deletion behind the ⌃X confirm popup (null = closed).
  const [pendingDelete, setPendingDelete] = useState<{ threadId: string; title: string } | null>(null);
  // Display-only mirror of pendingDraftFolderRef so the empty-state welcome can
  // tell the user which folder a new draft will be saved in (the ref itself is
  // non-reactive, used only on the send path).
  const [draftFolderId, setDraftFolderId] = useState<string | null>(null);
  const [chatList, setChatList] = useState<ChatListResult>({ chats: [], folders: [] });
  // Optimistic rows for chats created this session that the backend's thread/list hasn't
  // returned yet (a brand-new thread isn't listed until its first turn persists).
  // Keyed by threadId; dropped once the real list includes them.
  const [pendingChats, setPendingChats] = useState<Record<string, ChatSummary>>({});
  const inspectorRef = useAutoHideScroll<HTMLElement>();
  // Imperative handle to the active ChatView so the drop overlay can push files
  // ("Add to this conversation") into its composer.
  const chatViewRef = useRef<ChatViewHandle>(null);
  const onDropToChat = useCallback((files: File[]) => chatViewRef.current?.addAttachments(files), []);
  // turnId -> which model/effort/speed produced that turn's reply (for the
  // avatar tooltip). Populated at send time; read when the message is built.
  // Global on purpose: turn ids are unique across threads.
  const turnMetaRef = useRef(new Map<string, MessageMeta>());

  // Ref mirrors so async callbacks (startTurn resolution, openChat, events) read
  // the latest values without being re-created on every state change.
  const threadStatesRef = useRef(threadStates);
  threadStatesRef.current = threadStates;
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  // Bumped every time the DRAFT slice is reset (New chat / Quick Chat). Captured
  // at send time so a turn that resolves late only adopts its real thread id when
  // the draft it was sent for is still the current one — otherwise the user has
  // moved on to a fresh draft and we must not steal focus into the old thread.
  const draftSeqRef = useRef(0);
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
    (key: string, patch: (s: ThreadState) => Partial<ThreadState>) => {
      setThreadStates((prev) => {
        const base = prev[key] ?? EMPTY_STATE;
        return { ...prev, [key]: { ...base, ...patch(base) } };
      });
    },
    []
  );

  // Status-dot map for the chat rows, derived from the per-thread slices.
  const threadStatuses = useMemo(() => {
    const out: Record<string, ThreadStatus> = {};
    for (const [tid, s] of Object.entries(threadStates)) {
      if (tid === DRAFT) continue;
      out[tid] = s.status;
    }
    return out;
  }, [threadStates]);

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
    return extras.length ? { chats: [...extras, ...chatList.chats], folders: chatList.folders } : chatList;
  }, [chatList, pendingChats]);

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
  const selectedModel = models.find((m) => m.id === modelId) ?? null;

  const [bridgeError, setBridgeError] = useState<string | null>(null);

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

  // Fetch the model catalog once the runtime is ready; seed defaults from the backend
  // (the `isDefault` model + its default effort) when nothing is remembered yet.
  useEffect(() => {
    if (!status?.ok) return;
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
  }, [status?.ok]);

  // Persist the remembered selections.
  useEffect(() => {
    if (modelId) localStorage.setItem('stem.modelId', modelId);
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

  useEffect(() => {
    return window.stem.onBackendEvent((event: BackendEventEnvelope) => {
      if (event.method === 'process/exit') {
        // No threadId — the server died, so clear every thread's run state.
        setThreadStates((prev) => {
          const next: Record<string, ThreadState> = {};
          for (const [tid, s] of Object.entries(prev)) next[tid] = applyProcessExitToThread(s);
          return next;
        });
        return;
      }

      const threadId = backendEventThreadId(event);
      if (!threadId || deletedThreadsRef.current.has(threadId)) return;
      setThreadStates((prev) => {
        const nextState = applyBackendEventToThread(prev[threadId] ?? EMPTY_STATE, event, {
          turnMeta: turnMetaRef.current,
          settledStatus: (method, id) => {
            if (method === 'turn/failed') return 'error';
            if (method === 'turn/completed') {
              // Mark unread (a solid dot) if it finished while another chat was open.
              return id === activeThreadIdRef.current ? 'idle' : 'done';
            }
            return 'idle';
          }
        });
        return nextState ? { ...prev, [threadId]: nextState } : prev;
      });
    });
  }, []);

  const onSend = useCallback(
    async (text: string, attachments: TurnAttachment[] = []) => {
      const msgAttachments = attachments.length ? await toMessageAttachments(attachments) : undefined;
      // Where this turn's state lives: the open thread, or DRAFT for a new chat.
      const sendKey = activeThreadId ?? DRAFT;
      // Snapshot the draft identity + folder target so a late resolution can tell
      // whether this draft is still the one the user is looking at.
      const sendSeq = draftSeqRef.current;
      const sendFolder = pendingDraftFolderRef.current;
      // Capture the bubble id so we can stamp its backend turn id once startTurn
      // resolves — that's what makes Edit/Fork work on a just-sent user message.
      const userMsgId = `user-${Date.now()}`;
      setThread(sendKey, (s) => ({
        messages: [...s.messages, { id: userMsgId, role: 'user', content: text, attachments: msgAttachments }],
        running: true,
        activity: null,
        status: 'running'
      }));
      try {
        const result = await window.stem.startTurn({
          input: text,
          threadId: activeThreadId ?? undefined,
          model: modelId ?? undefined,
          effort: effort ?? undefined,
          serviceTier,
          format,
          attachments: attachments.length ? attachments : undefined
        });
        if (result.handled) {
          setThread(sendKey, (s) => ({
            messages: result.assistantMessage
              ? [...s.messages, { id: `assistant-${Date.now()}`, role: 'assistant', content: result.assistantMessage as string }]
              : s.messages,
            running: false,
            activeTurnId: null,
            status: 'idle'
          }));
          return;
        }
        if (result.turnId) {
          turnMetaRef.current.set(result.turnId, { model: modelId ?? undefined, effort: effort ?? undefined, serviceTier });
        }
        if (sendKey === DRAFT && result.threadId) {
          // First turn of a new chat. Adopt the real id only if this draft is
          // still the current one — i.e. the user hasn't opened another chat and
          // hasn't pressed New chat again since we sent.
          const realId = result.threadId;
          const stillMine = draftSeqRef.current === sendSeq && activeThreadIdRef.current === null;
          setThreadStates((prev) => {
            const next = { ...prev };
            if (stillMine) {
              // Migrate the DRAFT slice onto the real id, merging any deltas that
              // already arrived under it, then adopt the id below.
              const merged = mergeDraftIntoReal(prev[DRAFT] ?? EMPTY_STATE, prev[realId]);
              delete next[DRAFT];
              const messages = merged.messages.map((m) =>
                m.id === userMsgId ? { ...m, turnId: result.turnId ?? undefined } : m
              );
              next[realId] = { ...merged, messages, running: true, activeTurnId: result.turnId ?? null, status: 'running' };
            } else {
              // The draft was replaced; keep this turn streaming under its real id
              // in the background without disturbing the user's current draft.
              next[realId] = {
                ...(prev[realId] ?? EMPTY_STATE),
                running: true,
                activeTurnId: result.turnId ?? null,
                status: 'running'
              };
            }
            return next;
          });
          if (stillMine) {
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
          setThread(sendKey, (s) => ({
            activeTurnId: result.turnId ?? null,
            messages: s.messages.map((m) =>
              m.id === userMsgId ? { ...m, turnId: result.turnId ?? undefined } : m
            )
          }));
        }
      } catch (e) {
        setThread(sendKey, (s) => appendSystemMessage(s, e));
      }
    },
    [activeThreadId, refreshChats, modelId, effort, serviceTier, format, setThread]
  );

  // Quick Chat hand-off → main window: adopt the overlay's conversation as the
  // active chat, seeding its slice from the overlay's in-memory messages (so it's
  // complete with user bubbles even mid-stream). Any still-in-flight turn now
  // streams here, since the main process re-routes the thread's events to us.
  useEffect(() => {
    return window.stem.onQuickChatAdopt(({ threadId, messages: adopted, model, effort: aEffort, serviceTier: aTier }) => {
      deletedThreadsRef.current.delete(threadId);
      const activeId = adopted.find((m) => m.turnId)?.turnId ?? null;
      if (activeId) turnMetaRef.current.set(activeId, { model: model ?? undefined, effort: aEffort ?? undefined, serviceTier: aTier });
      setThreadStates((prev) => {
        const existing = prev[threadId];
        // Merge: prefer the overlay's messages (they include user bubbles), but
        // keep any later slice already present. Running state is left as-is; the
        // turn's own events will settle it.
        const base = existing ?? EMPTY_STATE;
        return { ...prev, [threadId]: { ...base, messages: adopted } };
      });
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
  }, [refreshChats]);

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

  const onInterrupt = useCallback(async () => {
    // Stops only the chat you're viewing; background chats keep running.
    const key = activeThreadIdRef.current ?? DRAFT;
    const turnId = threadStatesRef.current[key]?.activeTurnId;
    if (turnId) await window.stem.interruptTurn(turnId);
    setThread(key, () => ({ running: false, streamingId: null, activity: null, activeTurnId: null, status: 'idle' }));
  }, [setThread]);

  async function signIn() {
    setSigningIn(true);
    try {
      setStatus(await window.stem.login());
    } finally {
      setSigningIn(false);
    }
  }

  const newConversation = useCallback(async (folderId: string | null = null) => {
    // Reset only the draft slice and switch to it — any chats running in the
    // background are left untouched and keep streaming. Bumping the draft seq
    // marks any in-flight draft turn as no-longer-current so it can't steal focus.
    draftSeqRef.current += 1;
    pendingDraftFolderRef.current = folderId;
    setDraftFolderId(folderId);
    setThreadStates((prev) => ({ ...prev, [DRAFT]: EMPTY_STATE }));
    setActiveThreadId(null);
  }, []);

  // ⌘N / ⌘\ — mirror the titlebar buttons. (Composer shortcuts live in ChatView.)
  useShortcut('new-conversation', () => newConversation());
  useShortcut('toggle-inspector', () => setShowInspector((v) => !v));

  const openChat = useCallback(
    async (threadId: string) => {
      const existing = threadStatesRef.current[threadId];
      // If we already hold a live or hydrated slice (e.g. a chat that ran in the
      // background), just switch to it — reloading from disk would clobber the
      // in-flight stream. Opening clears the unread (done) dot.
      if (existing && (existing.running || existing.messages.length > 0)) {
        setActiveThreadId(threadId);
        setThread(threadId, (s) => ({ status: s.status === 'done' ? 'idle' : s.status }));
        return;
      }
      const history = await window.stem.openChat(threadId);
      setThreadStates((prev) => ({
        ...prev,
        [history.threadId]: { ...EMPTY_STATE, messages: history.messages }
      }));
      setActiveThreadId(history.threadId);
    },
    [setThread]
  );

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
  const onRenameChat = useCallback(
    async (threadId: string, name: string) => {
      await window.stem.renameChat(threadId, name);
      refreshChats();
    },
    [refreshChats]
  );
  const onDeleteChat = useCallback(
    async (threadId: string) => {
      // Guard against late events from this thread's in-flight turn resurrecting it.
      deletedThreadsRef.current.add(threadId);
      await window.stem.deleteChat(threadId);
      setThreadStates((prev) => {
        const next = { ...prev };
        delete next[threadId];
        return next;
      });
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
    },
    []
  );

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

  // Roll back to (and including) a turn on the backend, drop that turn + everything
  // after it from the visible slice, then re-send `text` as a fresh turn. Shared by
  // retry (same text) and edit (new text). No-op while the thread is streaming.
  const rerunFromTurn = useCallback(
    async (turnId: string, text: string) => {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      const slice = threadStatesRef.current[threadId];
      if (!slice || slice.running) return;
      const userIdx = slice.messages.findIndex((m) => m.turnId === turnId && m.role === 'user');
      if (userIdx === -1) return;
      try {
        await window.stem.rollbackToTurn(threadId, turnId);
      } catch (e) {
        setThread(threadId, (s) => appendSystemMessage(s, e));
        return;
      }
      // Truncate to before this turn's user message; onSend re-appends + streams.
      // Both functional updates compose, so the bubble lands after the slice.
      setThread(threadId, (s) => ({ messages: s.messages.slice(0, userIdx) }));
      onSend(text, []);
    },
    [onSend, setThread]
  );

  const onRetry = useCallback(
    (turnId: string) => {
      const slice = threadStatesRef.current[activeThreadIdRef.current ?? ''];
      const userMsg = slice?.messages.find((m) => m.turnId === turnId && m.role === 'user');
      if (userMsg) rerunFromTurn(turnId, userMsg.content);
    },
    [rerunFromTurn]
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
    return shell(
      <div className="app gate">
        <div className="gate-card">
          <h1>Stem</h1>
          {status.authenticated === false ? (
            <>
              <p>Sign in with your Claude subscription to continue.</p>
              <button className="primary" onClick={signIn} disabled={signingIn}>
                {signingIn ? 'Waiting for browser…' : 'Sign in with Claude'}
              </button>
              {status.loginCommand && <code className="login-cmd">{status.loginCommand}</code>}
            </>
          ) : (
            <>
              <p className="error">{status.error}</p>
              <button className="push" onClick={refreshStatus}>Retry</button>
            </>
          )}
        </div>
      </div>
    );
  }

  return shell(
    <div className={`app${showInspector ? '' : ' no-inspector'}`}>
      <main className="conversation">
        <ChatView
          key={activeKey}
          ref={chatViewRef}
          messages={cur.messages}
          running={cur.running}
          streamingId={cur.streamingId}
          activity={cur.activity}
          onSend={onSend}
          onInterrupt={onInterrupt}
          onRetry={onRetry}
          onEdit={onEditMessage}
          onFork={onForkMessage}
          models={models}
          model={selectedModel}
          effort={effort}
          serviceTier={serviceTier}
          format={format}
          draftFolderName={draftFolderName}
          onChangeEffort={setEffort}
          onChangeSpeed={setServiceTier}
          onChangeFormat={setFormat}
        />
      </main>
      {showInspector && (
        <aside className="inspector" ref={inspectorRef}>
          <ManagePanel
            data={displayList}
            activeThreadId={activeThreadId}
            statuses={threadStatuses}
            models={models}
            modelId={modelId}
            onSelectModel={onSelectModel}
            onOpen={openChat}
            onNewChat={(folderId) => newConversation(folderId)}
            onCreateFolder={onCreateFolder}
            onRenameFolder={onRenameFolder}
            onDeleteFolder={onDeleteFolder}
            onMoveFolder={onMoveFolder}
            onRenameChat={onRenameChat}
            onDeleteChat={onDeleteChat}
            onMoveChat={onMoveChat}
          />
        </aside>
      )}
      <DropOverlay onDropToChat={onDropToChat} />
      <McpApprovalCard />
      {pendingDelete && (
        <DeleteThreadDialog
          title={pendingDelete.title}
          onConfirm={confirmDeleteThread}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>,
    <>
      <button
        className="tbtn"
        title="New conversation"
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
        <span>{selectedModel ? selectedModel.displayName : 'Claude'}</span>
      </div>
      <div className="toolbar-spacer" />
      <button
        className={`tbtn${showInspector ? ' active' : ''}`}
        title="Toggle inspector"
        onClick={() => setShowInspector((v) => !v)}
      >
        <PanelRight size={17} />
        <ShortcutHint id="toggle-inspector" placement="br" />
      </button>
    </>
  );
}
