// Point the Stem-owned stores at throwaway paths BEFORE any module under test is
// imported (setup files run first), and wipe them so every run starts clean. The
// store modules read these env vars instead of the host's state root — the same
// seam the old scripts/*-verify.mjs probes used.
//
// STEM_STATE_DIR covers everything without its own override: the server modules
// resolve it through src/server/host, whose headless default would otherwise
// land on the developer's REAL Stem profile.
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setHost } from '../src/server/host';

const recallDb = join(tmpdir(), `stem-recall-${process.pid}.sqlite`);
const filesDir = join(tmpdir(), `stem-files-${process.pid}`, 'files');
const chatSearchDb = join(tmpdir(), `stem-chat-search-${process.pid}.sqlite`);
const mcpConfig = join(tmpdir(), `stem-mcp-config-${process.pid}.json`);
const mcpOAuth = join(tmpdir(), `stem-mcp-oauth-${process.pid}.json`);
const secretKey = join(tmpdir(), `stem-secret-key-${process.pid}.bin`);
const logFile = join(tmpdir(), `stem-log-${process.pid}.log`);
const connectedFoldersStore = join(tmpdir(), `stem-cfolders-${process.pid}.json`);
const folderIndexDir = join(tmpdir(), `stem-folder-index-${process.pid}`);
const devicesStore = join(tmpdir(), `stem-devices-${process.pid}.json`);
const pairingStore = join(tmpdir(), `stem-pairing-${process.pid}.json`);
const clientStore = join(tmpdir(), `stem-client-${process.pid}.json`);
const chatCacheDb = join(tmpdir(), `stem-chat-cache-${process.pid}.sqlite`);
const chatPinsDb = join(tmpdir(), `stem-chat-pins-${process.pid}.sqlite`);
const stateDir = join(tmpdir(), `stem-state-${process.pid}`);

process.env.STEM_RECALL_DB = recallDb;
process.env.STEM_FILES_DIR = filesDir;
process.env.STEM_CHAT_SEARCH_DB = chatSearchDb;
process.env.STEM_PI_MCP_CONFIG = mcpConfig;
process.env.STEM_PI_MCP_OAUTH = mcpOAuth;
process.env.STEM_SECRET_KEY_FILE = secretKey;
process.env.STEM_LOG_FILE = logFile;
process.env.STEM_CONNECTED_FOLDERS_STORE = connectedFoldersStore;
process.env.STEM_FOLDER_INDEX_DIR = folderIndexDir;
process.env.STEM_DEVICES_FILE = devicesStore;
process.env.STEM_PAIRING_FILE = pairingStore;
process.env.STEM_CLIENT_FILE = clientStore;
process.env.STEM_CHAT_CACHE_FILE = chatCacheDb;
process.env.STEM_CHAT_PINS_DB = chatPinsDb;
process.env.STEM_STATE_DIR = stateDir;

for (const p of [recallDb, `${recallDb}-wal`, `${recallDb}-shm`]) {
  rmSync(p, { force: true });
}
for (const p of [chatSearchDb, `${chatSearchDb}-wal`, `${chatSearchDb}-shm`]) {
  rmSync(p, { force: true });
}
for (const p of [chatPinsDb, `${chatPinsDb}-wal`, `${chatPinsDb}-shm`]) {
  rmSync(p, { force: true });
}
for (const p of [chatCacheDb, `${chatCacheDb}-wal`, `${chatCacheDb}-shm`]) {
  rmSync(p, { force: true });
}
for (const p of [mcpConfig, mcpOAuth, secretKey, logFile, connectedFoldersStore, devicesStore, pairingStore, clientStore]) {
  rmSync(p, { force: true });
}
rmSync(join(tmpdir(), `stem-files-${process.pid}`), { recursive: true, force: true });
rmSync(folderIndexDir, { recursive: true, force: true });
rmSync(stateDir, { recursive: true, force: true });

// Reversible stand-in for the platform key wrapper: the real one wraps through
// the OS keychain, which no CI box has. Tagging the plaintext keeps the full
// encrypted-at-rest code path (key wrap/unwrap, envelope files, field
// ciphertexts) under test and deterministic — what tests/electron-stub.ts's
// safeStorage fake used to do, now expressed against the host shim.
setHost({
  // What the electron stub's app.getVersion() reported; release-notes tests
  // assert against it rather than tracking package.json.
  appVersion: () => '0.0.0',
  keyWrapper: () => ({
    wrap: (plain: string) => Buffer.from(`stub-wrapped:${plain}`, 'utf8'),
    unwrap: (wrapped: Buffer) => {
      const text = wrapped.toString('utf8');
      if (!text.startsWith('stub-wrapped:')) throw new Error('not stub-wrapped ciphertext');
      return text.slice('stub-wrapped:'.length);
    }
  })
});
