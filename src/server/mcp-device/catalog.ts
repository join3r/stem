import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { log } from '../log';
import { piMcpDeviceCatalogPath } from '../workspace/paths';
import type {
  DeviceMcpAnnouncement,
  DeviceMcpCatalog,
  DeviceMcpServerReport,
  DeviceMcpTool
} from '../../shared/types';

// What each device says it is hosting, remembered across the moment it goes away.
//
// This file is the whole of decision ③: availability is "has an open stream",
// evaluated per turn, with no handshake — which only works if what the device
// CAN do is known independently of whether it is up right now. So the catalog is
// stored here, on the server, and a sleeping Mac's tools stay in the assistant's
// context marked unavailable instead of quietly disappearing from what it knows
// it can do.
//
// Nothing here is trusted. A device writes its own entry, and what it writes is
// rendered into a model's prompt on later turns, so every string that arrives is
// bounded and every list is capped before it reaches the disk — see normalize().

/** How the catalog is read and written; injected so the router can be tested. */
export interface DeviceMcpCatalogStore {
  read(): Promise<DeviceMcpCatalog>;
  write(next: DeviceMcpCatalog): Promise<void>;
}

/** An empty catalog — a missing or unreadable file, and the shape of a fresh one. */
export function emptyCatalog(): DeviceMcpCatalog {
  return { version: 1, devices: {} };
}

/**
 * Caps on what one device may announce.
 *
 * These are not defences against a hostile client — a paired device is already
 * trusted with far more than this — they are what keeps one misconfigured MCP
 * server from eating the context window of every turn from now on. A server
 * exposing four hundred tools is a real thing that exists, and the failure it
 * causes (a prompt so large the model has no room to answer) is one nobody
 * connects back to a checkbox they ticked last week.
 */
const MAX_SERVERS = 64;
const MAX_TOOLS = 200;
const MAX_NAME = 200;
const MAX_TEXT = 2_000;

function clip(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function normalizeTool(raw: unknown): DeviceMcpTool | null {
  if (!raw || typeof raw !== 'object') return null;
  const tool = raw as Partial<DeviceMcpTool>;
  const name = clip(tool.name, MAX_NAME);
  if (!name) return null;
  const description = clip(tool.description, MAX_TEXT);
  const signature = clip(tool.signature, MAX_TEXT);
  return {
    name,
    ...(description ? { description } : {}),
    ...(signature ? { signature } : {})
  };
}

function normalizeServer(raw: unknown): DeviceMcpServerReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const server = raw as Partial<DeviceMcpServerReport>;
  const name = clip(server.name, MAX_NAME);
  if (!name) return null;
  // An unrecognized status reads as `failed` rather than being dropped: a server
  // whose state we cannot name is one the assistant must not be told is ready.
  const status =
    server.status === 'ready' || server.status === 'unapproved' ? server.status : 'failed';
  const tools = Array.isArray(server.tools)
    ? server.tools.slice(0, MAX_TOOLS).map(normalizeTool).filter((t): t is DeviceMcpTool => !!t)
    : [];
  const error = clip(server.error, MAX_TEXT);
  const fingerprint = clip(server.fingerprint, MAX_NAME);
  return {
    name,
    status,
    ...(error ? { error } : {}),
    ...(fingerprint ? { fingerprint } : {}),
    ...(tools.length > 0 ? { tools } : {})
  };
}

/**
 * One announcement, reduced to what may be stored. Whatever arrived that this
 * does not recognize is dropped rather than kept "just in case": the file is
 * read back into a prompt, and a field nobody renders is a field nobody is
 * checking the size of.
 */
export function normalizeAnnouncement(raw: unknown): DeviceMcpAnnouncement {
  const servers = (raw as Partial<DeviceMcpAnnouncement> | null)?.servers;
  if (!Array.isArray(servers)) return { servers: [] };
  return {
    servers: servers
      .slice(0, MAX_SERVERS)
      .map(normalizeServer)
      .filter((s): s is DeviceMcpServerReport => !!s)
  };
}

// ---- rendering the catalog into a turn's context (③) ----

/** What rendering one turn's device block needs to know, all of it per-turn. */
export interface DeviceCatalogRenderDeps {
  /**
   * Whether that machine could be sent work THIS INSTANT. Asked while the block
   * is being rendered and never remembered: "evaluated per turn, with no
   * handshake" is the whole of ③, and a value baked in when pi started would be
   * a claim about a laptop lid that closed an hour ago.
   */
  isAvailable(deviceId: string): boolean;
  /** How to name that machine to the assistant; the id when nothing better exists. */
  label(deviceId: string): string;
  /** Whether this server is still one the assistant may call (pinned, enabled). */
  include(deviceId: string, server: string): boolean;
}

export interface DeviceCatalogBlock {
  /** `### server` sections in the bridge catalog's own shape; '' when empty. */
  text: string;
  /** Whether anything listed is on a machine that cannot be reached right now. */
  anyAway: boolean;
}

