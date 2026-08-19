import { app, dialog, shell, type BrowserWindow } from 'electron';
import { join } from 'node:path';
import { handleLocal } from '../ipc-bridge';
import { ensureFilesRoot } from '../../server/files/store';
import { imagePreviewDataUrl } from '../../server/pi/attachments';
import { connectedFolderPath } from '../../server/workspace/connected-folders';
import { workspaceRoot } from '../../server/workspace/paths';
import { exportState } from '../../server/workspace/state-transfer';
import { readClientIdentity, storedServerUrl } from '../client-store';
import { downloadFile } from '../file-transfer';
import { markReleaseNotesRead, releaseNotesSnapshot } from '../release-notes';
import { pairWithServer, useBuiltInServer, type ServerCredentials } from '../server-endpoint';
import { updateClientReleaseNotes, updateClientUpdates, withClientSettings } from '../settings';
import type { McpHost } from '../mcp-host';
import type { ExecHost, ExecHostLocalState } from '../exec-host';
import type { MirrorFolderLocalState, MirrorHost } from '../mirror-host';
import type { Updates } from '../updates';
import type {
  AppSettings,
  ClientInfo,
  McpHostLocalState,
  ReleaseNotesSettings,
  StateExportReport,
  UpdatesSettings
} from '../../shared/types';

// Handlers that act on THIS machine — a native picker, a file manager, a local
// image read — and so can never be answered by a server that might be somewhere
// else. They were `dialog`/`shell` calls sitting among the server's handlers in
// ipc/workspace.ts and files/store.ts; the split is what separated them.
//
// Phase 2 adds two more families for the same reason, neither of which touches a
// window. Which server this client talks to is not a question the server being
// replaced can be asked. And the "what's new" popup is decided entirely from the
// version installed HERE and the RELEASE_NOTES.md shipped beside it, so a server
// with two Macs on two builds has no single correct answer to give.
//
// Three of them reveal a path the SERVER knows: files:reveal, cfolders:reveal and
// cfolders:revealWorkspace. They resolve it by calling into the server's path
// helpers directly rather than over the transport, because the answer is only
// ever useful when both halves share a filesystem — which is exactly the case
// where the direct call is correct.
//
// When they do not share one, those three have no honest answer, and they say so
// rather than opening a folder. The path they would resolve exists on THIS
// machine too — an empty workspace this client never uses — so quietly revealing
// it would show the user a folder that looks like theirs and contains none of
// their files. The renderer hides the buttons entirely (see
// hooks/useRemoteServer.ts); this refusal is what stands behind that, so a stale
// window or a future call site cannot get the wrong folder either.
//
// files:download is the affordance that replaces them: the server streams the
// file down GET /files/<rel> and it lands in this machine's Downloads folder,
// which is a place that does exist here. It goes over the socket in both
// deployments rather than shortcutting a local copy — one path, tested by
// everybody who presses the button.
//
// The mcpHost:* family joins them for the sharpest version of the same reason.
// Whether a spec may spawn a process on this computer is a decision made on this
// computer and recorded here (src/desktop/mcp-host/approvals.ts); a channel that
// asked the server for it would be asking the machine holding the spec whether
// the spec is allowed, which is the question ④ exists to move. It also means the
// panel keeps working when the machine hosting a server is a phone or a build
// too old to know these channels: the answer for THIS machine never left it.

export interface LocalIpcDeps {
  /** Picker parent. Null only if the main window was closed mid-flight. */
  mainWindow(): BrowserWindow | null;
  /** Where this client is connected, and whether it started that server itself. */
  connection(): { serverUrl: string; remote: boolean; pinnedByEnv: boolean };
  /** Whether the server is answering right now (see desktop/proxy.ts). */
  reachable(): boolean;
  /** Address + bearer token, for the routes that are not `POST /rpc`. */
  credentials(): ServerCredentials;
  /** The settings document, for the handlers that need the server's half of it. */
  settings(): Promise<AppSettings>;
  /** The updater for the build installed HERE (see desktop/updates.ts). */
  updates: Updates;
  /** The MCP servers pinned to this machine (see desktop/mcp-host/). */
  mcpHost: McpHost;
  /** Whether this machine accepts commands from its server (see desktop/exec-host/). */
  execHost: ExecHost;
  /**
   * The folders THIS machine mirrors to its server (see desktop/mirror-host/).
   * Null when the server runs on this computer — a folder here is connected
   * directly then, and mirroring it to itself would be a copy with no purpose.
   */
  mirrorHost: MirrorHost | null;
}

