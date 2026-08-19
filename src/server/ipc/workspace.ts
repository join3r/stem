import { registerServer } from './guard';
import type { IpcDeps } from './deps';
import * as activity from '../activity';
import { listSkills, setSkillEnabled } from '../workspace/skills';
import { addFiles, createSubdir, listFiles, removeFile, removeSubdir } from '../files/store';
import {
  addClientFolder,
  addConnectedFolders,
  clientFoldersForDevice,
  listConnectedFolders,
  recordFolderSynced,
  removeConnectedFolder,
  setFolderRootMissing,
  updateConnectedFolder
} from '../workspace/connected-folders';
import { enrichConnectedFolders } from '../connected-folders/enrich';
import { applyMirror, coerceManifestEntries, diffMirror, recordMirrorSkipped } from '../mirror';
import { mirrorSyncApplied, mirrorSyncEnded, mirrorSyncPlanned } from '../mirror/sync-activity';
import type { CallerContext } from './guard';
import type { ConnectedFolder, MirrorApplyInput, MirrorFolderInfo, MirrorReportInput } from '../../shared/types';
import { browseServerFolders } from '../workspace/browse';
import { getFolderIndexStatuses, seedFolderLearnMarks, syncFolderIndexes } from '../folder-index';
import { clearScratch, listScratchUsage, UNFILED_KEY } from '../exec/scratch';
import { recallStore } from '../recall/store';
import { skillsRunOf, updateSkillsSettings } from '../workspace/settings';
import { resetSkills, skillsResetStatus } from '../skills/reset';
import { removeSkill } from '../skills/store';
import { learnFromLastTurn } from '../startup/skills';
import { curateSkills } from '../skills/curate';
import { applyAutomaticTransitions } from '../skills/lifecycle';
import type { LlmClient } from '../recall/llm';
import type { ApprovalId } from '../backend/types';
import type {
  ChatSummary,
  ConnectedFolderPatch,
  ScheduledTask,
  ScratchUsageRow,
  SkillsMode,
  TaskModelPatch,
  TaskSchedulePatch
} from '../../shared/types';

/**
 * Skills, the Files place, connected folders, scheduled tasks, and the phone
 * bridge's settings pair. The native pickers and the reveal-in-file-manager
 * handlers that used to sit here act on the client's own machine and moved to
 * src/desktop/local.
 */
