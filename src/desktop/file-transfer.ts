import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { MAX_UPLOAD_BYTES } from '../server/transport/server';
import type { ServerCredentials } from './server-endpoint';

// Files, in both directions, over the same socket everything else uses.
//
// The rest of the client's traffic is JSON on POST /rpc. A file is the exception,
// and it is an exception for one reason: it has no size limit worth designing
// around. Base64 inside an RPC envelope would mean a 40 MB video had to fit in a
// JSON body, be held whole in memory on both sides, and be parsed as a string —
// so instead the bytes go up on their own request (POST /upload) and come back on
// their own response (GET /files/<rel>), and neither side ever holds the file.
//
// Nothing here is used when the server shares this disk. An embedded server can
// simply read `att.path`, and making a local screenshot paste pay a copy through
// loopback to prove a point would be a real cost for no benefit; the "am I
// remote" branch is in proxy.ts, deliberately narrow, and this file is what is on
// the far side of it. Downloading is the one exception — it always comes down the
// socket, because a Download button is a thing the user pressed once, not a thing
// that happens on every keystroke.

/** Node's http/https `request` differ only in which module they come from. */
function open(url: URL, options: Parameters<typeof httpRequest>[1]): ClientRequest {
  return (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, options);
}

/** Wait for the response, preferring it to a socket error it may have caused. */
function response(req: ClientRequest): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    let answered = false;
    req.on('response', (res) => {
      answered = true;
      resolve(res);
    });
    // A server that refuses a body mid-upload answers and then hangs up, which
    // reaches us as EPIPE on the write side. The answer is the useful half.
    req.on('error', (e) => {
      if (!answered) reject(e);
    });
  });
}

/** The whole response as text. Only ever used on the small JSON answers. */
async function readBody(res: IncomingMessage): Promise<string> {
  res.setEncoding('utf8');
  let text = '';
  for await (const chunk of res) text += chunk as string;
  return text;
}

/** The server's own words for what went wrong, or a status line if it had none. */
function problemIn(text: string, fallback: string): string {
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Not JSON — a proxy in front of the server can answer in HTML.
  }
  return fallback;
}

/**
 * Stream `path` to the server and return the handle that stands for it there.
 * Throws with a sentence naming the file: an attachment that silently failed to
 * upload would send a message that quietly wasn't about the thing the user
 * attached, which is worse than not sending it at all.
 */
export async function uploadFile(creds: ServerCredentials, path: string): Promise<string> {
  const name = basename(path);
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new Error(`“${name}” could not be read from this computer.`);
  }
  return upload(creds, name, size, (req) => {
    // A read error on this side must not leave the request hanging open forever.
    const body = createReadStream(path);
    body.on('error', (e) => req.destroy(e));
    body.pipe(req);
  });
}

/**
 * Same contract for bytes already in memory. The caller is a HEIC the client
 * just decoded to JPEG: there is no on-disk file to stream, and the decoded
 * photo is too big to ride inside the RPC envelope (see the note at the top).
 */
export async function uploadBytes(creds: ServerCredentials, name: string, bytes: Buffer): Promise<string> {
  return upload(creds, name, bytes.length, (req) => req.end(bytes));
}

async function upload(
  creds: ServerCredentials,
  name: string,
  size: number,
  send: (req: ClientRequest) => void
): Promise<string> {
  // Checked here as well as at the server so the common case of one file that is
  // simply too big says so immediately, without spending the upload first.
  if (size > MAX_UPLOAD_BYTES) {
    throw new Error(
      `“${name}” is too large to send to Stem's server (the limit is ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB).`
    );
  }

  const url = new URL(`${creds.url.replace(/\/$/, '')}/upload`);
  url.searchParams.set('name', name);
  const req = open(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${creds.token}`,
      'content-type': 'application/octet-stream',
      'content-length': size
    }
  });
  const answered = response(req);
  send(req);

  let res: IncomingMessage;
  try {
    res = await answered;
  } catch (e) {
    throw new Error(`“${name}” could not be sent to Stem's server: ${String((e as Error)?.message ?? e)}`);
  }
  const text = await readBody(res);
  if (res.statusCode !== 200) {
    throw new Error(`“${name}” could not be sent to Stem's server: ${problemIn(text, `HTTP ${res.statusCode}`)}`);
  }
  let handle: unknown;
  try {
    handle = (JSON.parse(text) as { result?: { handle?: unknown } })?.result?.handle;
  } catch {
    handle = null;
  }
  if (typeof handle !== 'string' || !handle) {
    throw new Error(`“${name}” was sent to Stem's server, but it did not say where it put it.`);
  }
  return handle;
}

/** Each segment encoded on its own, so the slashes in `rel` stay slashes. */
function encodeRelPath(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/**
 * Reserve a name in `dir` without a check-then-write race: 'wx' makes creating
 * the file and finding out it already existed one operation, so two downloads of
 * the same name land as `cake.pdf` and `cake-1.pdf` rather than one overwriting
 * the other (the same trick files/store.ts uses with COPYFILE_EXCL).
 */
async function reserve(dir: string, name: string): Promise<{ path: string; out: WriteStream }> {
  const ext = extname(name);
  const stem = basename(name, ext);
  for (let i = 0; ; i++) {
    const candidate = join(dir, i === 0 ? name : `${stem}-${i}${ext}`);
    const out = createWriteStream(candidate, { flags: 'wx' });
    try {
      await once(out, 'open');
      return { path: candidate, out };
    } catch (e) {
      out.destroy();
      if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw e;
    }
  }
}

/**
 * Fetch one file from the server's Files folder into `destDir`, and answer with
 * where it landed. A failure part way through takes the partial file with it —
 * half a document in the Downloads folder, named as though it were whole, is the
 * one outcome worth going out of the way to prevent.
 */
export async function downloadFile(
  creds: ServerCredentials,
  rel: string,
  destDir: string
): Promise<string> {
  const url = new URL(`${creds.url.replace(/\/$/, '')}/files/${encodeRelPath(rel)}`);
  const req = open(url, { method: 'GET', headers: { authorization: `Bearer ${creds.token}` } });
  const answered = response(req);
  req.end();

  const name = basename(rel) || 'download';
  let res: IncomingMessage;
  try {
    res = await answered;
  } catch (e) {
    throw new Error(`“${name}” could not be fetched from Stem's server: ${String((e as Error)?.message ?? e)}`);
  }
  if (res.statusCode !== 200) {
    const problem = problemIn(await readBody(res), `HTTP ${res.statusCode}`);
    throw new Error(`“${name}” could not be fetched from Stem's server: ${problem}`);
  }

  await mkdir(destDir, { recursive: true });
  const { path, out } = await reserve(destDir, name);
  try {
    await pipeline(res, out);
  } catch (e) {
    await rm(path, { force: true }).catch(() => undefined);
    throw new Error(`“${name}” did not finish downloading: ${String((e as Error)?.message ?? e)}`);
  }
  return path;
}
