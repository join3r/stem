import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { host } from './host';
import { DEFAULT_KEY_FILE, readPassphraseFile } from './host/passphrase-key';
import { startServer } from './index';
import { systemVersion } from './sys-version';
import { formatSystemVersion } from '../shared/sys-version';
import { readDevices } from './transport/auth';
import { createPairingCode } from './transport/pairing';
import { exportState, importState } from './workspace/state-transfer';

// `stem-server`: Stem with no windows, run by plain `node`.
//
// Everything interesting is in ./index.ts — this file is only the process. It
// resolves the one thing a host has to decide (where state lives), starts the
// server, prints where it is listening, and translates SIGINT/SIGTERM into a
// graceful shutdown.
//
// It also carries the two subcommands a headless deployment cannot do without:
//
//   stem-server pair [--label "Vlado's MacBook"]
//
// which prints a one-shot code a device can spend on POST /pair. It runs WITHOUT
// starting a server — it only writes to the pairing store — so it is safe to run
// as `docker compose exec stem node dist/main/server.js pair` beside a container
// that is already serving.
//
//   stem-server import <archive.tar> [--key-file <path>]
//   stem-server export <archive.tar> [--key-file <path>]
//
// which unpack and write the archive Settings → Server → "Move or back up this
// Stem" produces — the other half of the migration, and both halves of the
// backup. `export` is here as well as in the app because a server that is not
// somebody's laptop still has to be backed up, and once it is here the round trip
// is one process to the next with nothing in between (which is how
// scripts/server-boot.mjs tests it). Unlike `pair`, both must run with NOTHING
// serving: import refuses a state root that has been used, and either way a
// running server is writing to the very files being read or replaced.
//
// Its real job is to be the tripwire. `src/server` must not import Electron,
// and an ESLint rule is not proof of that: a transitive import through a barrel
// file satisfies every static rule anybody writes and still resolves at runtime
// because the desktop bundle happens to have Electron underneath it. A process
// with no `electron` module to resolve is proof. That is why scripts/server-boot.mjs
// runs this entry in CI on every push, and why this file exists from day one
// rather than when somebody first wants to deploy it (see the Phase 1 plan,
// step 5).
//
// Phase 1 puts this process on the same machine as the desktop that talks to it,
// sharing one state root. No TLS, no remote host, no service manager — those are
// Phase 2, and the loopback-only bind in transport/server.ts is what keeps this
// from being deployed as if they had already happened.

/** `--label "…"` or `--label=…`; the device's name in Settings → Server → Devices. */
function labelArg(argv: string[]): string {
  const inline = argv.find((a) => a.startsWith('--label='));
  if (inline) return inline.slice('--label='.length);
  const flag = argv.indexOf('--label');
  return flag !== -1 ? (argv[flag + 1] ?? '') : '';
}

/** Print a pairing code and say how long it lives. Shared by the subcommand and first boot. */
async function printPairingCode(label: string, why: string): Promise<void> {
  const { code, expiresAt } = await createPairingCode(label);
  const minutes = Math.max(1, Math.round((Date.parse(expiresAt) - Date.now()) / 60_000));
  console.log(`\n[stem-server] ${why}`);
  console.log(`[stem-server] pairing code: ${code}`);
  console.log(`[stem-server] valid for ${minutes} minutes, one device, one use.\n`);
}

async function pairCommand(): Promise<void> {
  console.log(`[stem-server] state ${host().stateRoot()}`);
  await printPairingCode(labelArg(process.argv.slice(3)), 'enter this on the device you are pairing:');
}

/** `--key-file <path>` / `--key-file=<path>`, or null when it wasn't given. */
function flagValue(argv: string[], name: string): string | null {
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const at = argv.indexOf(`--${name}`);
  return at !== -1 ? (argv[at + 1] ?? null) : null;
}

/**
 * Ask for the passphrase on the terminal, with the echo off.
 *
 * There is deliberately no `--passphrase <value>`. A secret passed as an argument
 * is in the shell history of whoever ran it, in `ps` for everybody on the box
 * while it runs, and in the CI log of any pipeline that ever calls this — three
 * places it can never be taken back out of. A file (`--key-file`, which is also
 * the Docker secret) or a prompt are the only two ways in.
 */
