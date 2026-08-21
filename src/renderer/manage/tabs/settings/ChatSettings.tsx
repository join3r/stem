import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type {
  ChatsSettings,
  CustomInstructionsSettings,
  DeviceInfo,
  ExecHostShellInfo,
  ExecSettings,
  HarnessSettings,
  ScratchUsageRow,
  WebSearchSettings,
  WindowsShell
} from '../../../../shared/types';
import { InfoTip } from '../../../ui/InfoTip';
import { ModelPicker } from '../../../ui/ModelPicker';
import { broadcastWebSearch, useWebSearchSync } from '../../../webSearch';
import { useRemoteServer } from '../../../hooks/useRemoteServer';
import type { ModelTabProps } from '../shared';
import { DisclosureRow, RowSelect, ValueRow } from './rows';
import { QuickChatSection } from './QuickChatSettings';

/** How long a chat's scratch folder survives being ignored. null = never sweep. */
const SCRATCH_TTLS: { label: string; days: number | null }[] = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'Never', days: null }
];

/** One-line meaning of each approval mode, shown under the row so the pick is legible. */
const APPROVAL_HINTS: Record<string, string> = {
  manual: 'Only allowlisted commands run on their own; everything else pauses for you',
  assisted: 'A safety check clears commands that serve your request; only flagged ones pause',
  yolo: 'Every command runs immediately, no questions asked'
};

/** "1.2 MB" / "834 KB" / "512 B" — one significant decimal above KB. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * What a row calls itself. The two title-less cases are different things and say
 * so: the pile predating per-chat folders, and a folder whose chat is gone.
 */
function scratchLabel(row: ScratchUsageRow): string {
  if (row.key === 'unfiled') return 'Unfiled — from before per-chat folders';
  return row.title || 'Deleted chat';
}

