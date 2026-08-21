import { useEffect, useRef, useState } from 'react';
import { X, Check, Copy, TriangleAlert } from 'lucide-react';
import type {
  CustomInstructionsSettings,
  ModelSummary,
  WebSearchSettings,
  QuickChatSettings as QuickChatSettingsType,
  QuickChatShortcutStatus
} from '../../../../shared/types';
import { appDefaultModel } from '../../../../shared/modelRoles';
import { ModelPicker } from '../../../ui/ModelPicker';
import { EFFORT_LABELS } from '../../../modelLabels';
import { broadcastWebSearch, useWebSearchSync } from '../../../webSearch';
import { ShortcutRecorder } from './shortcut';
import { DisclosureRow, RowSelect, ValueRow } from './rows';

// Inactivity presets for starting a fresh Quick Chat thread on re-summon.
// 0 = never (always continue the current session).
const NEW_THREAD_PRESETS: { label: string; ms: number }[] = [
  { label: 'Off', ms: 0 },
  { label: '1m', ms: 60_000 },
  { label: '5m', ms: 5 * 60_000 },
  { label: '15m', ms: 15 * 60_000 }
];

/**
 * Settings → Chat → Quick Chat: the overlay you summon from anywhere. It lives
 * on the Chat tab, not App, because nearly everything here is a conversation
 * default (model, effort, instructions, when a thread restarts) — the overlay
 * being its own window is an implementation detail, not a reason to file its
 * settings under the shell. The summon shortcut stays with it so the feature
 * reads as one thing.
 */