export function registerWorkspaceIpc(deps: IpcDeps): void {
  registerServer('skills:list', () => listSkills());
  registerServer('skills:setEnabled', async (_e, slug: string, enabled: boolean) => {
    const skills = await setSkillEnabled(slug, enabled);
    // Toggling rewrites the ignore file, which only takes effect on a rescan —
    // without this the switch stayed cosmetic until the next backend restart.
    await deps.runtime().requestSkillReload();
    return skills;
  });
  // Deleting one skill, as opposed to the all-or-nothing `skills:reset`. There is
  // deliberately no `requireAgentAuthored` here: that guard belongs to the model's
  // own tool (it may retire what it wrote, never the user's files), and applying it
  // to the person clicking the button gets it exactly backwards. On a server
  // install the skills folder is not on their machine, so this panel is the only
  // way they have to remove anything at all.
  registerServer('skills:remove', async (_e, slug: string) => {
    const res = removeSkill(slug);
    if (!res.ok) throw new Error(res.error);
    await deps.runtime().requestSkillReload();
    return listSkills();
  });
  registerServer(
    'skills:resolveApproval',
    (_e, id: ApprovalId, accept: boolean, skill?: { name: string; description: string; body: string }) => {
      // The write itself happens inside the held manage_skill call (SkillBridge),
      // not here — that keeps one code path for validation and one for the reload,
      // and lets the tool tell the model exactly what happened.
      deps.runtime().resolveSkillApproval(id, accept, skill);
    }
  );
  registerServer('skills:learn', (_e, threadId: string, focus?: string) => learnFromLastTurn(threadId, focus));
  registerServer('skills:resetStatus', () => skillsResetStatus());
  registerServer('skills:reset', async (_e, exportFirst: boolean, mode: SkillsMode) => {
    const result = resetSkills({ export: exportFirst });
    // The dialog is also where the user picks how automatic skills should be, so
    // the answer lands with the migration rather than needing a second trip to
    // Settings that most people would never make.
    await updateSkillsSettings({ mode });
    await deps.runtime().requestSkillReload();
    return result;
  });
  registerServer('skills:curate', async () => {
    // Same hidden one-shot seam the curator uses; `force` bypasses the size floor
    // so a manual "Tidy up" always runs. Reload so pi rescans the updated skills.
    const llm: LlmClient = {
      complete: async (prompt) => deps.runtime().complete(prompt, await skillsRunOf())
    };
    // Tracked under the same kind as the automatic pass in startup/recall-tasks.ts.
    // Pressing the button spends the same tens of seconds on the same model call,
    // and a manual run that reports nowhere is the one most likely to be watched.
    // The lifecycle clock first, outside the curator's gates and its model call —
    // pressing "Tidy up" should also apply anything the 24 h timer has not reached
    // yet, and it costs one walk of the skills dir.
    const expired = applyAutomaticTransitions();
    const res = await activity.track('skills.curate', 'Curating skills', () => curateSkills(llm, { force: true }), (r) => ({
      worked: r.merged + r.archived + expired > 0,
      detail: `Merged ${r.merged}, archived ${r.archived}, expired ${expired}`
    }));
    await deps.runtime().requestSkillReload();
    // listSkills is async and lives inside an object literal, so it MUST be
    // awaited here: a nested promise isn't awaited by the IPC layer and
    // serializes to {} — which the Skills tab then crashed rendering.
    return { skills: await listSkills(), merged: res.merged, archived: res.archived, expired };
  });
  // There is no `skills:distillNow` any more. Its "Collect now" swept the chat
  // backlog for skills, but the recall DB holds no tool calls to sweep; skills
  // are now written at the end of the turn that earned them (skills/settle.ts).

  registerServer('files:list', () => listFiles());
  registerServer('files:add', (_e, paths: string[], subdir?: string) => addFiles(paths, subdir));
  registerServer('files:remove', (_e, rel: string) => removeFile(rel));
  registerServer('files:mkdir', (_e, name: string) => createSubdir(name));
  registerServer('files:rmdir', (_e, name: string) => removeSubdir(name));

  // ---- connected folders (external folders the assistant reads in place) ----
  // Distinct `cfolders:*` namespace — `folders:*` is the chat-folder tree.
  registerServer('cfolders:list', async () => enrichConnectedFolders(await listConnectedFolders()));
  // The remote picker: walks THIS machine's directories so a client whose native
  // dialog is on the wrong computer can still choose a folder that exists here.
  registerServer('cfolders:browse', (_e, path?: string | null) => browseServerFolders(path));
  registerServer('cfolders:add', (_e, paths: string[]) => addConnectedFolders(paths));
  // A folder that lives on the CALLING device (docs: client-connected folders).
  // No device id argument, deliberately — the caller IS the device, resolved from
  // the bearer token (the execHost/mcpHost rule): one paired machine must not be
  // able to claim a folder lives on another, and the machine that registers a
  // folder is the one whose own mirror list stays authoritative over what it
  // reads and uploads.
  registerServer('cfolders:addClient', async (caller, clientPath: string, label?: string | null) => {
    if (!caller) {
      throw new Error('cfolders:addClient needs a paired device — the folder lives on the CALLER’s machine.');
    }
    return enrichConnectedFolders(
      await addClientFolder({ deviceId: caller.deviceId, clientPath, label: label ?? undefined })
    );
  });
  registerServer('cfolders:update', async (_e, id: string, patch: ConnectedFolderPatch) => {
    const folders = await updateConnectedFolder(id, patch);
    // Index toggled: reconcile now (off → the DB file is deleted) and, when
    // turned on, kick a scan so the index fills without waiting for the timer.
    if (typeof patch.index === 'boolean') {
      void syncFolderIndexes();
      if (patch.index) deps.scheduleFolderIndexScan(500);
    }
    // Learn-mode transitions seed the per-doc marks: 'new' stamps everything as
    // already learned ("start from now" — also how a running 'all' sweep is
    // cancelled); 'all' stamps nothing, leaving the backlog pending. Then kick
    // the drain so learning starts without waiting for the next scan cycle.
    if (typeof patch.learnMode === 'string') {
      if (patch.learnMode === 'new') await seedFolderLearnMarks(id);
      if (patch.learnMode === 'new' || patch.learnMode === 'all') deps.scheduleFolderLearn(1_000);
    }
    return enrichConnectedFolders(folders);
  });
  registerServer('cfolders:remove', async (_e, id: string) => {
    const folders = await removeConnectedFolder(id);
    mirrorSyncEnded(id); // Disconnecting a client folder mid-sync closes its activity row.
    void syncFolderIndexes(); // Drops the disconnected folder's index DB.
    return enrichConnectedFolders(folders);
  });
  // The disconnect flow's "also forget the facts learned from this folder"
  // choice. Separate from cfolders:remove so keeping the facts stays the
  // default; pinned facts always survive (enforced in the store).
  registerServer('cfolders:forgetFacts', (_e, id: string) => recallStore.forgetFactsBySource(`folder:${id}`));
  registerServer('cfolders:indexStatus', () => getFolderIndexStatuses());

  // ---- client-folder mirror sync (see server/mirror) ----
  // Every mirror channel follows the execHost/mcpHost rule: no device id in the
  // arguments, the caller IS the device, and a folder id that does not live on
  // the calling machine is refused — one paired machine must never be able to
  // write into (or diff, or freeze) another machine's mirror.
  const clientFolderOf = async (caller: CallerContext, folderId: string): Promise<ConnectedFolder> => {
    if (!caller) {
      throw new Error('mirror channels need a paired device — a mirror belongs to the CALLER’s machine.');
    }
    const folder = (await clientFoldersForDevice(caller.deviceId)).find((f) => f.id === folderId);
    if (!folder) throw new Error('No connected folder with that id lives on the calling computer.');
    return folder;
  };
  registerServer('mirror:hello', async (caller: CallerContext): Promise<MirrorFolderInfo[]> => {
    if (!caller) {
      throw new Error('mirror:hello needs a paired device — it answers for the CALLER’s machine.');
    }
    return (await clientFoldersForDevice(caller.deviceId)).map((f) => ({
      folderId: f.id,
      clientPath: f.origin!.clientPath,
      mode: f.mode,
      label: f.label
    }));
  });
  registerServer('mirror:diff', async (caller: CallerContext, folderId: string, payload: { files?: unknown }) => {
    const folder = await clientFolderOf(caller, folderId);
    const diff = await diffMirror(folderId, coerceManifestEntries(payload.files));
    // The diff is where the server first learns a round's size — a first sync
    // of a big folder runs for a long time, and belongs in background activity.
    mirrorSyncPlanned(folderId, folder.label, diff.want.length + diff.delete.length);
    return diff;
  });
  registerServer('mirror:apply', async (caller: CallerContext, folderId: string, payload: Partial<MirrorApplyInput>) => {
    await clientFolderOf(caller, folderId);
    const result = await applyMirror(folderId, {
      puts: Array.isArray(payload.puts) ? payload.puts : [],
      deletes: Array.isArray(payload.deletes) ? payload.deletes : []
    });
    mirrorSyncApplied(folderId, result.applied + result.deleted);
    return result;
  });
  registerServer('mirror:report', async (caller: CallerContext, folderId: string, report: Partial<MirrorReportInput>) => {
    const folder = await clientFolderOf(caller, folderId);
    mirrorSyncEnded(folderId);
    if (report.state === 'root-missing') {
      await setFolderRootMissing(folderId, true);
      return;
    }
    if (report.state !== 'ok') throw new Error('A mirror report is either "ok" or "root-missing".');
    if (Array.isArray(report.skipped)) await recordMirrorSkipped(folderId, report.skipped);
    await recordFolderSynced(folderId, new Date().toISOString());
    // A round that changed an indexed mirror should surface in recall without
    // waiting out the 15-minute rescan timer.
    if (folder.index) deps.scheduleFolderIndexScan(2_000);
  });

  // Scheduled tasks. Mutations return the fresh list (like the cfolders handlers).
  registerServer('tasks:list', (): ScheduledTask[] => deps.scheduler()?.snapshot() ?? []);
  // What a scheduled run of this thread would execute on (Tasks tab "runs on" chip).
  registerServer('tasks:threadSettings', (_e, threadId: string) => deps.runtime().threadTurnSettings(threadId));
  registerServer('tasks:setEnabled', (_e, id: string, enabled: boolean) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.setEnabled(id, enabled) : [];
  });
  registerServer('tasks:runNow', (_e, id: string) => deps.scheduler()?.runNow(id) ?? []);
  registerServer('tasks:delete', (_e, id: string) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.remove(id) : [];
  });
  registerServer('tasks:updateSchedule', (_e, id: string, patch: TaskSchedulePatch) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.updateSchedule(id, patch.schedule) : [];
  });
  registerServer('tasks:updateModel', (_e, id: string, patch: TaskModelPatch) => {
    const scheduler = deps.scheduler();
    return scheduler ? scheduler.updateModel(id, patch.model ?? null, patch.effort ?? null) : [];
  });

  // What each chat's shell commands have left on disk. Measured here rather than
  // client-side because the client may be a phone and the disk may be a VPS's.
  registerServer('exec:scratchUsage', async (): Promise<ScratchUsageRow[]> => {
    const [usage, chats] = await Promise.all([
      listScratchUsage(),
      deps.runtime().listThreads().catch((): ChatSummary[] => [])
    ]);
    const titles = new Map(chats.map((c) => [c.threadId, c.title]));
    return usage
      .map((row) => ({
        key: row.key,
        // Absent for the unfiled pile and for a folder whose chat is gone; the
        // renderer names both cases in words a person can act on.
        title: row.key === UNFILED_KEY ? undefined : titles.get(row.key),
        bytes: row.bytes,
        files: row.files
      }))
      .sort((a, b) => b.bytes - a.bytes);
  });
  registerServer('exec:clearScratch', (_e, key: string) => clearScratch(key));
}
