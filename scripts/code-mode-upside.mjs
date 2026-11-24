// How much would "code mode" (the model writes one script that calls MCP tools,
// instead of one tool call per model round trip) save on real Stem sessions?
//
// Reads pi's session JSONL and counts the two things a script could improve:
//   1. chains: runs of MCP calls in one turn with no other tool between them.
//      A run spread over N assistant messages costs N model round trips; a
//      script would cost one, so the saving is N-1 per run.
//   2. big results: MCP results large enough that filtering them in a script
//      before they reach the context would matter (and the ones the 100k cap
//      already cut).
//
// It prints counts, sizes and tool names only, never message or result text,
// so the output is safe to paste. No dependencies: it can be piped into the
// server container as is.
//
//   node scripts/code-mode-upside.mjs [sessionsDir] [--days=N]
//   STEM_SESSIONS_DIR=/path/to/sessions node scripts/code-mode-upside.mjs
//   ssh host 'cd ~/services/stem && docker compose exec -T stem \
//     node --input-type=module - /var/lib/stem/state/pi-home/sessions' < scripts/code-mode-upside.mjs
//
// What it cannot see: whether the model needed to read result k before it could
// write call k+1. A chain is therefore an upper bound on what one script could
// have covered. The read-only split is a guess from the tool's name.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CHAIN_MIN = 3; // calls in a row before a script beats plain tool calls
const BIG_RESULT_CHARS = 20_000; // ~5k tokens: worth filtering before it lands
const TRUNCATION_MARK = '[Result truncated: the tool returned'; // capToolContent's notice
const DISCOVERY = new Set(['find_tools', 'describe_tool']);
const READ_VERB = /^(get|list|search|read|find|query|fetch|describe|show|view|lookup|check|count|export|download|whoami|status)/i;

const args = process.argv.slice(2);
const daysArg = args.find((a) => a.startsWith('--days='));
const days = daysArg ? Number(daysArg.slice('--days='.length)) : 0;
const dirArg = args.find((a) => !a.startsWith('--'));

function resolveSessionsDir() {
  const candidates = dirArg
    ? [dirArg]
    : process.env.STEM_SESSIONS_DIR
      ? [process.env.STEM_SESSIONS_DIR]
      : [
          '/var/lib/stem/state/pi-home/sessions',
          join(homedir(), 'Library', 'Application Support', 'Stem', 'pi-home', 'sessions'),
          join(homedir(), '.config', 'Stem', 'pi-home', 'sessions')
        ];
  const found = candidates.find((d) => existsSync(d));
  if (!found) {
    console.error(`No sessions directory found. Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}`);
    process.exit(2);
  }
  return found;
}

function sessionFiles(dir, since) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sessionFiles(path, since));
    else if (entry.name.endsWith('.jsonl') && (!since || statSync(path).mtimeMs >= since)) out.push(path);
  }
  return out;
}

function readSession(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === 'message' && obj.message) out.push(obj.message);
    } catch {
      // a partially flushed tail line
    }
  }
  return out;
}

function textChars(content) {
  if (!Array.isArray(content)) return { chars: 0, truncated: false };
  let chars = 0;
  let truncated = false;
  for (const b of content) {
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    chars += b.text.length;
    if (b.text.includes(TRUNCATION_MARK)) truncated = true;
  }
  return { chars, truncated };
}

/**
 * One turn = a user message up to the next. Each tool call becomes
 * { step, mcp, server, tool, chars, truncated }, where `step` is the index of
 * the assistant message that made it (calls sharing a step were one round trip).
 * A call is MCP when it went through invoke_tool, or when its result carries
 * the { server, tool } details callRoutedTool stamps (directly loaded tools).
 */
function turnsOf(messages) {
  const turns = [];
  let calls = null;
  let step = 0;
  const byId = new Map();
  for (const m of messages) {
    if (m.role === 'user') {
      if (calls) turns.push(calls);
      calls = [];
      step = 0;
      byId.clear();
      continue;
    }
    if (!calls) continue;
    if (m.role === 'assistant') {
      let made = false;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== 'toolCall') continue;
        made = true;
        const routed = b.name === 'invoke_tool';
        const call = {
          step,
          name: b.name,
          mcp: routed,
          server: routed ? String(b.arguments?.server ?? '?') : '',
          tool: routed ? String(b.arguments?.tool ?? '?') : '',
          chars: 0,
          truncated: false
        };
        calls.push(call);
        if (typeof b.id === 'string') byId.set(b.id, call);
      }
      if (made) step++;
      continue;
    }
    if (m.role === 'toolResult') {
      const call = byId.get(m.toolCallId);
      if (!call) continue;
      const d = m.details;
      if (!call.mcp && d && typeof d.server === 'string' && typeof d.tool === 'string') {
        call.mcp = true;
        call.server = d.server;
        call.tool = d.tool;
      }
      const size = textChars(m.content);
      call.chars = size.chars;
      call.truncated = size.truncated;
    }
  }
  if (calls) turns.push(calls);
  return turns;
}

/** Runs of MCP calls. Discovery lookups sit inside a run without counting; any other tool ends it. */
function chainsOf(calls) {
  const chains = [];
  let run = [];
  const flush = () => {
    if (run.length) chains.push(run);
    run = [];
  };
  for (const c of calls) {
    if (c.mcp) run.push(c);
    else if (!DISCOVERY.has(c.name)) flush();
  }
  flush();
  return chains;
}

function pct(n, d) {
  return d ? `${((100 * n) / d).toFixed(1)}%` : 'n/a';
}

