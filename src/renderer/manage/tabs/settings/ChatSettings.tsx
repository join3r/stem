import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type {
  ChatsSettings,
  CustomInstructionsSettings,
  DeviceInfo,
  ExecSettings,
  ScratchUsageRow,
  WebSearchSettings,
  WindowsShell
} from '../../../../shared/types';
import { InfoTip } from '../../../ui/InfoTip';
import { ModelPicker } from '../../../ui/ModelPicker';
import { broadcastWebSearch, useWebSearchSync } from '../../../webSearch';
import { useRemoteServer } from '../../../hooks/useRemoteServer';
import type { ModelTabProps } from '../shared';

/** How long a chat's scratch folder survives being ignored. null = never sweep. */
const SCRATCH_TTLS: { label: string; days: number | null }[] = [
  { label: '7 days', days: 7 },
  { label: '30 days', days: 30 },
  { label: '90 days', days: 90 },
  { label: 'Never', days: null }
];

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
 * Settings → Chat: everything that shapes an ordinary conversation — which model
 * answers, how chats get named, the instructions carried into every turn, and
 * what the assistant is allowed to run while it works.
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
  const [allowInput, setAllowInput] = useState('');
  const [detectedBash, setDetectedBash] = useState<string | null>(null);
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
      setBashPathDraft(s.exec.gitBashPath ?? '');
    });
    // Its own request: a disk walk should not hold up the settings the rest of
    // this tab is made of.
    void window.stem.getScratchUsage().then(setScratch).catch(() => setScratch([]));
    if (window.stem.platform === 'win32') {
      void window.stem.detectGitBash().then(setDetectedBash).catch(() => setDetectedBash(null));
    }
    void window.stem.execHostState().then((s) => setExecHostEnabled(s.enabled)).catch(() => undefined);
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

  async function chooseWindowsShell(next: WindowsShell) {
    if (!exec) return;
    if (next === 'cmd') {
      setBashPathError('');
      updateExec({ windowsShell: 'cmd' });
      return;
    }
    const path = (bashPathDraft.trim() || exec.gitBashPath || detectedBash || '').trim();
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
    bashPathTimer.current = setTimeout(() => {
      const trimmed = value.trim();
      if (!trimmed) {
        // Empty path keeps Git Bash selected; spawn auto-detects or falls back to cmd.
        updateExec({ gitBashPath: null });
        return;
      }
      updateExec({
        gitBashPath: trimmed,
        windowsShell: exec?.windowsShell === 'git-bash' ? 'git-bash' : exec?.windowsShell
      });
    }, 400);
  }

  async function browseGitBash() {
    const files = await window.stem.openFiles();
    const picked = files[0];
    if (!picked) return;
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

  return (
    <div>
      <div className="grp-head">Model</div>
      <div className="formgroup">
        {models.length === 0 ? (
          <p className="muted">Loading models…</p>
        ) : (
          <>
            <ModelPicker
              models={models}
              value={modelId}
              onChange={(id) => onSelectModel(id ?? '')}
              ariaLabel="Model"
            />
            <label className="set-check" title="Search the live web for current info, with citations">
              <input type="checkbox" checked={ws.main} onChange={(e) => updateWebSearch({ main: e.target.checked })} />
              Web search
            </label>
          </>
        )}
      </div>

      <div className="grp-head">Chats</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Subjects{' '}
            <InfoTip label="About chat subjects">
              Stem writes each chat a short subject the way an email names a thread — once its
              first reply has landed, then now and then as the chat grows, so one that wanders onto
              another topic stops carrying the name it opened with. <strong>Everywhere</strong>
              uses it as the chat's name, so the list, search and the window title all agree.{' '}
              <strong>Inbox only</strong> shows it in the Inbox and leaves names alone.{' '}
              <strong>Off</strong> never calls a model — a chat is named after the first line you
              typed. A name you type yourself is never overwritten. The model that writes them
              lives under Models.
            </InfoTip>
          </span>
          <div className="seg-ctl">
            <button
              className={chats?.subjects === 'off' ? 'active' : ''}
              onClick={() => updateChats({ subjects: 'off' })}
              title="Never write subjects"
            >
              Off
            </button>
            <button
              className={chats?.subjects === 'inbox' ? 'active' : ''}
              onClick={() => updateChats({ subjects: 'inbox' })}
              title="Write subjects, but don't rename chats"
            >
              Inbox only
            </button>
            <button
              className={chats?.subjects === 'everywhere' ? 'active' : ''}
              onClick={() => updateChats({ subjects: 'everywhere' })}
              title="Use the subject as the chat's name"
            >
              Everywhere
            </button>
          </div>
        </div>
        <div className="set-block">
          <span className="set-sub">
            Preview lines in the Inbox{' '}
            <InfoTip label="About preview lines">
              How much of the newest message each Inbox row shows underneath its subject. The Chats
              tree is unaffected — it stays one line per chat.
            </InfoTip>
          </span>
          <div className="seg-ctl">
            <button
              className={chats?.previewLines === 0 ? 'active' : ''}
              onClick={() => updateChats({ previewLines: 0 })}
            >
              None
            </button>
            <button
              className={chats?.previewLines === 1 ? 'active' : ''}
              onClick={() => updateChats({ previewLines: 1 })}
            >
              1 line
            </button>
            <button
              className={chats?.previewLines === 2 ? 'active' : ''}
              onClick={() => updateChats({ previewLines: 2 })}
            >
              2 lines
            </button>
          </div>
        </div>
      </div>

      <div className="grp-head">Custom instructions</div>
      <div className="formgroup">
        <div className="set-block">
          <span className="set-sub">
            Standing instructions{' '}
            <InfoTip label="About standing instructions">
              High-priority directives Stem follows in every reply — in the main app and in Quick
              Chat. Stem can also update these itself when you ask it to.
            </InfoTip>
          </span>
          <textarea
            className="ci-textarea"
            value={ci.main}
            onChange={(e) => saveCiMain(e.target.value)}
            rows={5}
            placeholder="e.g. Reply briefly and to the point. Use plain Markdown unless I ask for components."
          />
        </div>
      </div>

      <div className="grp-head">Command execution</div>
      <div className="formgroup">
        <div className="set-row">
          <span className="set-label">
            <strong>Run commands</strong>
            <em>
              Let Stem run shell commands (CLIs, git, agent-browser){' '}
              <InfoTip label="How command approval works">
                What runs on its own is governed by the approval mode below — from manual (you
                approve everything unlisted) to yolo (everything runs). Folders you marked
                read-only are always protected.
              </InfoTip>
            </em>
          </span>
          <button
            className={`switch${exec?.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={exec?.enabled ?? false}
            aria-label="Run commands"
            onClick={() => exec && updateExec({ enabled: !exec.enabled })}
          />
        </div>

        {exec?.enabled && (
          <>
            {window.stem.platform === 'win32' && (
              <div className="set-block">
                <span className="set-sub">
                  Windows shell{' '}
                  <InfoTip label="About the Windows shell">
                    Commands run in Git Bash when bash.exe is on disk, and fall back to Command
                    Prompt (cmd.exe) if it is not. Stem looks for Git for Windows in the usual
                    places (no PowerShell). If it is installed somewhere unusual, paste the path.
                    Switching shells changes which commands auto-run (dir vs ls) and how quotes
                    work.
                  </InfoTip>
                </span>
                <div className="seg-ctl">
                  <button
                    className={exec.windowsShell !== 'git-bash' ? 'active' : ''}
                    onClick={() => void chooseWindowsShell('cmd')}
                  >
                    Command Prompt
                  </button>
                  <button
                    className={exec.windowsShell === 'git-bash' ? 'active' : ''}
                    onClick={() => void chooseWindowsShell('git-bash')}
                  >
                    Git Bash
                  </button>
                </div>
                {(exec.windowsShell === 'git-bash' || bashPathError) && (
                  <>
                    <div className="exec-bash-path">
                      <input
                        className="ifield"
                        type="text"
                        placeholder={detectedBash || 'C:\\Program Files\\Git\\bin\\bash.exe'}
                        aria-label="Path to Git Bash bash.exe"
                        value={bashPathDraft}
                        onChange={(e) => saveGitBashPath(e.target.value)}
                      />
                      <button type="button" className="link-btn" onClick={() => void browseGitBash()}>
                        Browse
                      </button>
                    </div>
                    {bashPathError && <em className="scratch-empty">{bashPathError}</em>}
                  </>
                )}
              </div>
            )}
            <div className="set-block">
              <span className="set-sub">
                Approval mode{' '}
                <InfoTip label="About approval modes">
                  <strong>Manual</strong> — only allowlisted commands run on their own; everything
                  else pauses for your approval. <strong>Assisted</strong> — an AI safety check
                  clears commands that serve your request; only flagged ones pause.{' '}
                  <strong>Yolo</strong> — every command runs immediately, no questions asked (folders
                  you marked read-only stay protected). The safety check is a heuristic, not a
                  security boundary; the model it runs on lives under Models.
                </InfoTip>
              </span>
              <div className="seg-ctl">
                <button
                  className={exec.approvalMode === 'manual' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'manual' })}
                >
                  Manual
                </button>
                <button
                  className={exec.approvalMode === 'assisted' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'assisted' })}
                >
                  Assisted
                </button>
                <button
                  className={exec.approvalMode === 'yolo' ? 'active' : ''}
                  onClick={() => updateExec({ approvalMode: 'yolo' })}
                  title="Every command runs immediately — use with care"
                >
                  Yolo
                </button>
              </div>
            </div>


            {exec.approvalMode !== 'yolo' && (
              <div className="set-block">
                <span className="set-sub">
                  Always-allowed commands{' '}
                  <InfoTip label="About the allowlist">
                    Command prefixes that run without the safety check — grown by the approval card's
                    "Always allow" button or added here (e.g. <code>git push</code> or <code>npm</code>).
                  </InfoTip>
                </span>
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
              </div>
            )}

            <div className="set-block">
              <span className="set-sub">
                Scratch files{' '}
                <InfoTip label="About scratch files">
                  Commands run in a folder of their own per chat, so downloads, scripts and build
                  output stay with the conversation that made them. Deleting a chat deletes its
                  folder. A folder is cleared once nothing in it — and nothing in the chat — has
                  been touched for the chosen time; anything you want kept belongs in your Files.
                </InfoTip>
              </span>
              <div className="seg-ctl">
                {SCRATCH_TTLS.map((opt) => (
                  <button
                    key={opt.label}
                    className={exec.scratchTtlDays === opt.days ? 'active' : ''}
                    onClick={() => updateExec({ scratchTtlDays: opt.days })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
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
            </div>
          </>
        )}

        {/* THIS computer's consent to run commands the server sends it. Only
            offered when the server is elsewhere — on a local install the switch
            above already governs the only machine there is. The state is
            client-local (see desktop/exec-host/store.ts) and never on the
            wire, which is why this block does not read `exec`. */}
        {remote && execHostEnabled !== null && (
          <div className="set-row">
            <span className="set-label">
              <strong>Run commands on this computer</strong>
              <em>
                Let your Stem server run commands here — for the things only this machine has{' '}
                <InfoTip label="What switching this on means">
                  With this on, the assistant can target this computer by name and commands run
                  here after the same approval policy as everywhere else — but nothing on this
                  machine is pre-approved: every command prefix is judged or asks you until you
                  choose "Always allow" for it. Switching this off stops new commands
                  immediately. Leave it off if this Stem server isn't yours alone.
                </InfoTip>
              </em>
            </span>
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
          </div>
        )}
      </div>
    </div>
  );
}
