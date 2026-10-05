import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { browserDeviceRouter, closeBrowserDeviceRouter } from '../browser-device/router';
import { resolveComputerTarget } from '../exec-device/router';
import { ensureThreadScratch } from '../exec/scratch';
import { resolveUploadSources } from '../files/browser-sources';
import { outboxPut } from '../files/outbox';
import { resolveUploadHandle } from '../files/staging';
import { copyToUniquePath } from '../files/store';
import { log } from '../log';
import type { BrowserBridge, ChatBackend } from '../backend/types';
import type { BrowserAction, DeviceBrowserResult } from '../../shared/types';

/**
 * Browser control: the assistant's `browser` tool, routed from the backend to
 * the browser-device router. Like computer control the decisions that matter
 * are made elsewhere (which Mac: the turn's grant; whether it lets Stem drive
 * its browser: its own switch; when a run ends: the turn, or Stop). What this
 * bridge adds is the file traffic: an upload's files are checked here and put
 * in the Mac's outbox, and a download the Mac sent up is filed into the chat's
 * scratch folder, where the model can read it.
 */
export function initBrowserControl(deps: { runtime: ChatBackend }): BrowserBridge {
  const bridge: BrowserBridge = {
    async handleBrowserRequest(req) {
      let action: BrowserAction;
      if (req.action.kind === 'upload') {
        const files = Array.isArray(req.action.files) ? req.action.files : [];
        const sources = await resolveUploadSources(req.threadId, files, {
          findThreadImage: (threadId, imageId) => deps.runtime.findThreadImage(threadId, imageId)
        });
        if (!sources.ok) return { ok: false, error: sources.error };
        action = { ...req.action, files: sources.files.map((f) => outboxPut(req.device, f)) };
      } else {
        action = req.action;
      }
      const result = await browserDeviceRouter().send(req.threadId, req.device, action);
      return result.ok && result.downloads?.length ? fileDownloads(req.threadId, result) : result;
    },
    async resolveNamedMac(name) {
      const target = await resolveComputerTarget(name);
      if (!target.ok) return target;
      const host = await browserDeviceRouter().hostFor(target.deviceId);
      if (!host?.enabled) return { ok: false, error: `“${target.label}” does not let Stem drive its browser.` };
      if (!browserDeviceRouter().isAvailable(target.deviceId)) {
        return {
          ok: false,
          error: `“${target.label}” is not connected right now — it may be asleep, or Stem there is closed.`
        };
      }
      return { ok: true, deviceId: target.deviceId };
    },
    endThread: (threadId, reason) => browserDeviceRouter().endThread(threadId, reason),
    settleAll: () => closeBrowserDeviceRouter()
  };
  deps.runtime.setBrowserBridge(bridge);
  return bridge;
}

/** Move what the Mac streamed up into the chat's scratch `downloads/`, and say where. */
async function fileDownloads(
  threadId: string,
  result: Extract<DeviceBrowserResult, { ok: true }>
): Promise<DeviceBrowserResult> {
  const lines: string[] = [];
  const dir = join(await ensureThreadScratch(threadId), 'downloads');
  await mkdir(dir, { recursive: true });
  for (const d of result.downloads ?? []) {
    const staged = await resolveUploadHandle(d.handle);
    if (!staged) {
      lines.push(`Download “${d.name}” finished on the Mac but did not reach Stem; ask the user for the file.`);
      continue;
    }
    try {
      const path = await copyToUniquePath(staged, dir, basename(d.name) || 'download');
      lines.push(`Downloaded “${d.name}” (${d.size} bytes) to ${path}`);
    } catch (e) {
      log('browser-device', 'could not file a download', { threadId, error: String(e) });
      lines.push(`Download “${d.name}” could not be saved on the server: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const text = [result.text, ...lines].filter(Boolean).join('\n');
  return {
    ok: true,
    ...(text ? { text } : {}),
    ...(result.screenshot ? { screenshot: result.screenshot } : {}),
    ...(result.tab !== undefined ? { tab: result.tab } : {})
  };
}