/** One tool, in the same line shape the bridge's own catalog uses. */
function toolLine(tool: DeviceMcpTool): string {
  const tail = [tool.description, tool.signature].filter(Boolean).join(' — ');
  return tail ? `  - ${tool.name}: ${tail}` : `  - ${tool.name}`;
}

/**
 * What to say about a server beyond where it lives, or '' when there is nothing
 * to add. Being on another machine is not a caveat; being unable to reach that
 * machine is.
 *
 * Unreachable wins over anything the machine last reported about the server
 * itself: that report is from before it went away, and the actionable sentence
 * is about the computer, not the program.
 */
function condition(report: DeviceMcpServerReport, available: boolean): string {
  if (!available) return ', which is NOT connected right now';
  if (report.status === 'unapproved') return ', where nobody has approved it to run yet';
  if (report.status === 'failed') {
    return report.error ? `, where it is not running: ${report.error}` : ', where it is not running';
  }
  return '';
}

/**
 * The device half of the per-turn tool catalog: every server the user's own
 * machines have announced, whether or not those machines are up.
 *
 * A server whose machine is asleep is listed WITH its tools and marked, rather
 * than dropped. That is decision ③ in one behaviour: the assistant that can see
 * the capability can say "I can do that once your Mac is awake", and the one
 * that cannot see it says "I can't do that at all" — which is false, and which
 * the user has no way to argue with.
 *
 * A server with no known tools is skipped: this block exists to say what can be
 * called, and a section with nothing under it says only that a name exists.
 */
export function renderDeviceCatalogBlock(
  catalog: DeviceMcpCatalog,
  deps: DeviceCatalogRenderDeps
): DeviceCatalogBlock {
  const sections: string[] = [];
  let anyAway = false;
  // Sorted by the name the user sees, so the block is byte-identical from turn
  // to turn while nothing changes — the prompt cache is worth more than the
  // insertion order of a JSON object.
  const entries = Object.values(catalog.devices).sort((a, b) =>
    deps.label(a.deviceId).localeCompare(deps.label(b.deviceId))
  );
  for (const entry of entries) {
    const available = deps.isAvailable(entry.deviceId);
    const place = `“${deps.label(entry.deviceId)}”`;
    for (const report of entry.servers) {
      if (!deps.include(entry.deviceId, report.name)) continue;
      const tools = report.tools ?? [];
      if (tools.length === 0) continue;
      if (!available) anyAway = true;
      const count = `${tools.length} tool${tools.length === 1 ? '' : 's'}`;
      sections.push(
        `### ${report.name} (${count}) — runs on ${place}${condition(report, available)}\n` +
          tools.map(toolLine).join('\n')
      );
    }
  }
  return { text: sections.join('\n\n'), anyAway };
}

/** The catalog as it is on disk, or an empty one when it is missing or corrupt. */
async function readCatalogFile(): Promise<DeviceMcpCatalog> {
  let raw: string;
  try {
    raw = await readFile(piMcpDeviceCatalogPath(), 'utf8');
  } catch {
    // quiet: absent until the first device announces what it hosts. A catalog
    // that is there and unreadable is a different thing, and the parse below
    // says so.
    return emptyCatalog();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DeviceMcpCatalog>;
    if (!parsed?.devices || typeof parsed.devices !== 'object') return emptyCatalog();
    return { version: 1, devices: parsed.devices };
  } catch {
    // Unlike mcp.json, losing this costs nothing anybody typed: every device
    // re-announces when it next connects, and until then the honest answer is
    // that we do not know what it hosts. So no `.corrupt` sibling and no throw.
    log('mcp-device', 'the device catalog is unreadable; starting from empty');
    return emptyCatalog();
  }
}

async function writeCatalogFile(next: DeviceMcpCatalog): Promise<void> {
  const path = piMcpDeviceCatalogPath();
  await mkdir(dirname(path), { recursive: true });
  // Temp-then-rename, like every other file under the pi home: a force-quit
  // mid-write can leave a stray `.tmp` but never a half-written catalog that
  // reads back as corrupt on the next boot.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    await rename(tmp, path);
  } finally {
    // quiet: after a successful rename there is nothing left to remove, and after a
    // failed write the error from the try is the one worth having — a stray `.tmp`
    // beside the catalog is the same litter a force-quit leaves and never read.
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * The real store. Reads and writes are serialized through one tail: announcements
 * from two devices can land in the same tick, and read-modify-write on a whole
 * file is exactly the shape that loses one of them.
 */
export function fileCatalogStore(): DeviceMcpCatalogStore {
  let tail: Promise<unknown> = Promise.resolve();
  const queue = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    // quiet: `next` is what the caller awaits and it keeps the rejection; this copy
    // exists only so a failed read does not leave the tail rejected — which would
    // both unhandled-reject and be re-thrown at whoever queues next.
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    read: () => queue(readCatalogFile),
    write: (next) => queue(() => writeCatalogFile(next))
  };
}