function quantile(sorted, q) {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
}

function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

const dir = resolveSessionsDir();
const files = sessionFiles(dir, days > 0 ? Date.now() - days * 86_400_000 : 0);

let turns = 0;
let turnsWithMcp = 0;
let turnsWithChain = 0;
let mcpCalls = 0;
let allCalls = 0;
let discoveryCalls = 0;
let chainCalls = 0;
let chainReadOnly = 0;
let chainsAllRead = 0;
let chainCount = 0;
let roundTripsSaved = 0;
let sameToolLoops = 0;
let mcpRoundTrips = 0;
let truncated = 0;
let big = 0;
let bigChars = 0;
const sizes = [];
const lengthBuckets = new Map(); // chain length -> count
const chainTools = new Map();
const bigTools = new Map();
let mcpChars = 0;

for (const file of files) {
  for (const calls of turnsOf(readSession(file))) {
    turns++;
    allCalls += calls.length;
    discoveryCalls += calls.filter((c) => DISCOVERY.has(c.name)).length;
    const mcp = calls.filter((c) => c.mcp);
    if (!mcp.length) continue;
    turnsWithMcp++;
    mcpCalls += mcp.length;
    mcpRoundTrips += new Set(mcp.map((c) => c.step)).size;
    for (const c of mcp) {
      sizes.push(c.chars);
      mcpChars += c.chars;
      if (c.truncated) truncated++;
      if (c.chars >= BIG_RESULT_CHARS) {
        big++;
        bigChars += c.chars;
        const key = `${c.server}.${c.tool}`;
        bigTools.set(key, (bigTools.get(key) ?? 0) + 1);
      }
    }
    let hadChain = false;
    for (const chain of chainsOf(calls)) {
      const bucket = chain.length >= 10 ? '10+' : String(chain.length);
      lengthBuckets.set(bucket, (lengthBuckets.get(bucket) ?? 0) + 1);
      if (chain.length < CHAIN_MIN) continue;
      hadChain = true;
      chainCount++;
      chainCalls += chain.length;
      roundTripsSaved += new Set(chain.map((c) => c.step)).size - 1;
      const reads = chain.filter((c) => READ_VERB.test(c.tool.replace(/^[a-z0-9]+[_-]/i, '')) || READ_VERB.test(c.tool)).length;
      chainReadOnly += reads;
      if (reads === chain.length) chainsAllRead++;
      const perTool = new Map();
      for (const c of chain) {
        const key = `${c.server}.${c.tool}`;
        chainTools.set(key, (chainTools.get(key) ?? 0) + 1);
        perTool.set(key, (perTool.get(key) ?? 0) + 1);
      }
      if ([...perTool.values()].some((n) => n >= CHAIN_MIN)) sameToolLoops++;
    }
    if (hadChain) turnsWithChain++;
  }
}

sizes.sort((a, b) => a - b);
const line = (label, value) => console.log(`${label.padEnd(44)}${value}`);

console.log(`Code mode upside — ${dir}${days > 0 ? ` (last ${days} days)` : ''}\n`);
line('sessions', files.length);
line('turns', turns);
line('tool calls (all kinds)', allCalls);
line('MCP calls', `${mcpCalls} (${pct(mcpCalls, allCalls)} of tool calls)`);
line('find_tools / describe_tool calls', discoveryCalls);
line('turns with any MCP call', `${turnsWithMcp} (${pct(turnsWithMcp, turns)} of turns)`);

console.log(`\nChains (runs of >= ${CHAIN_MIN} MCP calls, no other tool between)`);
line('turns with a chain', `${turnsWithChain} (${pct(turnsWithChain, turns)} of turns, ${pct(turnsWithChain, turnsWithMcp)} of MCP turns)`);
line('chains', chainCount);
line('MCP calls inside chains', `${chainCalls} (${pct(chainCalls, mcpCalls)} of MCP calls)`);
line('model round trips a script would save', `${roundTripsSaved} of ${mcpRoundTrips} MCP round trips (${pct(roundTripsSaved, mcpRoundTrips)})`);
line('chains repeating one tool >= 3 times', `${sameToolLoops} (${pct(sameToolLoops, chainCount)} of chains)`);
line('chain calls that look read-only (by name)', `${chainReadOnly} (${pct(chainReadOnly, chainCalls)})`);
line('chains that look read-only throughout', `${chainsAllRead} (${pct(chainsAllRead, chainCount)} of chains)`);
console.log('  run length -> runs');
for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10+']) {
  if (lengthBuckets.has(key)) console.log(`    ${key.padStart(3)}  ${lengthBuckets.get(key)}`);
}

console.log('\nResult sizes (text chars per MCP result)');
line('median / p90 / p99 / max', `${quantile(sizes, 0.5)} / ${quantile(sizes, 0.9)} / ${quantile(sizes, 0.99)} / ${sizes.at(-1) ?? 0}`);
line(`results >= ${BIG_RESULT_CHARS} chars`, `${big} (${pct(big, mcpCalls)} of MCP calls)`);
line('  their share of all MCP result text', pct(bigChars, mcpChars));
line('results cut by the 100k cap', truncated);

if (chainTools.size) {
  console.log('\nTools most often inside chains');
  for (const [key, n] of top(chainTools, 12)) console.log(`  ${String(n).padStart(5)}  ${key}`);
}
if (bigTools.size) {
  console.log(`\nTools most often returning >= ${BIG_RESULT_CHARS} chars`);
  for (const [key, n] of top(bigTools, 12)) console.log(`  ${String(n).padStart(5)}  ${key}`);
}
