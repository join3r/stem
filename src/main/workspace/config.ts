import { readFile, writeFile } from 'node:fs/promises';
import TOML from '@iarna/toml';
import { codexConfigPath } from './paths';

// Codex may normalize/rewrite config.toml on startup, so we always read fresh
// from disk and write the whole document back via a round-trip-safe TOML lib.

export type CodexConfig = Record<string, unknown> & {
  features?: { memories?: boolean };
  memories?: { use_memories?: boolean; generate_memories?: boolean };
  mcp_servers?: Record<string, { command?: string; args?: string[]; url?: string; env?: Record<string, string> }>;
};

export async function readConfig(): Promise<CodexConfig> {
  try {
    const text = await readFile(codexConfigPath(), 'utf8');
    return TOML.parse(text) as CodexConfig;
  } catch {
    return {};
  }
}

export async function writeConfig(config: CodexConfig): Promise<void> {
  const text = TOML.stringify(config as TOML.JsonMap);
  await writeFile(codexConfigPath(), text, 'utf8');
}

/** Read, mutate, write back. Returns the updated config. */
export async function updateConfig(mutate: (config: CodexConfig) => void): Promise<CodexConfig> {
  const config = await readConfig();
  mutate(config);
  await writeConfig(config);
  return config;
}
