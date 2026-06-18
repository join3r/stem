import { execFile } from 'node:child_process';
import { findCodexPath } from './locate';

// Shared helpers for running one-shot `codex` commands against the app's
// isolated CODEX_HOME. Mirrors the env-sanitizing the long-lived runtime does
// (force ChatGPT subscription auth by dropping API-key vars).

/** Sanitized env: strip API-key vars, pin the isolated CODEX_HOME. */
export function codexEnv(codexHome: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  env.CODEX_HOME = codexHome;
  return env;
}

/** Run a codex subcommand and parse its stdout as JSON. Throws on any failure. */
export async function runCodexJson<T>(args: string[], codexHome: string): Promise<T> {
  const codexPath = await findCodexPath();
  if (!codexPath) {
    throw new Error('codex was not found on PATH.');
  }
  return new Promise<T>((resolve, reject) => {
    execFile(codexPath, args, { env: codexEnv(codexHome), timeout: 8000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch {
        reject(new Error(`Could not parse JSON from \`codex ${args.join(' ')}\`.`));
      }
    });
  });
}