function promptPassphrase(): Promise<string> {
  if (!process.stdin.isTTY) {
    return Promise.reject(
      new Error(
        'No terminal to ask on. Pass --key-file <path> with the passphrase in it — the same file the ' +
          'container will hold as its secret.'
      )
    );
  }
  return new Promise<string>((accept, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // readline echoes what it reads; muting the output stream for the duration is
    // the standard way to stop it, and the prompt itself is written before the mute.
    process.stdout.write('[stem-server] passphrase for this archive: ');
    const out = rl as unknown as { output: NodeJS.WriteStream; _writeToOutput: (s: string) => void };
    out._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      accept(answer);
    });
    rl.on('error', reject);
  });
}

/**
 * Where the passphrase comes from, in the order a person would expect: the file
 * they named, the file the deployment mounts, and only then the terminal.
 */
async function resolvePassphrase(argv: string[]): Promise<string> {
  const named = flagValue(argv, 'key-file') ?? process.env.STEM_KEY_FILE ?? null;
  if (named) {
    if (!existsSync(named)) throw new Error(`No key file at ${named}.`);
    return readPassphraseFile(named);
  }
  if (existsSync(DEFAULT_KEY_FILE)) {
    console.log(`[stem-server] using the passphrase in ${DEFAULT_KEY_FILE}`);
    return readPassphraseFile(DEFAULT_KEY_FILE);
  }
  return promptPassphrase();
}

/** One `- ` bullet per line, wrapped so a terminal can read it. */
function bullets(lines: string[]): void {
  for (const line of lines) console.log(`  - ${line}`);
}

function megabytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function exportCommand(): Promise<void> {
  const argv = process.argv.slice(3);
  const out = argv.find((a) => !a.startsWith('--'));
  if (!out) throw new Error('Usage: stem-server export <archive.tar> [--key-file <path>]');
  const path = resolve(out);
  // Never over an existing file. This writes a backup; overwriting the previous
  // one because a path was retyped is the failure mode that only shows up on the
  // day the backup is needed.
  if (existsSync(path)) throw new Error(`${path} already exists. Pick a name that doesn't.`);
  console.log(`[stem-server] state ${host().stateRoot()}`);

  const passphrase = await resolvePassphrase(argv);
  const report = await exportState({ out: path, passphrase });

  console.log(`\n[stem-server] wrote ${report.files} files (${megabytes(report.bytes)}) to ${report.path}`);
  for (const group of report.included) {
    console.log(`  ${group.name.padEnd(24)} ${String(group.files).padStart(6)} files  ${megabytes(group.bytes)}`);
  }
  console.log('\n[stem-server] left behind on purpose:');
  bullets(report.omitted.map((o) => `${o.name}. ${o.reason}`));
  console.log(
    '\n[stem-server] the archive is not encrypted — it holds your chats, your memory and your ' +
      'credentials. Move it over ssh and keep it somewhere you would keep a password.\n'
  );
}

async function importCommand(): Promise<void> {
  const argv = process.argv.slice(3);
  const archive = argv.find((a) => !a.startsWith('--'));
  if (!archive) {
    throw new Error('Usage: stem-server import <archive.tar> [--key-file <path>]');
  }
  const path = resolve(archive);
  if (!existsSync(path)) throw new Error(`No archive at ${path}.`);
  console.log(`[stem-server] state ${host().stateRoot()}`);

  const passphrase = await resolvePassphrase(argv);
  const report = await importState({ archive: path, passphrase });

  console.log(`\n[stem-server] imported ${report.files} files (${megabytes(report.bytes)}) into ${report.stateRoot}`);
  console.log(`[stem-server] from Stem ${report.from.app} on ${report.from.platform}, exported ${report.from.exportedAt}`);
  for (const group of report.landed) {
    console.log(`  ${group.name.padEnd(24)} ${String(group.files).padStart(6)} files  ${megabytes(group.bytes)}`);
  }
  if (report.reauthorize.length) {
    console.log('\n[stem-server] accounts and connections:');
    bullets(report.reauthorize);
  }
  if (report.attention.length) {
    console.log('\n[stem-server] needs your attention:');
    bullets(report.attention);
  }
  console.log('\n[stem-server] start the server when you are ready.\n');
}