export function QuickChatSection({ models }: { models: ModelSummary[] }) {
  const [qc, setQc] = useState<QuickChatSettingsType | null>(null);
  const [ws, setWs] = useState<WebSearchSettings>({
    main: true,
    quickChat: true,
    provider: 'auto',
    credentials: {}
  });
  const [ci, setCi] = useState<CustomInstructionsSettings>({ main: '', quickChat: '' });
  const [shortcutStatus, setShortcutStatus] = useState<QuickChatShortcutStatus | null>(null);
  const [copiedSummon, setCopiedSummon] = useState(false);
  // Per-field debounce so typing doesn't spam the atomic settings writer.
  const ciQuickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The Quick Chat overlay carries the same switch on its own bar — a different
  // window, so no in-window event reaches here. Re-read the flags whenever this
  // window comes forward, which is the first moment the stale box could be seen.
  useEffect(() => {
    const reload = () =>
      void window.stem
        .getSettings()
        .then((s) => setWs(s.webSearch))
        .catch(() => undefined);
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
  }, []);

  useEffect(() => {
    void window.stem.getSettings().then((s) => {
      setQc(s.quickChat);
      setWs(s.webSearch);
      setCi(s.customInstructions);
    });
    void window.stem.getQuickChatShortcutStatus().then(setShortcutStatus);
  }, []);

  // The Conversation card above and the composer button write the same two
  // booleans in this same window — follow whichever was clicked.
  useWebSearchSync((flags) => setWs((cur) => ({ ...cur, ...flags })));

  function update(patch: Partial<QuickChatSettingsType>) {
    window.stem.updateQuickChat(patch).then((s) => setQc(s.quickChat));
  }

  /** Re-bind, then re-read whether the OS actually granted the new accelerator. */
  function updateShortcut(accel: string | null) {
    window.stem.updateQuickChat({ shortcut: accel }).then(async (s) => {
      setQc(s.quickChat);
      setShortcutStatus(await window.stem.getQuickChatShortcutStatus());
    });
  }

  function copySummonCommand() {
    if (!shortcutStatus) return;
    void navigator.clipboard.writeText(shortcutStatus.summonCommand).then(() => {
      setCopiedSummon(true);
      setTimeout(() => setCopiedSummon(false), 1600);
    });
  }

  function updateWebSearch(patch: Partial<WebSearchSettings>) {
    setWs((cur) => ({ ...cur, ...patch })); // optimistic; reconcile below
    window.stem.updateWebSearch(patch).then((s) => {
      setWs(s.webSearch);
      broadcastWebSearch(s.webSearch);
    });
  }

  function saveCiQuick(value: string) {
    setCi((c) => ({ ...c, quickChat: value }));
    if (ciQuickTimer.current) clearTimeout(ciQuickTimer.current);
    ciQuickTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ quickChat: value }), 400);
  }

  if (!qc) return <p className="muted">Loading…</p>;

  // The Quick Chat default-effort options follow the chosen default model's capabilities.
  // "Same as main" (empty) has no concrete model here, so offer all levels.
  const qcModel = qc.defaultModel ? models.find((m) => m.id === qc.defaultModel) : undefined;
  const qcEfforts = qcModel?.supportedEfforts.length ? qcModel.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
  // Only models with a priority (Fast) tier can default to Fast. With no concrete model
  // ("Same as main"), offer it — the runtime ignores Fast on models that don't support it.
  const qcFastTier = qcModel?.serviceTiers.find((t) => t.id === 'priority');
  const qcHasFast = qcModel ? !!qcFastTier : true;

  // Switch the default model, clamping a now-unsupported saved effort/speed into range.
  function selectQcModel(id: string | null) {
    const m = id ? models.find((x) => x.id === id) : undefined;
    const efforts = m?.supportedEfforts.length ? m.supportedEfforts : ['low', 'medium', 'high', 'xhigh'];
    const patch: Partial<QuickChatSettingsType> = { defaultModel: id };
    if (qc && !efforts.includes(qc.defaultEffort)) patch.defaultEffort = m?.defaultEffort ?? efforts[0];
    // Drop a saved Fast default when the new model has no priority tier.
    if (qc?.defaultServiceTier === 'priority' && m && !m.serviceTiers.some((t) => t.id === 'priority')) {
      patch.defaultServiceTier = null;
    }
    update(patch);
  }

  return (
    <>
      <div className="grp-head">Quick Chat</div>
      <div className="group">
        <ValueRow label={<strong>Summon with</strong>} hint="From anywhere; Escape or the shortcut again hides it">
          <ShortcutRecorder value={qc.shortcut} onChange={updateShortcut} />
        </ValueRow>
        {/* The recorder can't tell whether the key is live: the grab happens in the OS.
            Main reports that back, so a shortcut that will never fire says so here
            instead of looking configured and doing nothing. */}
        {qc.shortcut && shortcutStatus && !shortcutStatus.registered && (
          <div className="set-vbody">
            <span className="retrieval-test-status err">
              <X size={12} />
              The system refused this combination — another app is probably holding it. Record a
              different one.
            </span>
          </div>
        )}
        {/* A granted grab is not the same as a delivered key: most Linux desktops keep
            Super for themselves and swallow it before Stem sees it. */}
        {window.stem.platform === 'linux' &&
          !shortcutStatus?.wayland &&
          qc.shortcut?.includes('Super') &&
          shortcutStatus?.registered && (
            <div className="set-vbody">
              <span className="set-sub">
                Most Linux desktops reserve the Super key for themselves. If nothing happens when
                you press this, record a combination with Ctrl or Alt instead.
              </span>
            </div>
          )}
        {shortcutStatus?.wayland && (
          <div className="set-vbody">
            <p className="pair-warn">
              <TriangleAlert size={13} />
              <span>
                This is a Wayland session, where an app can't grab a key for itself — the
                shortcut above stays silent no matter what you record. Add a custom keyboard
                shortcut in your system settings that runs this command instead:
              </span>
            </p>
            <code className="pair-cmd">{shortcutStatus.summonCommand}</code>
            <div className="pair-actions">
              <button
                className="retrieval-test-btn"
                onClick={copySummonCommand}
                title="Copy the summon command"
              >
                <Copy size={14} />
                <span>Copy command</span>
              </button>
              {copiedSummon && (
                <span className="retrieval-test-status ok">
                  <Check size={12} />
                  Copied
                </span>
              )}
            </div>
          </div>
        )}

        <ValueRow label="Default model">
          <ModelPicker
            models={models}
            value={qc.defaultModel}
            onChange={selectQcModel}
            emptyLabel="Same as main"
            ariaLabel="Quick Chat default model"
            resolvedDefault={appDefaultModel(models)}
          />
        </ValueRow>

        <ValueRow label="Web search" hint="Live results with citations, in the overlay">
          <input
            type="checkbox"
            className="vcheck"
            aria-label="Quick Chat web search"
            checked={ws.quickChat}
            onChange={(e) => updateWebSearch({ quickChat: e.target.checked })}
          />
        </ValueRow>

        <ValueRow label="Default effort">
          <RowSelect
            ariaLabel="Quick Chat default effort"
            value={qc.defaultEffort}
            options={qcEfforts.map((e) => ({ value: e, label: EFFORT_LABELS[e] ?? e }))}
            onChange={(e) => update({ defaultEffort: e })}
          />
        </ValueRow>

        {qcHasFast && (
          <ValueRow label="Default speed">
            <RowSelect
              ariaLabel="Quick Chat default speed"
              value={qc.defaultServiceTier === 'priority' ? 'priority' : ''}
              options={[
                { value: '', label: 'Standard' },
                {
                  value: 'priority',
                  label: 'Fast',
                  title: qcFastTier?.description ?? '1.5× speed, increased usage'
                }
              ]}
              onChange={(v) => update({ defaultServiceTier: v === 'priority' ? 'priority' : null })}
            />
          </ValueRow>
        )}

        <ValueRow label="Show on all displays" hint="Float above every Space & the active display">
          <button
            className={`switch${qc.showOnAllDisplays ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.showOnAllDisplays}
            aria-label="Show on all displays"
            onClick={() => update({ showOnAllDisplays: !qc.showOnAllDisplays })}
          />
        </ValueRow>

        <ValueRow
          label="Show progress on other Spaces"
          hint="Float the progress pill when the main window loses focus & a thread is running"
        >
          <button
            className={`switch${qc.followAcrossSpaces ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.followAcrossSpaces}
            aria-label="Show progress on other Spaces"
            onClick={() => update({ followAcrossSpaces: !qc.followAcrossSpaces })}
          />
        </ValueRow>

        <ValueRow label="Sound when finished" hint="A chime when a turn finishes while the pill is visible">
          <button
            className={`switch${qc.finishSound ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.finishSound}
            aria-label="Sound when finished"
            onClick={() => update({ finishSound: !qc.finishSound })}
          />
        </ValueRow>

        <ValueRow
          label="Skip the Inbox"
          hint="Quick chats go straight to Archived once answered — opening one brings it back"
        >
          <button
            className={`switch${qc.skipInbox ? ' on' : ''}`}
            role="switch"
            aria-checked={qc.skipInbox}
            aria-label="Skip the Inbox"
            onClick={() => update({ skipInbox: !qc.skipInbox })}
          />
        </ValueRow>

        <ValueRow label="New thread after idle" hint="Re-summoning after this idle time starts fresh">
          <RowSelect
            ariaLabel="New thread after idle"
            value={String(qc.newThreadTimeoutMs)}
            options={NEW_THREAD_PRESETS.map((p) => ({ value: String(p.ms), label: p.label }))}
            onChange={(v) => update({ newThreadTimeoutMs: Number(v) })}
          />
        </ValueRow>

        <DisclosureRow label="Extra instructions" value={ci.quickChat.trim() ? ci.quickChat.trim() : 'not set'}>
          <textarea
            className="ci-textarea"
            value={ci.quickChat}
            onChange={(e) => saveCiQuick(e.target.value)}
            rows={3}
            placeholder="e.g. Be even more terse here — one or two sentences."
          />
          <p className="muted">Layered on top of your main custom instructions, only in the Quick Chat overlay.</p>
        </DisclosureRow>
      </div>
    </>
  );
}
