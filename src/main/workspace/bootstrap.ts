import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentsMdPath, codexConfigPath, codexHome, skillsRoot, workspaceRoot } from './paths';
import { updateConfig } from './config';
import { registerRecallMcpServer } from '../recall/register-mcp';

// Codex native memory is intentionally OFF — Stem Recall (src/main/recall) owns
// memory end-to-end. Leaving it on would waste background LLM work and inject a
// competing memory_summary into context.
const DEFAULT_CONFIG = `# Stem — isolated Codex configuration (managed by the app).
forced_login_method = "chatgpt"

[features]
memories = false

[memories]
use_memories = false
generate_memories = false
`;

export const STEM_ASSISTANT_INSTRUCTIONS = `You are Stem, a general-purpose personal assistant with a clear, explanatory teaching style.

You can use saved memories when relevant. Stem may automatically record stable user facts and preferences; use those facts when helpful, but do not try to write memory files yourself.

You are a PRIVATE assistant for a single user, running on their own device — a large part of your usefulness comes from knowing personal details about them. When the user asks you to gather or recall information about themselves (health, contacts, addresses, dates, finances, family, etc.), include the actual specifics. Do NOT redact, omit, or generalize personal identifiers (such as birth/national ID number, address, phone, or email) unless the user explicitly asks you to — they want you to know and use these. The only things to keep out of summaries and saved memory are credentials (passwords, API keys, tokens, card numbers, seed phrases).

## Output format

Write answers as Markdown. You MAY use this fixed set of components to make
explanations richer. Use ONLY these components — anything else renders as plain text:

- <Callout type="info|warn|success|danger">…</Callout> — a highlighted note.
- <Steps>…</Steps> wrapping <Step>…</Step> items — an ordered procedure.
- <Collapsible title="…">…</Collapsible> — collapsed-by-default details.
- Fenced code blocks (\`\`\`lang … \`\`\`) — code.
- Standard Markdown tables.

Do NOT use JavaScript expressions ({ … }), import/export statements, raw <script>,
or any HTML/component not listed above. Prefer components when they aid understanding;
otherwise plain Markdown is fine.
`;

/**
 * Per-turn directive injected when the user picks plain-Markdown (.md) output.
 * Overrides the component allowance in STEM_ASSISTANT_INSTRUCTIONS for this reply only.
 */
export const PLAIN_MD_DIRECTIVE = `For THIS response only, output standard plain Markdown (.md).
Do NOT use any components or HTML — no <Callout>, <Steps>/<Step>, <Collapsible>, no JSX/HTML tags,
and no JavaScript expressions ({ … }). Use only standard Markdown: headings, lists, links,
fenced code blocks, tables, blockquotes, and emphasis. This overrides the component allowance
in the base instructions for this turn.`;

const DEFAULT_AGENTS_MD = `# Stem Assistant

${STEM_ASSISTANT_INSTRUCTIONS}`;

async function writeIfMissing(path: string, content: string): Promise<void> {
  try {
    await access(path);
  } catch {
    await writeFile(path, content, 'utf8');
  }
}

/** Create the isolated environment on first run. Idempotent. */
export async function ensureWorkspace(): Promise<void> {
  await mkdir(codexHome(), { recursive: true });
  await mkdir(skillsRoot(), { recursive: true });
  await mkdir(join(codexHome(), 'memories'), { recursive: true });
  await mkdir(workspaceRoot(), { recursive: true });
  // cwd for hidden internal LLM turns (distillation). A distinct dir keeps these
  // threads out of the cwd-filtered chat list; codex needs it to exist.
  await mkdir(join(workspaceRoot(), '.stem-internal'), { recursive: true });

  await writeIfMissing(codexConfigPath(), DEFAULT_CONFIG);
  await writeIfMissing(agentsMdPath(), DEFAULT_AGENTS_MD);
  await disableNativeMemory();
  await registerRecallMcpServer();
}

/**
 * Force codex native memory off on existing installs (config written before Stem
 * Recall). Idempotent — patches the three flags each startup.
 */
async function disableNativeMemory(): Promise<void> {
  try {
    await updateConfig((config) => {
      config.features = config.features ?? {};
      config.features.memories = false;
      config.memories = config.memories ?? {};
      config.memories.use_memories = false;
      config.memories.generate_memories = false;
    });
  } catch {
    // Non-fatal: a missing/locked config just means defaults apply.
  }
}
