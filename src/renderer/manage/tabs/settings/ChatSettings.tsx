import { useEffect, useRef, useState } from 'react';
import type { ChatsSettings, CustomInstructionsSettings, WebSearchSettings } from '../../../../shared/types';
import { InfoTip } from '../../../ui/InfoTip';
import { ModelPicker } from '../../../ui/ModelPicker';
import { broadcastWebSearch, useWebSearchSync } from '../../../webSearch';
import type { ModelTabProps } from '../shared';
import { DisclosureRow, RowSelect, ValueRow } from './rows';
import { QuickChatSection } from './QuickChatSettings';

/**
 * Settings → Chat: everywhere you talk to Stem — the main conversation and the
 * Quick Chat overlay. Which model answers, how chats get named, and the
 * instructions carried into every turn. What the assistant may DO while it
 * works (commands, coding agents) lives under App: that policy governs every
 * conversation at once, so it is the shell's business, not any one chat's.
 *
 * Layout is the settings-row idiom (rows.tsx): the tab reads as an answer
 * sheet, and the instruction textareas live one level down behind their row.
 */
export function ChatSettings({ models, modelId, onSelectModel }: ModelTabProps) {
  const [ws, setWs] = useState<WebSearchSettings>({
    main: true,
    quickChat: true,
    provider: 'auto',
    credentials: {}
  });
  const [ci, setCi] = useState<CustomInstructionsSettings>({ main: '', quickChat: '' });
  const [chats, setChats] = useState<ChatsSettings | null>(null);
  // Per-field debounce so typing doesn't spam the atomic settings writer.
  const ciMainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void window.stem.getSettings().then((s) => {
      setWs(s.webSearch);
      setCi(s.customInstructions);
      setChats(s.chats);
    });
  }, []);

  // The composer's Web button is the same switch, one component away in this same
  // window: tell it after the write, and follow it when it is the one clicked.
  useWebSearchSync((flags) => setWs((cur) => ({ ...cur, ...flags })));

  function updateWebSearch(patch: Partial<WebSearchSettings>) {
    setWs((cur) => ({ ...cur, ...patch })); // optimistic; reconcile below
    window.stem.updateWebSearch(patch).then((s) => {
      setWs(s.webSearch);
      broadcastWebSearch(s.webSearch);
    });
  }

  function updateChats(patch: Partial<ChatsSettings>) {
    setChats((cur) => (cur ? { ...cur, ...patch } : cur)); // optimistic; reconcile below
    window.stem.updateChatsSettings(patch).then((s) => {
      setChats(s.chats);
      // The chat list lives in this same window and re-reads the settings for
      // itself. Told after the write, not before, or it would read the old value.
      window.dispatchEvent(new CustomEvent('stem:chat-settings'));
    });
  }

  function saveCiMain(value: string) {
    setCi((c) => ({ ...c, main: value }));
    if (ciMainTimer.current) clearTimeout(ciMainTimer.current);
    ciMainTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ main: value }), 400);
  }

  return (
    <div>
      <div className="grp-head">Conversation</div>
      <div className="group">
        {models.length === 0 ? (
          <div className="set-vrow">
            <span className="vlab">
              <em>Loading models…</em>
            </span>
          </div>
        ) : (
          <ValueRow label="Model">
            <ModelPicker
              models={models}
              value={modelId}
              onChange={(id) => onSelectModel(id ?? '')}
              ariaLabel="Model"
            />
          </ValueRow>
        )}
        <ValueRow label="Web search" hint="Live results with citations">
          <input
            type="checkbox"
            className="vcheck"
            aria-label="Web search"
            checked={ws.main}
            onChange={(e) => updateWebSearch({ main: e.target.checked })}
          />
        </ValueRow>
        <ValueRow
          label={
            <>
              Subjects{' '}
              <InfoTip label="About chat subjects">
                Stem writes each chat a short subject the way an email names a thread — once its
                first reply has landed, then now and then as the chat grows.{' '}
                <strong>Everywhere</strong> uses it as the chat's name, so the list, search and the
                window title all agree. <strong>Inbox only</strong> shows it in the Inbox and leaves
                names alone. <strong>Off</strong> never calls a model — a chat is named after the
                first line you typed. A name you type yourself is never overwritten. The model that
                writes them lives under Models.
              </InfoTip>
            </>
          }
        >
          <RowSelect
            ariaLabel="Subjects"
            value={chats?.subjects ?? 'everywhere'}
            options={[
              { value: 'off', label: 'Off', title: 'Never write subjects' },
              { value: 'inbox', label: 'Inbox only', title: "Write subjects, but don't rename chats" },
              { value: 'everywhere', label: 'Everywhere', title: "Use the subject as the chat's name" }
            ]}
            onChange={(v) => updateChats({ subjects: v as ChatsSettings['subjects'] })}
          />
        </ValueRow>
        <ValueRow
          label={
            <>
              Preview lines in the Inbox{' '}
              <InfoTip label="About preview lines">
                How much of the newest message each Inbox row shows underneath its subject. The Chats
                tree is unaffected — it stays one line per chat.
              </InfoTip>
            </>
          }
        >
          <RowSelect
            ariaLabel="Preview lines in the Inbox"
            value={String(chats?.previewLines ?? 1)}
            options={[
              { value: '0', label: 'None' },
              { value: '1', label: '1 line' },
              { value: '2', label: '2 lines' }
            ]}
            onChange={(v) => updateChats({ previewLines: Number(v) as ChatsSettings['previewLines'] })}
          />
        </ValueRow>
        <DisclosureRow
          label={
            <>
              Standing instructions{' '}
              <InfoTip label="About standing instructions">
                High-priority directives Stem follows in every reply — in the main app and in Quick
                Chat. Stem can also update these itself when you ask it to.
              </InfoTip>
            </>
          }
          value={ci.main.trim() ? ci.main.trim() : 'not set'}
        >
          <textarea
            className="ci-textarea"
            value={ci.main}
            onChange={(e) => saveCiMain(e.target.value)}
            rows={5}
            placeholder="e.g. Reply briefly and to the point. Use plain Markdown unless I ask for components."
          />
        </DisclosureRow>
      </div>

      <QuickChatSection models={models} />
    </div>
  );
}
