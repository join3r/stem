import { memo, useState } from 'react';
import { Brain, Plug, FolderTree, CalendarClock, Settings, MessageSquare, Users } from 'lucide-react';
import { ChatList, type ChatListProps } from '../chats/ChatList';
import { MemoryTab } from './tabs/MemoryTab';
import { McpSkillsTab } from './tabs/McpTab';
import { SourcesTab } from './tabs/FoldersTab';
import { PersonasTab } from './tabs/PersonasTab';
import { PeopleTab } from './tabs/PeopleTab';
import { useRememberedTab } from '../hooks/useRememberedTab';
import { TasksTab } from './tabs/TasksTab';
import { SettingsTab } from './tabs/settings/SettingsTab';
import { useRetrievalHealth } from '../hooks/useRetrievalHealth';
import type { ModelTabProps, ActiveFactsViewProps } from './tabs/shared';
import type { ManageTabId, ModelSummary } from '../../shared/types';

type Tab = ManageTabId;

// Naming notes: "Tools", not "MCP" — the tab holds skills as well as MCP servers.
// "Sources", not "Folders" — the Chats tab already organizes threads into folders,
// so a second tab called Folders (connected filesystem dirs) collided with it.
// Sources covers both places the assistant reads from: the Files drop-place and
// connected folders, as sub-tabs.
const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'mcp', label: 'Tools — MCP & skills', icon: Plug },
  { id: 'personas', label: 'Personas & people', icon: Users },
  { id: 'folders', label: 'Sources — files & connected folders', icon: FolderTree },
  { id: 'tasks', label: 'Scheduled tasks', icon: CalendarClock },
  { id: 'settings', label: 'Settings', icon: Settings }
];

export const MANAGE_TAB_IDS = TABS.map((t) => t.id);
/** Where the open tab is remembered across launches. */
export const MANAGE_TAB_KEY = 'stem.manage.tab';

export type ManagePanelProps = ChatListProps &
  ModelTabProps &
  ActiveFactsViewProps & {
    /** A signed-in provider whose credential is dead — flags Settings with a red dot. */
    authDeadProvider?: string | null;
    /**
     * Unread threads waiting in the Inbox → a count badge on the Chats tab. This is
     * the only signal a snoozed thread gives when it wakes: it returns to the Inbox
     * quietly rather than raising a window, so the rail has to say so.
     */
    inboxUnreadCount?: number;
    /** The open tab — owned by App so the View menu can switch it. */
    tab: ManageTabId;
    onTabChange: (tab: ManageTabId) => void;
  };

function ManagePanelImpl({
  models,
  modelId,
  onSelectModel,
  activeThreadId,
  activeRunning,
  previewActive,
  previewDraft,
  onTogglePreview,
  authDeadProvider,
  inboxUnreadCount = 0,
  tab,
  onTabChange: setTab,
  ...chatProps
}: ManagePanelProps) {
  const activeFacts: ActiveFactsViewProps = {
    activeThreadId,
    activeRunning,
    previewActive,
    previewDraft,
    onTogglePreview
  };
  // Bumped when the Memory tab asks for its recall models, which live under
  // Settings → Models: a counter, so asking twice still re-opens the group.
  const [recallFocus, setRecallFocus] = useState(0);
  // A down retrieval model degrades recall silently (selection falls back to
  // lexical/recency), so it gets the same red dot a dead provider does.
  const retrievalBroken = useRetrievalHealth().broken;
  // Personas working on mail in the background: surfaced only in the hover tip.
  // The toolbar's pulsing Activity icon already says "something is happening" —
  // a second blinking dot here was noise, not signal (removed by request).
  const mailWorking = chatProps.mail.conversations.some((c) => c.status === 'working');
  return (
    <div className="manage">
      <div className="insp-tabs">
        <div className="insp-seg">
          {TABS.map(({ id, label, icon: Icon }) => {
            const unread = id === 'chats' && inboxUnreadCount > 0 ? inboxUnreadCount : 0;
            const tip =
              id === 'settings' && authDeadProvider
                ? `${label} — a provider needs reconnecting`
                : id === 'memory' && retrievalBroken
                  ? `${label} — a retrieval model failed`
                  : unread
                    ? `${label} — ${unread} unread`
                    : id === 'chats' && mailWorking
                      ? `${label} — a persona is working on your mail`
                      : label;
            return (
              <button
                key={id}
                className={tab === id ? 'active' : ''}
                aria-label={unread ? `${label}, ${unread} unread` : label}
                onClick={() => setTab(id)}
              >
                <Icon size={16} />
                {/* Styled hover/focus tooltip replaces the native title (which is
                    slow to appear and can't be styled). aria-hidden: the button's
                    aria-label already carries the name. */}
                <span className="insp-tab-tip" aria-hidden="true">
                  {tip}
                </span>
                {id === 'settings' && authDeadProvider && <span className="tab-alert-dot" />}
                {id === 'memory' && retrievalBroken && <span className="tab-alert-dot" />}
                {/* Capped at 99+ so a long-ignored Inbox can't widen the rail. */}
                {unread > 0 && (
                  <span className="tab-count-badge" aria-hidden="true">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      <div className={`manage-body${tab === 'chats' ? ' chats' : ''}`}>
        {tab === 'chats' && <ChatList {...chatProps} activeThreadId={activeThreadId} />}
        {tab === 'memory' && (
          <MemoryTab
            activeFacts={activeFacts}
            onOpenMail={(id) => {
              setTab('chats');
              chatProps.onChatsTabChange('inbox');
              chatProps.onOpenMail(id);
            }}
            onReviewRecall={() => {
              setRecallFocus((n) => n + 1);
              setTab('settings');
            }}
          />
        )}
        {tab === 'mcp' && <McpSkillsTab models={models} />}
        {tab === 'personas' && <PersonasAndPeople models={models} />}
        {tab === 'folders' && <SourcesTab models={models} />}
        {tab === 'tasks' && (
          <TasksTab
            onOpenChat={chatProps.onOpen}
            onNewChat={() => {
              setTab('chats');
              chatProps.onChatsTabChange('chats');
              chatProps.onNewChat(null);
            }}
            onOpenMail={(id) => {
              setTab('chats');
              chatProps.onChatsTabChange('inbox');
              chatProps.onOpenMail(id);
            }}
            mailItems={chatProps.mail.items}
            models={models}
          />
        )}
        {tab === 'settings' && (
          <SettingsTab
            models={models}
            modelId={modelId}
            onSelectModel={onSelectModel}
            deadProvider={authDeadProvider}
            recallFocus={recallFocus}
          />
        )}
      </div>
    </div>
  );
}

// Memoized: App re-renders on every streamed frame (thread state lives there),
// and this panel is the whole right-hand side. Its props are kept referentially
// stable at streaming time (see threadStatuses/useShallowStable in App), so the
// memo actually holds during a reply.
export const ManagePanel = memo(ManagePanelImpl);

const WHO_SUBS = ['personas', 'people'] as const;

/** Personas (agents you mail) and People (the humans in your life) under one icon, like Sources. */
function PersonasAndPeople({ models }: { models: ModelSummary[] }) {
  const [sub, setSub] = useRememberedTab('stem.personas.sub', WHO_SUBS, 'personas');
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'personas' ? 'active' : ''} onClick={() => setSub('personas')}>
          Personas
        </button>
        <button className={sub === 'people' ? 'active' : ''} onClick={() => setSub('people')}>
          People
        </button>
      </div>
      {sub === 'personas' ? <PersonasTab models={models} /> : <PeopleTab />}
    </div>
  );
}
