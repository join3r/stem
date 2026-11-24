// Where a command-started MCP server may live. Shared by the bridge's
// add_mcp_server / edit_mcp_server (which answers the model with the reason) and
// main's apply step (which refuses the same thing if the bridge is older).
//
// The Fio incident (2026-11-17): the assistant built an MCP server and pointed
// mcp.json at it inside the user's Files place; the user tidied Files and the
// server was gone ("fio exited"). The repair it then started built the next one
// in the chat's own scratch folder, which is deleted with the chat. Neither
// place outlives what the server needs to, so neither may hold one; servers the
// assistant installs belong under the install root (state/tools/<name>).

import { isAbsolute, resolve, sep } from 'node:path';

/**
 * The path a token names, or null for a plain word. A flag carrying its value
 * (`--dir=/x`) names the value. A relative token counts only when it has a
 * separator (`files/fio/launch.mjs`, not `uvx`), and resolves against `cwd`,
 * the folder the bridge starts servers in.
 */
function pathOf(token, cwd) {
  const t = String(token || '').trim();
  if (!t) return null;
  const eq = t.startsWith('-') ? t.indexOf('=') : -1;
  const value = eq >= 0 ? t.slice(eq + 1) : t;
  if (!value) return null;
  if (isAbsolute(value)) return resolve(value);
  if (!cwd || !/[\\/]/.test(value) || value.startsWith('@')) return null;
  return resolve(cwd, value);
}

function inside(path, root) {
  const r = resolve(root);
  return path === r || path.startsWith(r.endsWith(sep) ? r : r + sep);
}

/**
 * The first path in `command` or `args` that lies in one of `roots`
 * ({ root, kind }), as { path, kind }, or null.
 */
export function shortLivedServerPath(command, args, roots, cwd) {
  const tokens = [command, ...(Array.isArray(args) ? args : [])];
  for (const token of tokens) {
    const path = pathOf(token, cwd);
    if (!path) continue;
    for (const { root, kind } of roots || []) {
      if (root && inside(path, root)) return { path, kind };
    }
  }
  return null;
}

/** The sentence the model (or the approval error) reads when a path is refused. */
export function shortLivedServerMessage(hit, installRoot, name) {
  const where =
    hit.kind === 'scratch'
      ? "a chat's scratch folder, which is deleted together with that chat"
      : "the user's Files place, which the user tidies by hand";
  const target = installRoot ? `${resolve(installRoot)}${sep}${name || '<server-name>'}` : 'a folder of its own outside chat scratch and Files';
  return (
    `${hit.path} is in ${where}, so the server would stop working when that folder goes. ` +
    `Install the server under ${target} (copy or build the finished release there with run_command) and point the command and args at that copy.`
  );
}