/**
 * Where a downloaded file lands. STEM_DOWNLOADS_DIR keeps a test run out of the
 * real Downloads folder; everywhere else this is the OS's own answer.
 */
function downloadsDir(): string {
  return process.env.STEM_DOWNLOADS_DIR?.trim() || app.getPath('downloads');
}

export function registerLocalIpc(deps: LocalIpcDeps): void {
  /** Identity + connection, re-read each time so a fresh pairing shows at once. */
  async function clientInfo(): Promise<ClientInfo> {
    const [identity, configuredUrl] = await Promise.all([readClientIdentity(), storedServerUrl()]);
    return { deviceId: identity?.deviceId ?? null, configuredUrl, ...deps.connection() };
  }

  // Who this client is. Deliberately answered here and not by the server: what
  // the server knows about "the device asking" is one id it resolved from a
  // bearer token (see ipc/guard.ts), and every fact here — the configured URL,
  // whether we can reach it — is about this machine and not in that. It is
  // what lets Settings → Server → Devices point at your own row instead of offering to
  // revoke the credential you are holding.
  handleLocal('client:info', clientInfo);

  // Is the server answering? A window asks once on mount and is pushed every
  // change afterwards (`client:connectionChanged`). It has to be askable and not
  // only pushable, because the first answer can be settled before any window
  // exists: a launch with no network finds out while fetching the channel list,
  // which happens before the first BrowserWindow is created.
  //
  // Deliberately client-owned, and obviously so: a server cannot be asked
  // whether it can be reached.
  handleLocal('client:connection', () => ({ reachable: deps.reachable() }));

  // Settings → Server. Pairing is the whole act: the address and the credential
  // are written together, because a token means nothing to a server that never
  // issued it. Nothing re-points at runtime — the event stream, the bound channel
  // list and every cached surface hang off the connection made at startup — so
  // this deliberately only changes what the NEXT launch will do, and the pane
  // says so rather than pretending otherwise.
  handleLocal('client:pair', async (_e, url: string, code: string): Promise<ClientInfo> => {
    await pairWithServer(url, code);
    return clientInfo();
  });
  handleLocal('client:useBuiltIn', async (): Promise<ClientInfo> => {
    await useBuiltInServer();
    return clientInfo();
  });

  // "What's new": the snapshot carries the whole decision (which sections are
  // unseen, and the silent marker advance when the popup is switched off), so the
  // renderer only has to render what it's handed. Onboarding is the one input
  // that isn't this machine's — the wizard is about the Stem account, not the
  // laptop — so it comes off the server's settings document.
  handleLocal('releaseNotes:get', async () =>
    releaseNotesSnapshot((await deps.settings()).onboarding.completed)
  );
  handleLocal('releaseNotes:markSeen', async () => {
    await markReleaseNotesRead();
  });
  handleLocal(
    'settings:updateReleaseNotes',
    async (_e, patch: Partial<ReleaseNotesSettings>): Promise<AppSettings> => {
      await updateClientReleaseNotes(patch);
      // The renderer is handed a whole settings document here as it is by every
      // other settings channel, which costs one round trip for the half this
      // machine doesn't own. Cheaper than a second shape for one toggle.
      return withClientSettings(await deps.settings());
    }
  );

  // Updates: client-owned for the reason the release notes are — the version a
  // new release would replace is the one installed HERE. The status is askable
  // (a window that just mounted) and pushed (`updates:status`, on every change).
  handleLocal('updates:get', () => deps.updates.status());
  handleLocal('updates:check', () => deps.updates.check());
  handleLocal('updates:install', () => deps.updates.install());
  handleLocal(
    'settings:updateUpdates',
    async (_e, patch: Partial<UpdatesSettings>): Promise<AppSettings> => {
      await updateClientUpdates(patch);
      return withClientSettings(await deps.settings());
    }
  );

  // The MCP servers pinned to this machine. All three of the acting channels
  // answer with the fresh state, so a window that approves something re-renders
  // from the reply instead of asking again — and the host pushes the same shape
  // on `mcpHost:changed` when a server settles on its own.
  handleLocal('mcpHost:localState', () => deps.mcpHost.localState());
  handleLocal(
    'mcpHost:approve',
    (_e, name: string, fingerprint: string): Promise<McpHostLocalState> =>
      deps.mcpHost.approve(name, fingerprint)
  );
  handleLocal('mcpHost:reject', (_e, name: string): Promise<McpHostLocalState> => deps.mcpHost.reject(name));
  handleLocal('mcpHost:test', (_e, name: string): Promise<McpHostLocalState> => deps.mcpHost.test(name));
  // Ask the server again which servers are ours. The panel calls this the moment
  // it moves one: the pin lives on the server, so a server moved ONTO this
  // machine would otherwise sit unstarted (and its approval card unshown) until
  // the next launch, and one moved OFF would keep its child running here.
  // Everything else that changes an assignment already re-asks by itself — a
  // launch, a reconnection — this is the case where the change was made here.
  handleLocal('mcpHost:refresh', async (): Promise<McpHostLocalState> => {
    await deps.mcpHost.refresh();
    return deps.mcpHost.localState();
  });

  // Whether THIS computer accepts commands from its Stem server. Client-owned
  // for the sharpest version of the mcpHost reason above: the switch is the
  // consent, so the channel that flips it must not exist anywhere but on the
  // machine consenting. The server only ever hears the announcement.
  handleLocal('execHost:localState', (): Promise<ExecHostLocalState> => deps.execHost.localState());
  handleLocal(
    'execHost:setEnabled',
    (_e, enabled: boolean): Promise<ExecHostLocalState> => deps.execHost.setEnabled(enabled)
  );

  // Connect folders that live on THIS machine. Client-owned for the mcpHost
  // reason at its sharpest: the machine-local mirror list is the authority over
  // what this computer reads and uploads (see desktop/mirror-host/store.ts), so
  // the channel that appends to it must not exist anywhere but here. The picker
  // already ran (dialog:openDirectory); this takes its result.
  handleLocal('mirror:addLocal', async (_e, paths: string[]) => {
    if (!deps.mirrorHost) {
      throw new Error(
        'Stem is running on this computer — connect the folder directly instead of mirroring it to itself.'
      );
    }
    let folders: unknown = [];
    for (const path of paths) folders = await deps.mirrorHost.addFolder(path);
    return folders;
  });
  handleLocal('mirror:localState', (): MirrorFolderLocalState[] => deps.mirrorHost?.localState() ?? []);

  handleLocal('dialog:openFiles', () =>
    dialog
      .showOpenDialog(deps.mainWindow()!, { properties: ['openFile', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths))
  );
  handleLocal('dialog:openDirectory', () =>
    dialog
      .showOpenDialog(deps.mainWindow()!, { properties: ['openDirectory', 'multiSelections'] })
      .then((r) => (r.canceled ? [] : r.filePaths))
  );

  /**
   * Refuse a reveal that would open the wrong machine's folder. The message is
   * written for a user because it can reach one: the renderer hides these
   * buttons when the server is elsewhere, so anybody who sees this got here
   * through a window that was open when the pairing changed.
   */
  function revealable(what: string): void {
    if (!deps.connection().remote) return;
    throw new Error(`${what} is on Stem's server, which is not this computer — there is nothing to open here.`);
  }

  /** Open the Files folder in Finder/Explorer. */
  handleLocal('files:reveal', async () => {
    revealable('Your Files folder');
    await shell.openPath(await ensureFilesRoot());
  });
  // Read-only, and reached only from the `att.path` branch of
  // renderer/attachments.ts — i.e. for an image the user picked or dropped, which
  // by construction is on the client's own disk.
  handleLocal('files:preview', (_e, path: string) => imagePreviewDataUrl(path));

  /**
   * Fetch one file out of the server's Files folder and put it where downloads
   * go, then show it there — the two halves of what "Download" means on a desktop.
   * Answers with the path it landed at, so the renderer can name it if it wants.
   */
  handleLocal('files:download', async (_e, rel: string): Promise<string> => {
    const saved = await downloadFile(deps.credentials(), rel, downloadsDir());
    // Opening a Finder window is the one part of this a test run must not do:
    // STEM_BACKGROUND is set for exactly the runs that are forbidden to take
    // activation (see BACKGROUND in desktop/index.ts, and the tray, which is
    // skipped under the same kind of flag for the same kind of reason).
    if (!process.env.STEM_BACKGROUND) shell.showItemInFolder(saved);
    return saved;
  });

  /**
   * Write everything this Stem knows to one file: the move to another machine,
   * and the backup, which are the same act.
   *
   * Client-owned for the reason `files:reveal` is, and one more. The re-wrap at
   * the heart of it unwraps the data key through the platform's keychain, and a
   * keychain is a thing you have on the machine you are sitting at — a server in
   * a container has none, which is the whole reason the archive has to be
   * re-wrapped under a passphrase before it goes there.
   *
   * And, like the reveals, it reads the state root through the server's own path
   * helpers rather than over the transport. Which makes it correct only while
   * both halves share a disk: with the server elsewhere, those helpers resolve to
   * an empty state root on THIS machine, and the archive would be an export of
   * nothing at all wearing the name of your Stem. So it refuses, and says where
   * to run it instead.
   *
   * The passphrase arrives from the renderer and goes no further than the wrap.
   * It is not written into the archive, not logged, and not passed as an argument
   * to anything.
   */
  handleLocal(
    'stem:exportState',
    async (_e, options: { passphrase?: unknown }): Promise<StateExportReport | null> => {
      if (deps.connection().remote) {
        throw new Error(
          "This Stem's chats and memory are on its server, which is not this computer — there is nothing here to export. " +
            'Run `stem-server export` there, or back up the folder its state is mounted from.'
        );
      }
      const passphrase = typeof options?.passphrase === 'string' ? options.passphrase : '';
      // The dialog comes AFTER the passphrase check so a bad one is not found out
      // at the end of picking a place to save.
      const stamp = new Date().toISOString().slice(0, 10);
      const chosen = await dialog.showSaveDialog(deps.mainWindow()!, {
        title: 'Move or back up this Stem',
        defaultPath: join(downloadsDir(), `stem-${stamp}.tar`),
        buttonLabel: 'Export',
        filters: [{ name: 'Tar archive', extensions: ['tar'] }]
      });
      if (chosen.canceled || !chosen.filePath) return null;
      return exportState({ out: chosen.filePath, passphrase });
    }
  );

  handleLocal('cfolders:reveal', async (_e, id: string) => {
    // A folder THIS machine mirrors is the one case where the right disk is the
    // local one even against a remote server: the folder the user means is the
    // one they picked here, and this machine knows where that is.
    const mirrored = deps.mirrorHost?.localState().find((f) => f.folderId === id);
    if (mirrored) {
      await shell.openPath(mirrored.clientPath);
      return;
    }
    revealable('That folder');
    const path = await connectedFolderPath(id);
    if (path) await shell.openPath(path);
  });
  handleLocal('cfolders:revealWorkspace', () => {
    revealable("Stem's own folder");
    return shell.openPath(workspaceRoot());
  });
}
