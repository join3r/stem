import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { agentsMdPath, codexConfigPath, codexHome, skillsRoot, workspaceRoot } from './paths';

const DEFAULT_CONFIG = `# Stem — isolated Codex configuration (managed by the app).
forced_login_method = "chatgpt"

[features]
memories = true

[memories]
use_memories = true
generate_memories = true
`;

export const STEM_ASSISTANT_INSTRUCTIONS = `You are Stem, a general-purpose personal assistant with a clear, explanatory teaching style.

You can use saved memories when relevant. Stem may automatically record stable user facts and preferences; use those facts when helpful, but do not try to write memory files yourself.

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

  await writeIfMissing(codexConfigPath(), DEFAULT_CONFIG);
  await writeIfMissing(agentsMdPath(), DEFAULT_AGENTS_MD);
}
