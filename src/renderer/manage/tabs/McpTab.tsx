import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Braces,
  ChevronRight,
  Globe,
  Loader,
  LogIn,
  PlugZap,
  ShieldCheck,
  ShieldOff,
  Terminal,
  Trash2
} from 'lucide-react';
import type {
  BackendEventEnvelope,
  DeviceInfo,
  McpHostLocalState,
  McpHostPendingServer,
  McpHostServerStatus,
  McpHostSpecPreview,
  McpLoginUrlParams,
  McpServerInput,
  McpServerStatus,
  McpServerSummary,
  McpTransport,
  ModelSummary
} from '../../../shared/types';
import { MCP_SECRET_MASK } from '../../../shared/types';
import { InfoTip } from '../../ui/InfoTip';
import { SkillsTab } from './SkillsTab';
import { useRememberedTab } from '../../hooks/useRememberedTab';
import { useRemoteServer } from '../../hooks/useRemoteServer';
import {
  AttentionBar,
  Chip,
  ConfirmDelete,
  DetailFooter,
  DetailHeader,
  DetailIdent,
  DetailTabs,
  Field,
  Glyph,
  ListGroup,
  ListHeader,
  ListRow,
  ListSearch
} from '../ListDetail';
import { parseMcpPaste, type PastedServer } from '../mcpPaste';

const SUBS = ['mcp', 'skills'] as const;

/**
 * Why a URL server pinned to one of your computers has no Sign in button.
 *
 * Not an oversight and not a shortcut. OAuth discovery and dynamic client
 * registration are HTTP calls to the server's own address, and sign-in runs on
 * the machine holding your Stem server — which, for `http://homeassistant.local`,
 * has no route to it at all. The half that could work (the browser leg) is not
 * the half that decides. A static token in an `Authorization:` header travels
 * with the spec and works today, so that is what the row offers instead of a
 * button that would fail in a way nobody could read.
 */
const NO_OAUTH_ELSEWHERE =
  'Signing in with OAuth is not available for a server pinned to one of your computers: the sign-in runs where your ' +
  'Stem server runs, and it cannot reach an address on your home network. Use a static token instead — add an ' +
  '“Authorization: Bearer …” header to the entry.';

// Combined panel: MCP servers and Skills live under the same icon as two sub-tabs.
export function McpSkillsTab({ models }: { models: ModelSummary[] }) {
  const [sub, setSub] = useRememberedTab('stem.tools.sub', SUBS, 'mcp');
  return (
    <div>
      <div className="seg-ctl">
        <button className={sub === 'mcp' ? 'active' : ''} onClick={() => setSub('mcp')}>
          MCP servers
        </button>
        <button className={sub === 'skills' ? 'active' : ''} onClick={() => setSub('skills')}>
          Skills
        </button>
      </div>
      {sub === 'mcp' ? <McpTab /> : <SkillsTab models={models} />}
    </div>
  );
}

// ---- MCP servers tab: the rows the assistant's outside tools come from ----
//
// The same shape as the Personas tab: a row is a name, its address and a status
// word, and opening it replaces the list with the server's editor (Connection /
// Runs on / Status), edited as a local draft and written on Save. Where a server runs is a field
// in that editor like any other — the old panel offered it as a row of "Move
// to …" text links under the selected row, beside "Edit…", "Test connection"
// and three paragraphs behind ⓘ buttons, which read as a different application
// from the tab one segment to the right. A new server — typed, or filled in from
// a pasted README block — is a draft that exists nowhere but this screen until Save.

type EditorTab = 'connection' | 'where' | 'status';

/** Everything the editor can change about one server, as the form holds it. */
interface Draft {
  name: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  /** Environment (`KEY=value`) for a command, headers (`Key: value`) for a URL — one per line. */
  text: string;
  oauthClientId: string;
  oauthClientSecret: string;
  oauthScope: string;
  /** Device id it is pinned to; '' = the machine hosting the Stem server. */
  location: string;
}

interface Editing {
  /** What the server looked like when the editor opened — Save is offered against this. */
  base: Draft;
  draft: Draft;
  /** A row that exists only on this screen until Save. */
  isNew: boolean;
}

function blankDraft(transport: McpTransport): Draft {
  return {
    name: '',
    transport,
    command: '',
    args: '',
    url: '',
    text: '',
    oauthClientId: '',
    oauthClientSecret: '',
    oauthScope: '',
    location: ''
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k]);
}

// Parse the env textarea ("KEY=value" per line) into a map; blank/`#` lines skipped.
function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

// Parse the headers textarea ("Key: value" or "Key=value" per line).
function parseHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.search(/[:=]/);
    if (i <= 0) continue;
    headers[trimmed.slice(0, i).trim()] = trimmed.slice(i + 1).trim();
  }
  return headers;
}

/** The IPC input a draft saves as. Location rides along only for an add; an update moves separately. */
function inputOf(d: Draft, isNew: boolean): McpServerInput {
  const headers = d.transport === 'http' ? parseHeaders(d.text) : {};
  const env = d.transport === 'http' ? {} : parseEnv(d.text);
  return {
    name: d.name.trim(),
    transport: d.transport,
    command: d.command.trim(),
    args: d.args.trim() ? d.args.trim().split(/\s+/) : [],
    url: d.url.trim(),
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(d.transport === 'http' && d.oauthClientId.trim() ? { oauthClientId: d.oauthClientId.trim() } : {}),
    ...(d.transport === 'http' && d.oauthClientSecret.trim() ? { oauthClientSecret: d.oauthClientSecret.trim() } : {}),
    ...(d.transport === 'http' && d.oauthScope.trim() ? { oauthScope: d.oauthScope.trim() } : {}),
    // Sent only when a device was picked: an absent location is what "runs
    // where the server runs" has always looked like on disk.
    ...(isNew && d.location ? { location: { deviceId: d.location } } : {})
  };
}

