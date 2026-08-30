import { memo } from 'react';
import { Brain, Plug, FolderTree, CalendarClock, Settings, MessageSquare, Users } from 'lucide-react';
import { ChatList, type ChatListProps } from '../chats/ChatList';
import { MemoryTab } from './tabs/MemoryTab';
import { McpSkillsTab } from './tabs/McpTab';
import { SourcesTab } from './tabs/FoldersTab';
import { PersonasTab } from './tabs/PersonasTab';
import { TasksTab } from './tabs/TasksTab';
import { SettingsTab } from './tabs/settings/SettingsTab';
import { useRememberedTab } from '../hooks/useRememberedTab';
import { useRetrievalHealth } from '../hooks/useRetrievalHealth';
import type { ModelTabProps, ActiveFactsViewProps } from './tabs/shared';

type Tab = 'chats' | 'memory' | 'mcp' | 'personas' | 'folders' | 'tasks' | 'settings';

// Naming notes: "Tools", not "MCP" — the tab holds skills as well as MCP servers.
// "Sources", not "Folders" — the Chats tab already organizes threads into folders,
// so a second tab called Folders (connected filesystem dirs) collided with it.
// Sources covers both places the assistant reads from: the Files drop-place and
// connected folders, as sub-tabs.
const TABS: { id: Tab; label: string; icon: typeof Brain }[] = [
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'mcp', label: 'Tools — MCP & skills', icon: Plug },
  { id: 'personas', label: 'Personas', icon: Users },
  { id: 'folders', label: 'Sources — files & connected folders', icon: FolderTree },
  { id: 'tasks', label: 'Scheduled tasks', icon: CalendarClock },
  { id: 'settings', label: 'Settings', icon: Settings }
];

const TAB_IDS = TABS.map((t) => t.id);

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
  ...chatProps
}: ManagePanelProps) {
  const activeFacts: ActiveFactsViewProps = {
    activeThreadId,
    activeRunning,
    previewActive,
    previewDraft,
    onTogglePreview
  };
  const [tab, setTab] = useRememberedTab<Tab>('stem.manage.tab', TAB_IDS, 'chats');
  // A down retrieval model degrades recall silently (selection falls back to
  // lexical/recency), so it gets the same red dot a dead provider does.
  const retrievalBroken = useRetrievalHealth().broken;
  // Personas working on mail in the background: the desktop's HUD pill stays
  // quiet for hidden mail turns, so this pulsing dot is the one "something is
  // happening" signal until the reply lands (and becomes the unread badge).
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
                {/* The unread badge wins the corner once a reply lands. */}
                {id === 'chats' && mailWorking && unread === 0 && <span className="tab-working-dot" />}
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
        {tab === 'memory' && <MemoryTab models={models} activeFacts={activeFacts} />}
        {tab === 'mcp' && <McpSkillsTab models={models} />}
        {tab === 'personas' && <PersonasTab models={models} />}
        {tab === 'folders' && <SourcesTab models={models} />}
        {tab === 'tasks' && <TasksTab onOpenChat={chatProps.onOpen} models={models} />}
        {tab === 'settings' && (
          <SettingsTab
            models={models}
            modelId={modelId}
            onSelectModel={onSelectModel}
            deadProvider={authDeadProvider}
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
