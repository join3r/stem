import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import type {
  ComputerHostLocalState,
  DeviceInfo,
  ExecHostShellInfo,
  ExecSettings,
  ScratchUsageRow,
  WindowsShell
} from '../../../../shared/types';
import { InfoTip } from '../../../ui/InfoTip';
import { useRemoteServer } from '../../../hooks/useRemoteServer';
import { DisclosureRow, RowSelect, ValueRow } from './rows';
import { ChatCodingRows, ChatComputerRows } from './ChatFeatureRows';
import {
  commandRegexError,
  MAX_COMMAND_ALLOW_RULES,
  MAX_COMMAND_PREFIX_LENGTH
} from '../../../../shared/exec-rules';

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
 * Settings → Features → Commands / Coding agents / Computer control: what the
 * assistant may DO on your machines. Not under App, because it isn't a property
 * of any one conversation — the same policy governs the main chat, Quick Chat
 * and every scheduled run, and the machine consenting is its own business. App
 * keeps everything about talking; this is everything about acting.
 */
export function AutonomySections() {
  const [exec, setExec] = useState<ExecSettings | null>(null);
  const [allowInput, setAllowInput] = useState('');
  const [allowKind, setAllowKind] = useState<'prefix' | 'regex'>('prefix');
  const [allowError, setAllowError] = useState('');
  const [execSaveError, setExecSaveError] = useState('');
  const [execSaving, setExecSaving] = useState(false);
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
  // Whether THIS Mac lets the server drive its screen, plus the macOS grants
  // the helper has. Null until asked; `supported: false` off macOS.
  const [computerHost, setComputerHost] = useState<ComputerHostLocalState | null>(null);
  // Labels for the per-device allowlist groups. Devices that were unpaired keep
  // their entries readable (and deletable) under the raw id.
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // This client's own device id: "this computer" is where the chat rows start
  // a fixed pick when it qualifies.
  const [clientDeviceId, setClientDeviceId] = useState<string | null>(null);
  // Debounced so typing a path doesn't spam the atomic settings writer.
  const bashPathTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const execSavePending = useRef(false);

  useEffect(() => {
    void window.stem.getSettings().then((s) => {
      setExec(s.exec);
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
    void window.stem.computerHostState().then(setComputerHost).catch(() => undefined);
    // The grants are changed in System Settings, so re-read them each time the
    // user comes back here rather than making them press Re-check.
    const refreshComputer = () => {
      void window.stem.computerHostState().then(setComputerHost).catch(() => undefined);
    };
    window.addEventListener('focus', refreshComputer);
    refreshDevices();
    void window.stem
      .clientInfo()
      .then((c) => setClientDeviceId(c.deviceId))
      .catch(() => undefined);
    return () => window.removeEventListener('focus', refreshComputer);
  }, []);

  // Also after a consent switch flips: the chat rows offer the machines that
  // said yes, and this one just changed its answer.
  function refreshDevices() {
    void window.stem
      .listDevices()
      .then((snap) => setDevices(snap.devices))
      .catch(() => undefined);
  }

  async function updateExec(patch: Partial<ExecSettings>): Promise<boolean> {
    if (execSavePending.current) {
      setExecSaveError('Wait for the current command setting to finish saving.');
      return false;
    }
    const previous = exec;
    execSavePending.current = true;
    setExecSaving(true);
    setExecSaveError('');
    setExec((cur) => (cur ? { ...cur, ...patch } : cur));
    try {
      const s = await window.stem.updateExecSettings(patch);
      if (patch.allowRegex && !Array.isArray(s.exec.allowRegex)) throw new Error('Regex rules are unsupported.');
      setExec(s.exec);
      if (patch.gitBashPath !== undefined || patch.windowsShell !== undefined) {
        setBashPathDraft(s.exec.gitBashPath ?? '');
      }
      return true;
    } catch {
      setExec(previous);
      setExecSaveError('Could not save command settings. Check the connection and try again.');
      return false;
    } finally {
      execSavePending.current = false;
      setExecSaving(false);
    }
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

  // The closed rows carry their answer, so compute the summaries once here.
  const deviceAllowCount = exec
    ? Object.values(exec.deviceAllowlists).reduce((sum, prefixes) => sum + prefixes.length, 0)
    : 0;
  const allowRegex = exec?.allowRegex ?? [];
  const regexSupported = Array.isArray(exec?.allowRegex);
  const allowCount = (exec?.allowlist.length ?? 0) + allowRegex.length + deviceAllowCount;
  const scratchSummary =
    scratch === null
      ? 'Measuring…'
      : scratch.length === 0
        ? 'empty'
        : `${formatSize(scratch.reduce((sum, r) => sum + r.bytes, 0))} · ${
            SCRATCH_TTLS.find((t) => t.days === exec?.scratchTtlDays)?.label ?? '30 days'
          }`;

  return (
    <>
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
          </>
        )}

        {/* The approval mode and allowlist govern commands wherever they run —
            Stem's own run_command tool AND commands a coding agent asks to
            run. A code persona can always bring a command, so this block never
            hides behind the command-execution switch. */}
        {exec && (
          <>
            <ValueRow
              label={
                <>
                  Approval mode{' '}
                  <InfoTip label="About approval modes">
                    Governs every command — ones Stem runs itself and ones a coding agent asks to
                    run. <strong>Manual</strong> — only allowlisted commands run on their own;
                    everything else pauses for your approval. <strong>Assisted</strong> — an AI
                    safety check clears commands that serve your request; only flagged ones pause.{' '}
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
            {execSaveError && (
              <div className="exec-save-error" role="alert">
                {execSaveError}
              </div>
            )}

            {exec.approvalMode !== 'yolo' && (
              <DisclosureRow
                label={
                  <>
                    Always-allowed commands{' '}
                    <InfoTip label="About the allowlist">
                      Prefix and Regex rules that run without the safety check for Stem’s own commands
                      and coding agents. Regex matches one whole command segment exactly as written,
                      including quotes; every segment in a chain must match separately. Folder and unsafe-command
                      guards still apply. Pathological JavaScript regex can make approvals unresponsive. Approval
                      cards only learn Prefix rules.
                    </InfoTip>
                  </>
                }
                value={allowCount === 0 ? 'none' : `${allowCount} ${allowCount === 1 ? 'rule' : 'rules'}`}
              >
                {exec.allowlist.length > 0 && (
                  <div className="exec-rule-group">
                    <span className="set-sub">Prefixes</span>
                    <div className="exec-allowlist">
                      {exec.allowlist.map((prefix) => (
                        <span key={prefix} className="pill">
                          {prefix}
                          <button
                            title={`Remove "${prefix}"`}
                            aria-label={`Remove "${prefix}" from the allowlist`}
                            disabled={execSaving}
                            onClick={() => updateExec({ allowlist: exec.allowlist.filter((p) => p !== prefix) })}
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                {allowRegex.length > 0 && (
                  <div className="exec-rule-group">
                    <span className="set-sub">Regex</span>
                    <div className="exec-allowlist">
                      {allowRegex.map((source) => (
                        <span key={source} className="pill">
                          <span className="exec-rule-type">Regex</span>
                          {source}
                          <button
                            title={`Remove regex "${source}"`}
                            aria-label={`Remove regex "${source}" from the allowlist`}
                            disabled={execSaving}
                            onClick={() => updateExec({ allowRegex: allowRegex.filter((p) => p !== source) })}
                          >
                            <X size={11} />
                          </button>
                        </span>
                      ))}
                    </div>
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
                  className="exec-rule-form"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const value = allowInput.trim();
                    if (!value) return;
                    if (allowKind === 'regex') {
                      const error = commandRegexError(value);
                      if (error) {
                        setAllowError(error);
                        return;
                      }
                      if (allowRegex.length >= MAX_COMMAND_ALLOW_RULES) {
                        setAllowError('Remove a regex rule before adding another.');
                        return;
                      }
                      if (allowRegex.includes(value)) return;
                      if (!(await updateExec({ allowRegex: [...allowRegex, value] }))) return;
                    } else {
                      if (value.length > MAX_COMMAND_PREFIX_LENGTH) {
                        setAllowError(`Prefixes must be ${MAX_COMMAND_PREFIX_LENGTH} characters or fewer.`);
                        return;
                      }
                      if (exec.allowlist.length >= MAX_COMMAND_ALLOW_RULES) {
                        setAllowError('Remove a prefix rule before adding another.');
                        return;
                      }
                      if (exec.allowlist.includes(value)) return;
                      if (!(await updateExec({ allowlist: [...exec.allowlist, value] }))) return;
                    }
                    setAllowInput('');
                    setAllowError('');
                  }}
                >
                  <select
                    className="ifield exec-rule-kind"
                    aria-label="Always-allowed command rule type"
                    disabled={execSaving}
                    value={allowKind}
                    onChange={(e) => {
                      setAllowKind(e.target.value as 'prefix' | 'regex');
                      setAllowInput('');
                      setAllowError('');
                    }}
                  >
                    <option value="prefix">Prefix</option>
                    {regexSupported && <option value="regex">Regex</option>}
                  </select>
                  <input
                    className="ifield"
                    type="text"
                    placeholder={
                      allowKind === 'prefix'
                        ? 'Add a prefix, e.g. git push'
                        : 'Add a regex, matched against the whole command segment'
                    }
                    aria-label={`Add an allowlisted command ${allowKind}`}
                    disabled={execSaving}
                    value={allowInput}
                    onChange={(e) => {
                      setAllowInput(e.target.value);
                      if (allowError) setAllowError('');
                    }}
                  />
                  {allowError && <em className="exec-rule-error">{allowError}</em>}
                  {!regexSupported && (
                    <em className="exec-rule-error">Regex rules require an updated Stem server.</em>
                  )}
                </form>
              </DisclosureRow>
            )}
          </>
        )}

        {exec?.enabled && (
          <>
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

      {/* Coding agents: which persona may drive one, on which computer and in
          which folder, is that persona's setup under Manage → Personas. Here:
          whether chats with NO persona get one (server-wide, ChatCodingRows),
          and THIS computer's consent to run agents the server sends it —
          offered when the server is elsewhere, for the exec-host reason: on a
          local install the server machine is the only one there is.
          Client-local state, never on the wire. */}
      <div className="grp-head">Coding agents</div>
      <div className="group">
        <ChatCodingRows devices={devices} remote={remote} clientDeviceId={clientDeviceId} />
        {remote && harnessHostEnabled !== null && (
          <ValueRow
            label={<strong>Run coding agents on this computer</strong>}
            hint={
              <>
                Let your Stem server drive a coding agent installed here{' '}
                <InfoTip label="What switching this on means">
                  With this on, a persona pinned to this computer in Manage → Personas — or a chat,
                  when “Allow in chats” above sends it here — can run a coding agent (Claude Code,
                  OpenCode) on this machine, with its own logins and files. Its
                  commands follow the server's approval mode — safe ones run, flagged ones pause on
                  a card. Switching this off stops new runs immediately. Leave it off if this Stem
                  server isn't yours alone.
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
                  .then((s) => {
                    setHarnessHostEnabled(s.enabled);
                    refreshDevices();
                  })
              }
            />
          </ValueRow>
        )}
      </div>

      {/* Computer control: whether chats with no persona may drive a Mac
          (server-wide, ChatComputerRows), and whether THIS Mac lets Stem see the
          screen and move the mouse and keyboard. Same shape as the coding-agent
          consent above — offered when the server is elsewhere, client-local
          state, never on the wire — plus the three macOS grants the helper
          needs, requested from here because the prompts appear on this display. */}
      <div className="grp-head">Computer control</div>
      <div className="group">
        <ChatComputerRows devices={devices} clientDeviceId={clientDeviceId} />
        {remote && computerHost?.supported && (
          <>
            <ValueRow
              label={<strong>Let Stem control this Mac</strong>}
              hint={
                <>
                  Stem can see the screen and drive the mouse and keyboard here{' '}
                  <InfoTip label="What switching this on means">
                    A persona pinned to this Mac in Manage → Personas — or a chat, when “Allow in chats”
                    above sends it here — gets a <code>computer</code> tool:
                    it takes screenshots, clicks and types here, with no per-action approval. While it
                    works a banner says so. Driving the whole screen, any key or mouse movement of your
                    own stops the run at once; working inside one app’s window (which it can do even
                    when that window is on another Space or behind others), it leaves your mouse and
                    keyboard alone and the banner’s Stop button ends it. Switching this off stops new
                    runs immediately. Leave it off if this Stem server isn’t yours alone. Needs macOS 14
                    or newer.
                  </InfoTip>
                </>
              }
            >
              <button
                className={`switch${computerHost.enabled ? ' on' : ''}`}
                role="switch"
                aria-checked={computerHost.enabled}
                aria-label="Let Stem control this Mac"
                onClick={() =>
                  void window.stem.setComputerHostEnabled(!computerHost.enabled).then((s) => {
                    setComputerHost(s);
                    refreshDevices();
                  })
                }
              />
            </ValueRow>
            {computerHost.enabled && (
              <ValueRow
                label={
                  <>
                    macOS permissions{' '}
                    <InfoTip label="About these permissions">
                      Screen Recording lets Stem take screenshots, Accessibility lets it click and type,
                      Input Monitoring lets it notice your own input and stop. macOS asks once per grant;
                      a refused one is changed under System Settings → Privacy &amp; Security. This list
                      re-checks itself whenever you come back to this window.
                    </InfoTip>
                  </>
                }
                hint={
                  <span className="perm-list" role="list">
                    {(
                      [
                        ['Screen Recording', computerHost.access?.screen, 'screenshots'],
                        ['Accessibility', computerHost.access?.accessibility, 'clicking and typing'],
                        ['Input Monitoring', computerHost.access?.inputMonitoring, 'stopping on your own input']
                      ] as [string, boolean | undefined, string][]
                    ).map(([name, granted, does]) => (
                      <span key={name} role="listitem" className={`perm${granted ? ' ok' : ' missing'}`}>
                        {granted ? (
                          <Check size={12} strokeWidth={3} aria-label="granted" />
                        ) : (
                          <X size={12} strokeWidth={3} aria-label="not granted" />
                        )}
                        <span>
                          {name}
                          {granted ? '' : ` — needed for ${does}`}
                        </span>
                      </span>
                    ))}
                  </span>
                }
              >
                <button
                  className="btn sm"
                  onClick={() => void window.stem.requestComputerAccess().then(setComputerHost)}
                >
                  {computerHost.access?.screen &&
                  computerHost.access?.accessibility &&
                  computerHost.access?.inputMonitoring
                    ? 'Re-check'
                    : 'Grant…'}
                </button>
              </ValueRow>
            )}
          </>
        )}
      </div>
    </>
  );
}