function McpTab() {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  // Open editors, keyed by server name — or by a fresh id for a server that is
  // not saved yet. A draft survives a collapse (the row says "unsaved").
  const [editing, setEditing] = useState<Map<string, Editing>>(new Map());
  // The server whose editor replaces the list (null = the list), and its tab.
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [tab, setTab] = useState<EditorTab>('connection');
  const [query, setQuery] = useState('');
  // The Paste JSON box: null = closed.
  const [pasteText, setPasteText] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  // Which URL editors show the OAuth client fields — three inputs almost nobody
  // fills, kept behind a disclosure so an edit of a URL is a URL.
  const [oauthOpen, setOauthOpen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loginName, setLoginName] = useState<string | null>(null);
  const [loginUrl, setLoginUrl] = useState<McpLoginUrlParams | null>(null);
  // Live per-server connection status from the running app-server. This is the
  // source of truth for whether a remote server actually works — `authStatus`
  // only says whether OAuth creds exist on disk, which stays 'o_auth' even when
  // the token is rejected at connect time and the server exposes no tools.
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>({});
  const [hosts, setHosts] = useState<DeviceInfo[]>([]);
  const [thisDeviceId, setThisDeviceId] = useState<string | null>(null);
  const remote = useRemoteServer();
  // What THIS computer hosts, says about it, and is waiting to be told. Asked of
  // the desktop and never of the server (see desktop/local/index.ts), so it
  // answers on an install of any age with a server anywhere — including one
  // whose other clients are phones, which host nothing and are never asked to.
  const [hostState, setHostState] = useState<McpHostLocalState>({ approved: {}, pending: [], status: {} });
  const [testing, setTesting] = useState<string | null>(null);

  async function refresh() {
    const [list, status] = await Promise.all([
      window.stem.listMcpServers(),
      window.stem.getMcpStatus()
    ]);
    setServers(list);
    setStatuses(status);
  }

  useEffect(() => {
    refresh();
    // The assistant can add/remove servers itself; refresh the list when it does
    // — and so can this computer's own host, because what it was asked to run
    // may be exactly what changed. The server tells the hosting machine on its
    // own (see writeServers in server/pi/mcp.ts); this is the open panel
    // catching up, which is a different question with a different answer.
    const offChanged = window.stem.onMcpChanged(() => {
      void refresh();
      void window.stem.refreshMcpHost().then(setHostState).catch(() => undefined);
    });
    // Live connection-status updates (e.g. a server goes ready/failed).
    const offStatus = window.stem.onMcpStatus((s) => setStatuses(s));
    return () => {
      offChanged();
      offStatus();
    };
  }, []);

  // Servers pinned to a device that is no longer paired. They cannot run
  // anywhere, and they are the one case a window with a LOCAL server still has
  // to be able to fix — an orphan outlives the move that made it.
  const orphans = servers.filter((s) => s.location?.orphaned);
  // Any pin at all, sound or broken. A local install can hold one — an import,
  // or a pin that outlived the move back — and its owner must be able to undo it
  // without standing up a server again, so the device list is worth asking for.
  const anyPinned = servers.some((s) => s.location);

  // The devices that could host a server: paired desktops only, because a phone
  // sleeps and a server on it would be unreachable half the time. Read only when
  // there is a choice to make — a window whose server is this very machine and
  // holds nothing pinned never renders a picker, so it never asks.
  useEffect(() => {
    if (!remote && !anyPinned) return;
    void window.stem
      .listDevices()
      .then((snapshot) => setHosts(snapshot.devices.filter((d) => d.kind === 'desktop')))
      .catch(() => undefined);
  }, [remote, anyPinned]);

  // Which device this window is, asked unconditionally: a server can be pinned
  // to this machine on an install that has never been remote (an import, or a
  // pin made before the server moved), and "is this one mine" is the question
  // every host affordance below hangs off.
  useEffect(() => {
    void window.stem
      .clientInfo()
      .then((info) => setThisDeviceId(info.deviceId))
      .catch(() => undefined);
    void window.stem.mcpHostState().then(setHostState).catch(() => undefined);
    // The host settles servers on its own schedule — a handshake finishing, a
    // child dying — so the panel is told rather than polling for it.
    return window.stem.onMcpHostChanged(setHostState);
  }, []);

  // The OAuth authorize URL is streamed mid-login as a fallback link.
  useEffect(() => {
    return window.stem.onBackendEvent((event: BackendEventEnvelope) => {
      if (event.method === 'mcp/login/url') setLoginUrl(event.params as McpLoginUrlParams);
    });
  }, []);

  // Apply config/token changes to the live session without an app restart.
  async function reconnect() {
    setBusy('Reconnecting…');
    try {
      await window.stem.restartRuntime();
    } finally {
      setBusy(null);
    }
  }

  /**
   * Everything that has to catch up after mcp.json changed, in the order it has
   * to happen: the host on THIS computer first, then the bridge.
   *
   * Both, always, and not because every edit touches both. A pin is invisible in
   * the shape of an edit — adding a server pinned here, disabling one that runs
   * here, deleting one whose child is running here are, from this function's
   * side, an add, a toggle and a delete like any other. Asking only the bridge
   * would mean a server pinned to this machine sat there doing nothing (its
   * approval never offered) until the next launch, and a disabled or deleted one
   * kept its child alive over here just as long. The host answers from state it
   * already has, so the cost of asking when nothing changed is a function call.
   *
   * It covers this window and only this window, which is why it is not the
   * mechanism. The machine that runs a pinned server is usually NOT the one
   * whose panel is open — that is the entire point of pinning — and an edit can
   * arrive from a phone, a second desktop, or the assistant, none of which are
   * here. Telling the hosting machine is done at the writer instead
   * (writeServers in src/server/pi/mcp.ts); this stays because it makes the
   * window that made the edit correct immediately rather than a round-trip
   * later, and because the bridge still has to be restarted from somewhere.
   */
  async function applyMcpChange() {
    setHostState(await window.stem.refreshMcpHost().catch(() => hostState));
    await reconnect();
  }

  const setDraft = (key: string, draft: Draft) =>
    setEditing((cur) => {
      const entry = cur.get(key);
      return entry ? new Map(cur).set(key, { ...entry, draft }) : cur;
    });

  const dropEditing = (key: string) =>
    setEditing((cur) => {
      const next = new Map(cur);
      next.delete(key);
      return next;
    });

  /**
   * Open a server's editor in place of the list. Opening fetches the stored
   * server — secrets arrive as MCP_SECRET_MASK and go back the same way unless
   * retyped, so changing the URL beside a token no longer means finding the
   * token again. A dirty draft from an earlier visit is kept as it was.
   */
  async function open(s: McpServerSummary, at?: EditorTab) {
    const key = s.name;
    if (!editing.has(key)) {
      setError(null);
      try {
        const d = await window.stem.getMcpServer(key);
        const lines = d.transport === 'http' ? d.headers : d.env;
        const base: Draft = {
          name: d.name,
          transport: d.transport,
          command: d.command,
          args: d.args.join(' '),
          url: d.url,
          text: Object.entries(lines)
            .map(([k, v]) => (d.transport === 'http' ? `${k}: ${v}` : `${k}=${v}`))
            .join('\n'),
          oauthClientId: d.oauthClientId,
          oauthClientSecret: d.oauthClientSecret,
          oauthScope: d.oauthScope,
          location: s.location?.deviceId ?? ''
        };
        setEditing((cur) => new Map(cur).set(key, { base, draft: { ...base }, isNew: false }));
        if (d.oauthClientId) setOauthOpen((cur) => new Set(cur).add(key));
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
        return;
      }
    }
    setTab(at ?? 'connection');
    setOpenKey(key);
  }

  /** Back to the list. A clean draft is thrown away; a dirty one waits ("unsaved"). */
  function back() {
    if (openKey) {
      const entry = editing.get(openKey);
      if (entry && !entry.isNew && sameDraft(entry.draft, entry.base)) dropEditing(openKey);
    }
    setOpenKey(null);
    setPasteText(null);
    setError(null);
  }

  /** A new server — blank, or one per entry a paste held — on the server only after Save. */
  function add(transport: McpTransport, pasted: PastedServer[] = []) {
    const drafts: Draft[] =
      pasted.length > 0
        ? pasted.map((p) => ({
            ...blankDraft(p.transport),
            name: p.name,
            command: p.command,
            args: p.args.join(' '),
            url: p.url,
            text:
              p.transport === 'http'
                ? Object.entries(p.headers).map(([k, v]) => `${k}: ${v}`).join('\n')
                : Object.entries(p.env).map(([k, v]) => `${k}=${v}`).join('\n')
          }))
        : [blankDraft(transport)];
    const keys = drafts.map(() => `new:${crypto.randomUUID()}`);
    setEditing((cur) => {
      const next = new Map(cur);
      // The base is blank, so a pasted draft counts as a change and Save is live.
      drafts.forEach((draft, i) => next.set(keys[i], { base: blankDraft(draft.transport), draft, isNew: true }));
      return next;
    });
    setPasteText(null);
    setTab('connection');
    setOpenKey(keys[0]);
  }

  async function save(key: string) {
    const entry = editing.get(key);
    if (!entry) return;
    const d = entry.draft;
    setError(null);
    setSavingKey(key);
    try {
      const input = inputOf(d, entry.isNew);
      // An update keeps the stored location and enabled state itself, and turns
      // every masked value back into the stored one — the form never held them.
      let list = entry.isNew ? await window.stem.addMcpServer(input) : await window.stem.updateMcpServer(input);
      if (!entry.isNew && d.location !== entry.base.location) {
        list = await window.stem.setMcpServerLocation(input.name, d.location || null);
      }
      setServers(list);
      dropEditing(key);
      setOpenKey(null);
      await applyMcpChange();
      // Stay on the server just saved, re-read so masked secrets are masks again.
      const saved = list.find((x) => x.name === input.name);
      if (saved) await open(saved, tab);
    } catch (e) {
      // A refused save keeps the draft on screen so it can be fixed — nothing was lost.
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSavingKey(null);
    }
  }

  /** Discard the draft and return to the list; a never-saved server disappears with it. */
  function cancel(key: string) {
    dropEditing(key);
    setOpenKey(null);
    setError(null);
  }

  /** Removing also deletes its sign-in; the header switch is "stop using it, keep it". Confirmed in place. */
  async function remove(s: McpServerSummary) {
    setError(null);
    try {
      setServers(await window.stem.removeMcpServer(s.name));
      cancel(s.name);
      setStatuses((prev) => {
        const next = { ...prev };
        delete next[s.name];
        return next;
      });
      await applyMcpChange();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  // Toggle a server on/off without removing it. Neither the bridge nor a hosting
  // machine re-reads mcp.json on its own, so both are told — see applyMcpChange.
  async function toggleEnabled(serverName: string, enabled: boolean) {
    setError(null);
    setServers(await window.stem.setMcpServerEnabled(serverName, enabled));
    await applyMcpChange();
  }

  async function signIn(serverName: string) {
    setError(null);
    setLoginName(serverName);
    setLoginUrl(null);
    try {
      const result = await window.stem.loginMcpServer(serverName);
      if (result.ok) {
        // reconnect() respawns the app-server, which clears stale statuses and
        // re-emits fresh ones; refresh() then pulls the new snapshot.
        await reconnect();
        await refresh();
      } else {
        setError(result.error ?? 'Sign in failed.');
      }
    } finally {
      setLoginName(null);
      setLoginUrl(null);
    }
  }

  /**
   * How one server is doing — ONE ladder for every row, which is the point of it.
   *
   * A server pinned to a computer is the same kind of thing as one the Stem
   * server connects itself; the only difference between them is which machine
   * opens the connection. Giving the two different vocabularies — a dot here, a
   * pill there, and for a local command nothing at all — made that look like a
   * difference in kind, which it is not.
   *
   * The SOURCES differ, because they have to. This machine knows its own servers
   * first-hand; the bridge reports the ones it connects itself; and a server on
   * another of your computers is known second-hand, as `elsewhere` — carrying a
   * sentence when that machine has something wrong to report and none when it
   * has not. What comes out is the same handful of words either way.
   */
  function serverState(
    s: McpServerSummary
  ): 'connected' | 'pending' | 'failed' | 'needs-login' | 'needs-approval' | 'unknown' {
    if (!s.enabled) return 'unknown';
    const live = statuses[s.name]?.status;
    if (hostedHere(s)) {
      const mine = hostState.status[s.name]?.status;
      if (mine === 'unapproved') return 'needs-approval';
      if (mine === 'ready') return 'connected';
      if (mine === 'starting') return 'pending';
      return mine === 'failed' ? 'failed' : 'unknown';
    }
    if (s.location) {
      if (live !== 'elsewhere') return 'unknown';
      return statuses[s.name]?.error ? 'failed' : 'connected';
    }
    if (live === 'ready') return 'connected';
    if (live === 'starting') return 'pending';
    // A URL server that dropped is nearly always a token that expired, so it is
    // offered the way a signed-out one is: as something to press, not to read.
    if (live === 'failed') return s.transport === 'http' ? 'needs-login' : 'failed';
    if (s.transport === 'http') {
      // Nothing reported yet — the panel can open before any thread has started
      // this session. Credentials on disk are the best guess available.
      return s.authStatus === 'o_auth' || s.authStatus === 'bearer_token' ? 'connected' : 'needs-login';
    }
    return 'unknown';
  }

  /** What the dot says on hover — the one place a state names its machine. */
  function stateTitle(s: McpServerSummary, state: ReturnType<typeof serverState>): string {
    const where = hostedHere(s) ? 'this computer' : s.location ? s.location.label : 'your Stem server';
    const reported = statuses[s.name]?.error ?? hostState.status[s.name]?.error;
    if (state === 'failed') return reported ?? `It is not running on ${where}.`;
    if (state === 'pending') return `Starting on ${where}…`;
    return `Running on ${where}.`;
  }

  /**
   * The list, cut into one section per machine.
   *
   * Where a server runs stopped being something written on its row and became
   * WHERE THE ROW SITS. Every version that put the place on the row bought its
   * visibility with width or a third line — a pill beside the name broke a
   * 300px panel's names across three lines, and a line under the address was so
   * quiet it read as a footnote to the command. A section header costs the row
   * neither, and it answers a question the flat list could not answer at all:
   * what does this machine run? It is also the honest shape of the thing —
   * these servers really do belong to machines, and a machine can be asleep,
   * unpaired or gone as a whole.
   *
   * Headers appear only when there is more than one place to name. With nothing
   * pinned anywhere the list has one section, and a header that appears once
   * distinguishes nothing, so it says "MCP servers" and stops.
   */
  function placeGroups(): { key: string; head: string; items: McpServerSummary[] }[] {
    if (!anyPinned) return [{ key: 'all', head: 'MCP servers', items: servers }];

    const groups: { key: string; head: string; items: McpServerSummary[] }[] = [];
    const push = (key: string, head: string, items: McpServerSummary[]) => {
      if (items.length > 0) groups.push({ key, head, items });
    };
    const unpinned = servers.filter((s) => !s.location);
    const here = servers.filter((s) => hostedHere(s));

    // On a local install the machine hosting the server IS this computer, so an
    // unpinned server and one pinned here are the same answer to "where does it
    // run" — two sections with identical headers would be a distinction only the
    // config file cares about.
    if (remote) {
      push('server', 'On your Stem server', unpinned);
      push('here', 'On this computer', here);
    } else {
      push('here', 'On this computer', [...unpinned, ...here]);
    }

    // One section per other machine, by device rather than by label: two paired
    // computers may honestly share a name, and merging them would claim a server
    // runs somewhere it does not.
    const others = new Map<string, { key: string; head: string; items: McpServerSummary[] }>();
    for (const s of servers) {
      if (!s.location || s.location.orphaned || hostedHere(s)) continue;
      const group = others.get(s.location.deviceId) ?? {
        key: `dev-${s.location.deviceId}`,
        head: `On ${s.location.label}`,
        items: []
      };
      group.items.push(s);
      others.set(s.location.deviceId, group);
    }
    groups.push(...[...others.values()].sort((a, b) => a.head.localeCompare(b.head)));

    // Last, and named for the consequence rather than the cause: what matters
    // about a pin to an unpaired computer is that the server runs nowhere.
    push('orphan', 'Nowhere — that computer is gone', orphans);
    return groups;
  }

  /**
   * Whether this very machine is the one that runs `s`. Everything below is
   * gated on it, and deliberately so: a server pinned to another device is that
   * device's business, and this window has nothing true to say about whether it
   * has been approved, is running, or can be tested. The row names the place and
   * stops there.
   */
  function hostedHere(s: McpServerSummary): boolean {
    return !!thisDeviceId && s.location?.deviceId === thisDeviceId;
  }

  /** What a spec would actually run, in one line. */
  function previewLine(preview: McpHostSpecPreview): string {
    if (preview.url) return preview.url;
    return [preview.command ?? '', ...(preview.args ?? [])].join(' ').trim();
  }

  /** The names of the credentials a spec carries; the values never leave main. */
  function credentialLine(preview: McpHostSpecPreview): string | null {
    const keys = [...(preview.envKeys ?? []), ...(preview.headerKeys ?? [])];
    if (keys.length === 0) return null;
    return `Carries ${keys.join(', ')} — Stem passes the values through without showing them here.`;
  }

  /** The card's headline: a new spec, an edited one, or one that lost a secret. */
  function pendingHeading(p: McpHostPendingServer): string {
    if (p.lostSecrets?.length) return `${p.name} lost a saved credential`;
    return p.changed ? `${p.name} changed — approve it again` : `Approve ${p.name} to run here`;
  }

  /** What to say when a credential could not be read, or null when all were. */
  function lostLine(p: McpHostPendingServer): string | null {
    const keys = p.lostSecrets ?? [];
    if (keys.length === 0) return null;
    return (
      `Stem could not read the saved value of ${keys.join(', ')} on the computer holding the configuration — ` +
      'it was lost, not changed (usually an import opened with a different passphrase). That is why this is being ' +
      'asked again. Approving starts the server without it; set the value again in this row first if it needs one.'
    );
  }

  /** A hosted server's state, in the words the editor uses. */
  function hostStateLine(status: McpHostServerStatus | undefined): string {
    if (!status) return 'Not started yet.';
    if (status.status === 'ready') {
      const n = status.tools ?? 0;
      return `Running on this computer — ${n} tool${n === 1 ? '' : 's'}.`;
    }
    if (status.status === 'starting') return 'Starting…';
    if (status.status === 'unapproved') return 'Waiting for your approval.';
    return status.error ?? 'It stopped, and did not say why.';
  }

  async function approveHosted(pending: McpHostPendingServer) {
    setError(null);
    try {
      setHostState(await window.stem.approveMcpHostServer(pending.name, pending.fingerprint));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  async function rejectHosted(serverName: string) {
    setError(null);
    try {
      setHostState(await window.stem.rejectMcpHostServer(serverName));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }

  // Connect now and say what happened. This is the only way to see the REAL
  // reason a spec is broken — a missing binary, a URL nothing answers on — and
  // it is why the answer is the whole fresh state rather than an ok/not-ok.
  async function testHosted(serverName: string) {
    setError(null);
    setTesting(serverName);
    try {
      setHostState(await window.stem.testMcpHostServer(serverName));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setTesting(null);
    }
  }

  /**
   * "Reconnect" when a token that worked has stopped working, "Sign in" when
   * there has never been one: the same act, and the word is only there to say
   * whether you have done it before.
   */
  function signInLabel(serverName: string): string {
    if (loginName === serverName) return 'Waiting…';
    return statuses[serverName]?.status === 'failed' ? 'Reconnect' : 'Sign in';
  }

  /**
   * The approval this computer owes a server pinned to it, at the top of that
   * server's editor. The list says it is waiting (the amber bar and the row's
   * chip), so the card no longer has to push every row below it down.
   */
  function approvalCard(p: McpHostPendingServer) {
    return (
      <div className="mcp-approval">
        <span className="set-sub">{pendingHeading(p)}</span>
        <code>{previewLine(p.preview)}</code>
        {credentialLine(p.preview) && <p className="muted">{credentialLine(p.preview)}</p>}
        {/* A lost credential and an edited one both move the fingerprint, and
            only one of them is somebody's doing. Saying "changed" to the second
            is true and useless: nobody changed it, and approving anyway starts a
            server without its key. */}
        {lostLine(p) && <p className="error">{lostLine(p)}</p>}
        {!lostLine(p) && p.changed && (
          <p className="muted">
            Its command, arguments or credentials are not the ones you approved. Stem stopped it and will not
            start it again until you say so.
          </p>
        )}
        {/* What the click authorizes has to be readable here — after it there
            are no further questions. Why it is asked at all goes behind the ⓘ. */}
        <p className="muted">
          Once approved, Stem uses its tools whenever the assistant asks — including on a scheduled run —
          without asking again.{' '}
          {!p.changed && !lostLine(p) && (
            <InfoTip label="Why approve it here?">
              Stem never starts a server on your own computer without being asked, even when the entry was
              added elsewhere — from your phone, from another computer, or by the assistant.
            </InfoTip>
          )}
        </p>
        {p.unbounded && <p className="error">{p.unbounded}</p>}
        <div className="push-row">
          <button className="primary" onClick={() => approveHosted(p)}>
            Approve and start
          </button>
        </div>
      </div>
    );
  }

  /** The "Runs on" choice: the Stem server, each paired computer, and — for an orphan — the computer that is gone. */
  function locationSelect(s: McpServerSummary | null, key: string, d: Draft) {
    const remembered = s?.location?.rememberedLabel;
    // A machine whose name matches the one the pin remembered comes first: pairing
    // mints a new device id, so re-pairing the same Mac orphans everything pinned
    // to it, and the fix is almost always "the computer with the same name". It is
    // offered, not applied — a label is not evidence.
    const offered = hosts
      .slice()
      .sort((a, b) => Number(b.label === remembered) - Number(a.label === remembered));
    return (
      <Field label="Runs on">
        <select
          className="vfield"
          aria-label="Computer this server runs on"
          value={d.location}
          onChange={(e) => setDraft(key, { ...d, location: e.target.value })}
        >
          <option value="">{remote ? 'On your Stem server' : 'On this computer'}</option>
          {s?.location?.orphaned && (
            <option value={s.location.deviceId}>
              On {s.location.label} (no longer paired)
            </option>
          )}
          {offered.map((h) => (
            <option key={h.id} value={h.id}>
              On {h.label}
              {h.id === thisDeviceId ? ' · this computer' : ''}
              {remembered && h.label === remembered && h.id !== thisDeviceId ? ' · the same name as before' : ''}
            </option>
          ))}
        </select>
        <p className="ld-hint">
          A server reaches the files, apps and network of the machine it runs on. Whoever is at that computer
          approves it there before it starts; a move never carries an approval across. Phones are not offered:
          they sleep.
        </p>
      </Field>
    );
  }

  /** The Connection tab: transport (new servers only), address, headers or environment, OAuth client. */
  function connectionTab(s: McpServerSummary | null, key: string, entry: Editing) {
    const d = entry.draft;
    const pinnedUrl = !!s?.location && d.transport === 'http' && !s.location.orphaned;
    const hasSecret = d.text.includes(MCP_SECRET_MASK) || d.oauthClientSecret === MCP_SECRET_MASK;
    const showOauth = oauthOpen.has(key);
    return (
      <>
        {entry.isNew && (
          <div className="seg-ctl ld-kind" role="radiogroup" aria-label="How Stem reaches it">
            <button
              type="button"
              role="radio"
              aria-checked={d.transport === 'http'}
              className={d.transport === 'http' ? 'active' : ''}
              onClick={() => setDraft(key, { ...d, transport: 'http' })}
            >
              <Globe size={13} /> URL
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={d.transport === 'stdio'}
              className={d.transport === 'stdio' ? 'active' : ''}
              onClick={() => setDraft(key, { ...d, transport: 'stdio' })}
            >
              <Terminal size={13} /> Command
            </button>
          </div>
        )}
        {d.transport === 'http' ? (
          <>
            <Field label="URL" htmlFor="mcp-url">
              <input
                id="mcp-url"
                className="vfield mono"
                aria-label="Server URL"
                placeholder="https://api.fastmail.com/mcp"
                value={d.url}
                onChange={(e) => setDraft(key, { ...d, url: e.target.value })}
              />
            </Field>
            <Field label="Headers" htmlFor="mcp-headers">
              <textarea
                id="mcp-headers"
                className="ci-textarea mono"
                aria-label="Headers"
                placeholder={'One per line\nAuthorization: Bearer …'}
                rows={2}
                value={d.text}
                onChange={(e) => setDraft(key, { ...d, text: e.target.value })}
              />
            </Field>
            {pinnedUrl && (
              <p className="ld-hint">
                Static token only. <InfoTip label="Why no sign-in?">{NO_OAUTH_ELSEWHERE}</InfoTip>
              </p>
            )}
            {!pinnedUrl && (
              <button
                type="button"
                className="memory-view-toggle"
                aria-expanded={showOauth}
                onClick={() =>
                  setOauthOpen((cur) => {
                    const next = new Set(cur);
                    if (next.has(key)) next.delete(key);
                    else next.add(key);
                    return next;
                  })
                }
              >
                <ChevronRight size={14} className={showOauth ? 'open' : ''} />
                <strong>OAuth client</strong>
              </button>
            )}
            {!pinnedUrl && showOauth && (
              <>
                <input
                  className="vfield"
                  aria-label="OAuth client ID"
                  placeholder="Client ID (providers without auto-registration, e.g. Slack)"
                  value={d.oauthClientId}
                  onChange={(e) => setDraft(key, { ...d, oauthClientId: e.target.value })}
                />
                <input
                  className="vfield"
                  type="password"
                  aria-label="OAuth client secret"
                  placeholder="Client secret (confidential clients only)"
                  value={d.oauthClientSecret}
                  onChange={(e) => setDraft(key, { ...d, oauthClientSecret: e.target.value })}
                />
                <input
                  className="vfield"
                  aria-label="OAuth scopes"
                  placeholder="Scopes, space-separated"
                  value={d.oauthScope}
                  onChange={(e) => setDraft(key, { ...d, oauthScope: e.target.value })}
                />
                {d.oauthClientId.trim() && (
                  <p className="ld-hint">
                    Register this redirect URL in the provider app: <code>http://127.0.0.1:41759/callback</code>
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <>
            <Field label="Command" htmlFor="mcp-command">
              <input
                id="mcp-command"
                className="vfield mono"
                aria-label="Command"
                placeholder="npx"
                value={d.command}
                onChange={(e) => setDraft(key, { ...d, command: e.target.value })}
              />
            </Field>
            <Field label="Arguments" htmlFor="mcp-args">
              <input
                id="mcp-args"
                className="vfield mono"
                aria-label="Arguments"
                placeholder="Space-separated, e.g. -y @playwright/mcp"
                value={d.args}
                onChange={(e) => setDraft(key, { ...d, args: e.target.value })}
              />
            </Field>
            <Field label="Environment" htmlFor="mcp-env">
              <textarea
                id="mcp-env"
                className="ci-textarea mono"
                aria-label="Environment variables"
                placeholder={'One per line\nKEY=value'}
                rows={3}
                value={d.text}
                onChange={(e) => setDraft(key, { ...d, text: e.target.value })}
              />
            </Field>
          </>
        )}
        {hasSecret && (
          <p className="ld-hint">{MCP_SECRET_MASK} is a stored secret. Leave it to keep it, or type a new value.</p>
        )}
      </>
    );
  }

  /** The Status tab: what is running where, and the actions that ask it. */
  function statusTab(s: McpServerSummary) {
    const state = serverState(s);
    if (s.location?.orphaned) {
      return (
        <p className="ld-hint">
          Runs nowhere: that computer is no longer paired. Nothing was deleted — pair that computer again, pick
          another one under Runs on, or remove the server. Pairing again gives a computer a new identity, so if
          you just re-paired it, it is the one offered first.
        </p>
      );
    }
    if (hostedHere(s)) {
      return (
        <>
          <div className="ld-stat">
            <PlugZap size={13} />
            <span>{hostStateLine(hostState.status[s.name])}</span>
          </div>
          <div className="mcp-state-acts">
            <button type="button" className="ld-btn" onClick={() => testHosted(s.name)} disabled={testing === s.name}>
              <PlugZap size={13} className={testing === s.name ? 'spin' : undefined} />{' '}
              {testing === s.name ? 'Connecting…' : 'Test connection'}
            </button>
            {hostState.approved[s.name] && (
              <button type="button" className="ld-btn" onClick={() => rejectHosted(s.name)}>
                <ShieldOff size={13} /> Stop trusting it
              </button>
            )}
          </div>
        </>
      );
    }
    if (s.location) {
      return <p className="ld-hint">Approved and tested on {s.location.label}, not from here.</p>;
    }
    const where = remote ? 'your Stem server' : 'this computer';
    const line = !s.enabled
      ? 'Switched off. Its configuration and sign-in are kept.'
      : state === 'connected'
        ? `Running on ${where}.`
        : state === 'pending'
          ? `Starting on ${where}…`
          : state === 'needs-login'
            ? 'Not signed in.'
            : state === 'failed'
              ? stateTitle(s, state)
              : 'Not started yet — it starts with the next chat that needs it.';
    return (
      <>
        <div className="ld-stat">
          <PlugZap size={13} />
          <span>{line}</span>
        </div>
        {s.transport === 'http' && s.authStatus && (
          <div className="ld-stat">
            <ShieldCheck size={13} />
            <span>{s.authStatus === 'o_auth' ? 'Signed in with OAuth' : 'Uses a static token'}</span>
          </div>
        )}
      </>
    );
  }

  /** The sign-in card a signed-out URL server opens with. */
  function signInCard(s: McpServerSummary) {
    return (
      <div className="mcp-approval">
        <span className="set-sub">
          {statuses[s.name]?.status === 'failed' ? `${s.name} stopped answering` : `Sign in to ${s.name}`}
        </span>
        <p className="muted">Stem opens the provider’s sign-in page in your browser.</p>
        <div className="push-row">
          <button className="primary" onClick={() => signIn(s.name)} disabled={!!loginName || !!busy}>
            <LogIn size={13} /> {signInLabel(s.name)}
          </button>
        </div>
      </div>
    );
  }

  /** The row's status word: what a glance at the list should tell you. */
  function stateChip(s: McpServerSummary) {
    if (s.location?.orphaned) return <Chip tone="off">Nowhere</Chip>;
    if (!s.enabled) return <Chip tone="off">Off</Chip>;
    const state = serverState(s);
    if (state === 'needs-approval') return <Chip tone="warn" icon={<ShieldCheck size={10} />}>Approve</Chip>;
    if (state === 'needs-login') return <Chip tone="warn" icon={<LogIn size={10} />}>{signInLabel(s.name)}</Chip>;
    if (state === 'failed') return <Chip tone="danger" icon={<AlertTriangle size={10} />} title={stateTitle(s, state)}>Failed</Chip>;
    if (state === 'pending') return <Chip tone="off" icon={<Loader size={10} className="spin" />}>Starting</Chip>;
    if (state === 'connected') {
      const tools = hostedHere(s) ? hostState.status[s.name]?.tools : undefined;
      return (
        <Chip tone="ok" title={stateTitle(s, state)}>
          {tools !== undefined ? `${tools} tool${tools === 1 ? '' : 's'}` : 'Running'}
        </Chip>
      );
    }
    return null;
  }

  const groups = placeGroups();
  const newRows = [...editing.entries()].filter(([, e]) => e.isNew);
  const showWhere = remote || anyPinned;
  const footerNotes = (
    <>
      {/* The server is older than this app and does not know what a pinned
          server is. Said here because the alternative is a panel that looks
          exactly like one with nothing pinned to this computer. */}
      {hostState.unsupported && <p className="error">{hostState.unsupported}</p>}
      {loginName && loginUrl?.name === loginName && (
        <p className="muted">
          If the browser didn’t open, authorize here:{' '}
          <a href={loginUrl.url} target="_blank" rel="noreferrer">{loginUrl.url}</a>
        </p>
      )}
      {busy && <p className="muted">{busy}</p>}
    </>
  );

  const openEntry = openKey ? editing.get(openKey) : undefined;
  if (openKey && openEntry) {
    const key = openKey;
    const entry = openEntry;
    const s = entry.isNew ? null : servers.find((x) => x.name === key) ?? null;
    const d = entry.draft;
    const dirty = !sameDraft(d, entry.base);
    const valid = !!d.name.trim() && (d.transport === 'http' ? !!d.url.trim() : !!d.command.trim());
    const pending =
      s && hostedHere(s) && hostState.status[s.name]?.status === 'unapproved'
        ? hostState.pending.find((p) => p.name === s.name)
        : undefined;
    const tabs: { key: EditorTab; label: string }[] = [
      { key: 'connection', label: 'Connection' },
      ...(showWhere || d.location ? [{ key: 'where' as const, label: 'Runs on' }] : []),
      ...(s ? [{ key: 'status' as const, label: 'Status' }] : [])
    ];
    const shownTab = tabs.some((t) => t.key === tab) ? tab : 'connection';
    return (
      <div className="ld-detail">
        <DetailHeader backLabel="MCP servers" onBack={back}>
          {s && !s.location?.orphaned && (
            <button
              type="button"
              className={`switch${s.enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={s.enabled}
              aria-label={`${s.name} enabled`}
              title={s.enabled ? 'Switch off (keeps its configuration and sign-in)' : 'Switch on'}
              onClick={() => toggleEnabled(s.name, !s.enabled)}
              disabled={!!busy || !!loginName}
            />
          )}
          <ConfirmDelete
            label={s ? 'Remove server' : 'Discard this draft'}
            icon={<Trash2 size={14} />}
            onConfirm={() => (s ? void remove(s) : cancel(key))}
          />
        </DetailHeader>
        <DetailIdent
          glyph={<Glyph icon={d.transport === 'http' ? <Globe size={17} /> : <Terminal size={17} />} size="lg" />}
          name={
            entry.isNew ? (
              <input
                className="ld-name-input"
                aria-label="Server name"
                placeholder="Name (e.g. fastmail)"
                value={d.name}
                autoFocus
                onChange={(e) => setDraft(key, { ...d, name: e.target.value })}
              />
            ) : (
              <span className="ld-name-static">{d.name}</span>
            )
          }
          caption={
            entry.isNew
              ? 'Not saved yet · the name and type are fixed once saved'
              : `${d.transport === 'http' ? 'URL' : 'Command'} server${s && !s.enabled ? ' · switched off' : ''}`
          }
        />
        {error && <p className="task-failed">{error}</p>}
        {pending && approvalCard(pending)}
        {s && s.enabled && serverState(s) === 'needs-login' && signInCard(s)}
        <DetailTabs tabs={tabs} value={shownTab} onChange={setTab} />
        <div className="ld-body">
          {shownTab === 'connection' && connectionTab(s, key, entry)}
          {shownTab === 'where' && locationSelect(s, key, d)}
          {shownTab === 'status' && s && statusTab(s)}
        </div>
        <DetailFooter
          dirty={dirty}
          saving={savingKey === key}
          canSave={valid && !busy}
          saveLabel={entry.isNew ? 'Add server' : 'Save'}
          onCancel={() => cancel(key)}
          onSave={() => void save(key)}
        />
        {footerNotes}
      </div>
    );
  }

  const q = query.trim().toLowerCase();
  const detailOf = (s: McpServerSummary) => (s.transport === 'http' ? s.url : `${s.command} ${s.args.join(' ')}`.trim());
  const matches = (s: McpServerSummary) => !q || s.name.toLowerCase().includes(q) || detailOf(s).toLowerCase().includes(q);
  const waiting = servers.filter((s) => {
    const st = serverState(s);
    return st === 'needs-approval' || st === 'needs-login';
  });

  return (
    <div className="ld-list">
      <ListHeader
        title="MCP servers"
        templates={[
          { key: 'url', icon: <Globe size={12} />, label: 'From a URL', hint: 'A hosted server, e.g. Linear or Fastmail', onPick: () => add('http') },
          { key: 'cmd', icon: <Terminal size={12} />, label: 'From a command', hint: 'A program Stem starts, e.g. npx …', onPick: () => add('stdio') },
          { key: 'json', icon: <Braces size={12} />, label: 'Paste JSON', hint: 'The mcpServers block from a README', onPick: () => setPasteText('') }
        ]}
      />
      {pasteText !== null && (
        <div className="mcp-approval">
          <span className="set-sub">Paste a server entry</span>
          <p className="muted">
            The JSON a README gives for Claude Desktop, Cursor or VS Code. Every server in it opens as a draft;
            nothing is saved until you press Add server.
          </p>
          <textarea
            className="ci-textarea mono"
            aria-label="Server JSON"
            rows={6}
            autoFocus
            placeholder={'{\n  "mcpServers": {\n    "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] }\n  }\n}'}
            value={pasteText}
            onChange={(e) => {
              setPasteText(e.target.value);
              setPasteError(null);
            }}
          />
          {pasteError && <p className="error">{pasteError}</p>}
          <div className="push-row">
            <button type="button" className="link-btn" onClick={() => setPasteText(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!pasteText.trim()}
              onClick={() => {
                const r = parseMcpPaste(pasteText);
                if (!r.ok) setPasteError(r.error);
                else add(r.servers[0].transport, r.servers);
              }}
            >
              Fill in
            </button>
          </div>
        </div>
      )}
      <ListSearch value={query} onChange={setQuery} placeholder="Find a server" />
      {error && <p className="task-failed">{error}</p>}
      {waiting.length > 0 && (
        <AttentionBar onClick={() => void open(waiting[0])}>
          {waiting.length === 1
            ? `${waiting[0].name} needs you: ${serverState(waiting[0]) === 'needs-approval' ? 'approve it' : 'sign in'}`
            : `${waiting.length} servers need you`}
        </AttentionBar>
      )}
      {servers.length === 0 && newRows.length === 0 ? (
        <p className="muted ld-empty">
          No MCP servers yet. A server gives Stem tools from another service or program — its URL or command
          comes from whoever provides it.
        </p>
      ) : (
        groups.map((group) => {
          const items = group.items.filter(matches);
          if (items.length === 0) return null;
          return (
            <ListGroup key={group.key} label={group.key === 'all' ? 'Servers' : group.head} count={items.length}>
              {items.map((s) => {
                const state = serverState(s);
                const entry = editing.get(s.name);
                const dirty = !!entry && !sameDraft(entry.draft, entry.base);
                // A failure takes the line, in the words of whichever machine reported it.
                const line = state === 'failed' ? stateTitle(s, state) : detailOf(s);
                return (
                  <ListRow
                    key={s.name}
                    glyph={<Glyph icon={s.transport === 'http' ? <Globe size={14} /> : <Terminal size={14} />} tone={state === 'failed' ? 'danger' : 'plain'} />}
                    name={s.name}
                    sub={`${line.replace(/^https?:\/\//, '')}${dirty ? ' · unsaved' : ''}`}
                    right={stateChip(s)}
                    dim={!s.enabled || !!s.location?.orphaned}
                    onOpen={() => void open(s, state === 'failed' ? 'status' : undefined)}
                  />
                );
              })}
            </ListGroup>
          );
        })
      )}
      {newRows.length > 0 && (
        <ListGroup label="Not saved yet" count={newRows.length}>
          {newRows.map(([key, entry]) => (
            <ListRow
              key={key}
              glyph={<Glyph icon={entry.draft.transport === 'http' ? <Globe size={14} /> : <Terminal size={14} />} />}
              name={entry.draft.name.trim() || 'New server'}
              sub={entry.draft.transport === 'http' ? entry.draft.url || 'no URL yet' : `${entry.draft.command} ${entry.draft.args}`.trim() || 'no command yet'}
              onOpen={() => {
                setTab('connection');
                setOpenKey(key);
              }}
            />
          ))}
        </ListGroup>
      )}
      {footerNotes}
    </div>
  );
}