/**
 * Settings → Chat: everywhere you talk to Stem — the main conversation, the
 * Quick Chat overlay, and what the assistant is allowed to do while it works.
 * Grouped by what the user is deciding, not by which window implements it:
 * Conversation (which model answers, naming, instructions), Quick Chat (the
 * same decisions for the overlay), then autonomy (commands, coding agents).
 * Cosmetic and risky settings no longer share one undifferentiated list.
 *
 * Layout is the settings-row idiom (rows.tsx): the tab reads as an answer
 * sheet, and the bulky editors (allowlist pills, the scratch table) live one
 * level down behind their row.
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
  const [exec, setExec] = useState<ExecSettings | null>(null);
  const [harness, setHarness] = useState<HarnessSettings | null>(null);
  const [allowInput, setAllowInput] = useState('');
  // The OS of the machine that RUNS commands, plus the Git Bash it found there.
  // Asked of the server, not of this window: with Stem on a box somewhere,
  // window.stem.platform is this desk's OS and the shell setting is not about it.
  const [hostShell, setHostShell] = useState<ExecHostShellInfo | null>(null);
  const [bashPathDraft, setBashPathDraft] = useState('');
  const [bashPathError, setBashPathError] = useState('');
  // null while the walk is still running — sizing every chat's folder is a disk
  // walk on the server, so the block says "Measuring…" rather than "0 folders".
  const [scratch, setScratch] = useState<ScratchUsageRow[] | null>(null);
  const [confirmClear, setConfirmClear] = useState<string | null>(null);
  // Whether THIS computer accepts commands from the server — a client-local
  // fact, asked of this machine and only shown when there is a server elsewhere
  // to accept commands from.
  const remote = useRemoteServer();
  const [execHostEnabled, setExecHostEnabled] = useState<boolean | null>(null);
  const [harnessHostEnabled, setHarnessHostEnabled] = useState<boolean | null>(null);
  // Labels for the per-device allowlist groups. Devices that were unpaired keep
  // their entries readable (and deletable) under the raw id.
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // Per-field debounce so typing doesn't spam the atomic settings writer.
  const ciMainTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bashPathTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void window.stem.getSettings().then((s) => {
      setWs(s.webSearch);
      setCi(s.customInstructions);
      setChats(s.chats);
      setExec(s.exec);
      setHarness(s.harness);
      setBashPathDraft(s.exec.gitBashPath ?? '');
    });
    // Its own request: a disk walk should not hold up the settings the rest of
    // this tab is made of.
    void window.stem.getScratchUsage().then(setScratch).catch(() => setScratch([]));
    void window.stem
      .execHostShellInfo()
      .then(setHostShell)
      .catch(() => setHostShell(null));
    void window.stem.execHostState().then((s) => setExecHostEnabled(s.enabled)).catch(() => undefined);
    void window.stem.harnessHostState().then((s) => setHarnessHostEnabled(s.enabled)).catch(() => undefined);
    void window.stem
      .listDevices()
      .then((snap) => setDevices(snap.devices))
      .catch(() => undefined);
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

  function updateExec(patch: Partial<ExecSettings>) {
    setExec((cur) => (cur ? { ...cur, ...patch } : cur)); // optimistic; reconcile below
    window.stem.updateExecSettings(patch).then((s) => {
      setExec(s.exec);
      if (patch.gitBashPath !== undefined || patch.windowsShell !== undefined) {
        setBashPathDraft(s.exec.gitBashPath ?? '');
      }
    });
  }

  function updateHarness(patch: Partial<HarnessSettings>) {
    setHarness((cur) => (cur ? { ...cur, ...patch } : cur)); // optimistic; reconcile below
    window.stem.updateHarnessSettings(patch).then((s) => setHarness(s.harness));
  }

  async function chooseWindowsShell(next: WindowsShell) {
    if (!exec) return;
    // A half-typed path must not land after this click and argue with it.
    if (bashPathTimer.current) clearTimeout(bashPathTimer.current);
    if (next === 'cmd') {
      setBashPathError('');
      updateExec({ windowsShell: 'cmd' });
      return;
    }
    const path = (bashPathDraft.trim() || exec.gitBashPath || hostShell?.gitBashPath || '').trim();
    if (!path) {
      setBashPathError('Git Bash was not found. Paste the path to bash.exe, then choose Git Bash again.');
      return;
    }
    setBashPathError('');
    updateExec({ windowsShell: 'git-bash', gitBashPath: path });
  }

  function saveGitBashPath(value: string) {
    setBashPathDraft(value);
    if (bashPathTimer.current) clearTimeout(bashPathTimer.current);
    // Path only. Which shell is selected is the select's business — sending it
    // from here would write back whatever `exec` said when the keystroke
    // happened, undoing a pick made while the timer was pending.
    bashPathTimer.current = setTimeout(() => {
      const trimmed = value.trim();
      // Empty path keeps Git Bash selected; spawn auto-detects or falls back to cmd.
      updateExec({ gitBashPath: trimmed || null });
    }, 400);
  }

  async function browseGitBash() {
    const files = await window.stem.openFiles();
    const picked = files[0];
    if (!picked) return;
    // resolveGitBashExecutable ignores anything that is not bash.exe, so saving
    // a git.exe here would show a path in Settings that nothing ever uses.
    if (!picked.toLowerCase().endsWith('bash.exe')) {
      setBashPathError(`That is not bash.exe. Pick the shell itself, usually Git\\bin\\bash.exe.`);
      return;
    }
    setBashPathError('');
    setBashPathDraft(picked);
    updateExec({ windowsShell: 'git-bash', gitBashPath: picked });
  }

  function clearScratch(key: string) {
    setConfirmClear(null);
    // Optimistic: the row goes now, and the re-read below is what confirms it.
    setScratch((cur) => cur?.filter((r) => r.key !== key) ?? cur);
    void window.stem
      .clearScratch(key)
      .then(() => window.stem.getScratchUsage())
      .then(setScratch)
      .catch(() => undefined);
  }

  function saveCiMain(value: string) {
    setCi((c) => ({ ...c, main: value }));
    if (ciMainTimer.current) clearTimeout(ciMainTimer.current);
    ciMainTimer.current = setTimeout(() => void window.stem.updateCustomInstructions({ main: value }), 400);
  }

  // The closed rows carry their answer, so compute the summaries once here.
  const deviceAllowCount = exec
    ? Object.values(exec.deviceAllowlists).reduce((sum, prefixes) => sum + prefixes.length, 0)
    : 0;
  const allowCount = (exec?.allowlist.length ?? 0) + deviceAllowCount;
  const scratchSummary =
    scratch === null
      ? 'Measuring…'
      : scratch.length === 0
        ? 'empty'
        : `${formatSize(scratch.reduce((sum, r) => sum + r.bytes, 0))} · ${
            SCRATCH_TTLS.find((t) => t.days === exec?.scratchTtlDays)?.label ?? '30 days'
          }`;

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

      <div className="grp-head">Commands</div>
      <div className="group">
        <ValueRow
          label={<strong>Run commands</strong>}
          hint={
            <>
              Let Stem run shell commands (CLIs, git, agent-browser){' '}
              <InfoTip label="How command approval works">
                What runs on its own is governed by the approval mode below — from manual (you
                approve everything unlisted) to yolo (everything runs). Folders you marked
                read-only are always protected.
              </InfoTip>
            </>
          }
        >
          <button
            className={`switch${exec?.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={exec?.enabled ?? false}
            aria-label="Run commands"
            onClick={() => exec && updateExec({ enabled: !exec.enabled })}
          />
        </ValueRow>

        {exec?.enabled && (
          <>
            {hostShell?.platform === 'win32' && (
              <>
                <ValueRow
                  label={
                    <>
                      Windows shell{' '}
                      <InfoTip label="About the Windows shell">
                        Commands run in Git Bash when Git for Windows is installed, and fall back to
                        Command Prompt (cmd.exe) if it is not. Stem looks in the usual places (no
                        PowerShell); if Git is somewhere unusual, paste the path to its bash.exe.
                        Only Git for Windows counts — WSL's bash runs in a Linux VM, where the
                        read-only folder guard cannot see the paths it uses. Switching shells
                        changes which commands auto-run (dir vs ls) and how quotes work.
                      </InfoTip>
                    </>
                  }
                >
                  <RowSelect
                    ariaLabel="Windows shell"
                    value={exec.windowsShell === 'git-bash' ? 'git-bash' : 'cmd'}
                    options={[
                      { value: 'cmd', label: 'Command Prompt' },
                      { value: 'git-bash', label: 'Git Bash' }
                    ]}
                    onChange={(v) => void chooseWindowsShell(v as WindowsShell)}
                  />
                </ValueRow>
                {(exec.windowsShell === 'git-bash' || bashPathError) && (
                  <div className="set-vbody">
                    <div className="exec-bash-path">
                      <input
                        className="ifield"
                        type="text"
                        placeholder={hostShell?.gitBashPath || 'C:\\Program Files\\Git\\bin\\bash.exe'}
                        aria-label="Path to Git Bash bash.exe"
                        value={bashPathDraft}
                        onChange={(e) => saveGitBashPath(e.target.value)}
                      />
                      <button type="button" className="link-btn" onClick={() => void browseGitBash()}>
                        Browse
                      </button>
                    </div>
                    {bashPathError && <em className="scratch-empty">{bashPathError}</em>}
                  </div>
                )}
              </>
            )}

            <ValueRow
              label={
                <>
                  Approval mode{' '}
                  <InfoTip label="About approval modes">
                    <strong>Manual</strong> — only allowlisted commands run on their own; everything
                    else pauses for your approval. <strong>Assisted</strong> — an AI safety check
                    clears commands that serve your request; only flagged ones pause.{' '}
                    <strong>Yolo</strong> — every command runs immediately, no questions asked (folders
                    you marked read-only stay protected). The safety check is a heuristic, not a
                    security boundary; the model it runs on lives under Models. A card that pauses
                    waits ten minutes for you — after that the command is dropped and the assistant
                    is told nobody answered, not that you refused.
                  </InfoTip>
                </>
              }
              hint={APPROVAL_HINTS[exec.approvalMode]}
            >
              <RowSelect
                ariaLabel="Approval mode"
                value={exec.approvalMode}
                options={[
                  { value: 'manual', label: 'Manual' },
                  { value: 'assisted', label: 'Assisted' },
                  { value: 'yolo', label: 'Yolo', title: 'Every command runs immediately — use with care' }
                ]}
                onChange={(v) => updateExec({ approvalMode: v as ExecSettings['approvalMode'] })}
              />
            </ValueRow>

            {exec.approvalMode !== 'yolo' && (
              <DisclosureRow
                label={
                  <>
                    Always-allowed commands{' '}
                    <InfoTip label="About the allowlist">
                      Command prefixes that run without the safety check — grown by the approval card's
                      "Always allow" button or added here (e.g. <code>git push</code> or <code>npm</code>).
                    </InfoTip>
                  </>
                }
                value={allowCount === 0 ? 'none' : `${allowCount} ${allowCount === 1 ? 'prefix' : 'prefixes'}`}
              >
                {exec.allowlist.length > 0 && (
                  <div className="exec-allowlist">
                    {exec.allowlist.map((prefix) => (
                      <span key={prefix} className="pill">
                        {prefix}
                        <button
                          title={`Remove "${prefix}"`}
                          aria-label={`Remove "${prefix}" from the allowlist`}
                          onClick={() => updateExec({ allowlist: exec.allowlist.filter((p) => p !== prefix) })}
                        >
                          <X size={11} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                {/* Prefixes approved for a specific computer, one group per
                    machine. Grown only by the approval card — a prefix trusted
                    on your Mac says nothing about the next machine, so there is
                    no add field here. */}
                {Object.entries(exec.deviceAllowlists).map(([deviceId, prefixes]) =>
                  prefixes.length === 0 ? null : (
                    <div key={deviceId} className="set-block">
                      <span className="set-sub">
                        On {devices.find((d) => d.id === deviceId)?.label ?? `an unpaired computer (${deviceId})`}
                      </span>
                      <div className="exec-allowlist">
                        {prefixes.map((prefix) => (
                          <span key={prefix} className="pill">
                            {prefix}
                            <button
                              title={`Remove "${prefix}"`}
                              aria-label={`Remove "${prefix}" from this computer's allowlist`}
                              onClick={() =>
                                updateExec({
                                  deviceAllowlists: {
                                    ...exec.deviceAllowlists,
                                    [deviceId]: prefixes.filter((p) => p !== prefix)
                                  }
                                })
                              }
                            >
                              <X size={11} />
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  )
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const prefix = allowInput.trim();
                    if (!prefix || exec.allowlist.includes(prefix)) return;
                    updateExec({ allowlist: [...exec.allowlist, prefix] });
                    setAllowInput('');
                  }}
                >
                  <input
                    className="ifield"
                    type="text"
                    placeholder="Add a prefix, e.g. git push"
                    aria-label="Add an allowlisted command prefix"
                    value={allowInput}
                    onChange={(e) => setAllowInput(e.target.value)}
                  />
                </form>
              </DisclosureRow>
            )}

            <DisclosureRow
              label={
                <>
                  Scratch files{' '}
                  <InfoTip label="About scratch files">
                    Commands run in a folder of their own per chat, so downloads, scripts and build
                    output stay with the conversation that made them. Deleting a chat deletes its
                    folder. A folder is cleared once nothing in it — and nothing in the chat — has
                    been touched for the chosen time; anything you want kept belongs in your Files.
                  </InfoTip>
                </>
              }
              value={scratchSummary}
            >
              <label className="set-block">
                <span className="set-sub">Clear after</span>
                <select
                  className="ifield"
                  aria-label="Clear scratch files after"
                  value={exec.scratchTtlDays === null ? 'never' : String(exec.scratchTtlDays)}
                  onChange={(e) =>
                    updateExec({ scratchTtlDays: e.target.value === 'never' ? null : Number(e.target.value) })
                  }
                >
                  {SCRATCH_TTLS.map((opt) => (
                    <option key={opt.label} value={opt.days === null ? 'never' : String(opt.days)}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="scratch-usage">
                {scratch === null ? (
                  <em className="scratch-empty">Measuring…</em>
                ) : scratch.length === 0 ? (
                  <em className="scratch-empty">No chat has run a command yet.</em>
                ) : (
                  <>
                    <div className="scratch-total">
                      {scratch.length} {scratch.length === 1 ? 'folder' : 'folders'} ·{' '}
                      {formatSize(scratch.reduce((sum, r) => sum + r.bytes, 0))}
                    </div>
                    {scratch.map((row) => (
                      <div key={row.key} className="scratch-row">
                        <span className="scratch-name" title={scratchLabel(row)}>
                          {scratchLabel(row)}
                        </span>
                        <span className="scratch-size">{formatSize(row.bytes)}</span>
                        {/* Two-step, like every other irreversible delete here: the
                            files are gone for good and the chat may still refer to them. */}
                        {confirmClear === row.key ? (
                          <>
                            <button className="link-btn danger" onClick={() => clearScratch(row.key)}>
                              Delete files
                            </button>
                            <button className="link-btn" onClick={() => setConfirmClear(null)}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            className="link-btn"
                            title="Delete this folder's files — the chat itself stays"
                            onClick={() => setConfirmClear(row.key)}
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </DisclosureRow>
          </>
        )}

        {/* THIS computer's consent to run commands the server sends it. Only
            offered when the server is elsewhere — on a local install the switch
            above already governs the only machine there is. The state is
            client-local (see desktop/exec-host/store.ts) and never on the
            wire, which is why this block does not read `exec`. */}
        {remote && execHostEnabled !== null && (
          <ValueRow
            label={<strong>Run commands on this computer</strong>}
            hint={
              <>
                Let your Stem server run commands here — for the things only this machine has{' '}
                <InfoTip label="What switching this on means">
                  With this on, the assistant can target this computer by name and commands run
                  here after the same approval policy as everywhere else — but nothing on this
                  machine is pre-approved: every command prefix is judged or asks you until you
                  choose "Always allow" for it. Switching this off stops new commands
                  immediately. Leave it off if this Stem server isn't yours alone.
                </InfoTip>
              </>
            }
          >
            <button
              className={`switch${execHostEnabled ? ' on' : ''}`}
              role="switch"
              aria-checked={execHostEnabled}
              aria-label="Run commands on this computer"
              onClick={() =>
                void window.stem
                  .setExecHostEnabled(!execHostEnabled)
                  .then((s) => setExecHostEnabled(s.enabled))
              }
            />
          </ValueRow>
        )}
      </div>

      <div className="grp-head">Coding agents</div>
      <div className="group">
        <ValueRow
          label={<strong>Delegate coding work</strong>}
          hint={
            <>
              Let Stem drive an external coding agent (Claude Code, OpenCode){' '}
              <InfoTip label="What coding agents do">
                With this on, Stem can hand real coding work to a coding agent installed on this
                machine, watch it, and relay its questions to you. The agent works with your own
                logins and files; risky commands pause on an approval card, and folders you marked
                read-only stay protected. Off by default so switching it on is your decision.
              </InfoTip>
            </>
          }
        >
          <button
            className={`switch${harness?.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={harness?.enabled ?? false}
            aria-label="Delegate coding work"
            onClick={() => harness && updateHarness({ enabled: !harness.enabled })}
          />
        </ValueRow>

        {/* THIS computer's consent to run coding agents the server sends it.
            Only offered when the server is elsewhere, for the exec-host reason:
            on a local install the switch above already governs the only machine
            there is. Client-local state, never on the wire. */}
        {remote && harnessHostEnabled !== null && (
          <ValueRow
            label={<strong>Run coding agents on this computer</strong>}
            hint={
              <>
                Let your Stem server drive a coding agent installed here{' '}
                <InfoTip label="What switching this on means">
                  With this on, the assistant can target this computer by name and a coding agent
                  (Claude Code, OpenCode) runs here with this machine's own logins and files.
                  Risky commands still pause on an approval card. Switching this off stops new
                  runs immediately. Leave it off if this Stem server isn't yours alone.
                </InfoTip>
              </>
            }
          >
            <button
              className={`switch${harnessHostEnabled ? ' on' : ''}`}
              role="switch"
              aria-checked={harnessHostEnabled}
              aria-label="Run coding agents on this computer"
              onClick={() =>
                void window.stem
                  .setHarnessHostEnabled(!harnessHostEnabled)
                  .then((s) => setHarnessHostEnabled(s.enabled))
              }
            />
          </ValueRow>
        )}
      </div>
    </div>
  );
}