async function main(): Promise<void> {
  // Registered BEFORE startServer, which is load-bearing twice over: the host
  // shim defers its own signal handling to whoever got there first (see
  // headlessHost.onShutdown), and a Ctrl-C during a slow boot would otherwise
  // find no handler at all and leave a half-started backend behind.
  let stopping: Promise<void> | null = null;
  const stop = (signal: string, shutdown: () => Promise<void>): void => {
    if (stopping) return; // a second Ctrl-C while draining
    console.log(`[stem-server] ${signal} — shutting down`);
    stopping = shutdown()
      .catch((err: unknown) => {
        console.error('[stem-server] shutdown failed:', err);
      })
      .then(() => {
        process.exit(0);
      });
  };
  // Until startServer resolves there is nothing to drain, but the signal still
  // has to be answered — a listener that does nothing would hang the process.
  let shutdown = async (): Promise<void> => {};
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => stop(signal, () => shutdown()));
  }

  const stateRoot = host().stateRoot();
  console.log(`[stem-server] state ${stateRoot}`);

  const handle = await startServer({
    // Alternate profiles are a desktop affordance (`--fresh` / `--profile`);
    // headless, the state root IS the profile and STEM_STATE_DIR picks it.
    alternateProfile: false,
    // No Vite dev server behind a standalone run, and nothing to serve either:
    // the transport has no static route since the web client was removed.
    devUrl: null
  });
  shutdown = () => handle.shutdown();

  // The one line a supervisor, a test, or a person needs. Printed on stdout
  // rather than logged, because it is this process's interface: scripts/server-boot.mjs
  // and the external-server E2E harness both wait for it. In the container it
  // names a socket rather than a URL — `unix:` in front, so nothing that reads
  // this line can mistake a path for something it could dial.
  console.log(`[stem-server] listening on ${handle.endpoint.url ?? `unix:${handle.endpoint.socket}`}`);
  // The version of the persona / skills / memory programming this process
  // stamps on every mail and turn — compare with `node scripts/sys-version.mjs`
  // on a checkout to know whether the server runs the code you are reading.
  console.log(`[stem-server] system ${formatSystemVersion(systemVersion())}`);

  // Nothing can talk to a server with an empty registry, and there is no window
  // here to ask in — so a first boot says how to get in without being asked.
  // Harmless on a machine whose desktop is about to mint itself a record off the
  // shared state root: the code simply expires unused.
  if ((await readDevices()).length === 0) {
    await printPairingCode('Paired device', 'no devices are paired yet. To connect one:');
  }

  // Spawn pi and connect MCP now. The desktop defers this until its first window
  // has painted; there is no window here, so there is nothing to defer behind.
  void handle.prewarm();
}

const command = process.argv[2];
const SUBCOMMANDS: Record<string, { run: () => Promise<void>; whenItFails: string }> = {
  pair: { run: pairCommand, whenItFails: 'could not create a pairing code' },
  export: { run: exportCommand, whenItFails: 'could not export' },
  import: { run: importCommand, whenItFails: 'could not import' }
};
const subcommand = SUBCOMMANDS[command ?? ''];

(subcommand ? subcommand.run() : main()).catch((err: unknown) => {
  // A subcommand's failures are things a person did (a wrong passphrase, a state
  // root with chats in it), so they get the message and not the stack — the stack
  // would bury the one line that says what to do instead.
  const message = String((err as Error)?.message ?? err);
  if (subcommand) console.error(`\n[stem-server] ${subcommand.whenItFails}: ${message}\n`);
  else console.error('[stem-server] failed to start:', err);
  process.exit(1);
});
