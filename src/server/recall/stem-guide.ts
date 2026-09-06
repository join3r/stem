// Stem's own user guide, compiled into the bundle as text.
//
// The assistant is expected to answer questions ABOUT Stem — where a setting
// lives, what Memory keeps, which shortcut does what — and it cannot see the app
// it runs inside. The docs/ tree is already the answer to all of those, written
// for the same person who is asking, so the guide is served to the model verbatim
// through the `read_stem_guide` tool on the stem-recall MCP server.
//
// The pages are `?raw` imports rather than runtime reads, and that is the whole
// packaging story: both entries that need them (recall-mcp-server.js for the tool,
// index/server.js for the prompt index) are rollup bundles, so vite inlines the
// markdown at build time. Nothing has to be copied into the .app, into the Docker
// image, or next to `node dist/main/server.js` — a docs/ file that exists at build
// time ships everywhere the bundle does. It also means the guide can never drift
// from the source tree: the shipped text IS docs/, as of the build.
//
// Total is ~35 KB of markdown across all pages, all of it loaded at import. That
// is small next to the bundle and the alternative (fs reads relative to
// import.meta.url) has no path that survives all three deployments.
//
// This module deliberately has no imports besides the markdown: the MCP server
// process must be able to answer from it without opening recall.sqlite or
// reaching the main process.

import guideMd from '../../../docs/README.md?raw';
import chatsMd from '../../../docs/user/chats.md?raw';
import quickChatMd from '../../../docs/user/quick-chat.md?raw';
import memoryMd from '../../../docs/user/memory/README.md?raw';
import memoryFactsMd from '../../../docs/user/memory/facts.md?raw';
import memoryRecallMd from '../../../docs/user/memory/recall.md?raw';
import toolsMd from '../../../docs/user/tools/README.md?raw';
import mcpServersMd from '../../../docs/user/tools/mcp-servers.md?raw';
import skillsMd from '../../../docs/user/tools/skills.md?raw';
import shortcutsMd from '../../../docs/user/shortcuts.md?raw';
import connectedFoldersMd from '../../../docs/user/connected-folders.md?raw';
import scheduledTasksMd from '../../../docs/user/scheduled-tasks.md?raw';
import settingsMd from '../../../docs/user/settings.md?raw';
import movingAndBackupsMd from '../../../docs/user/moving-and-backups.md?raw';
import releaseNotesMd from '../../../RELEASE_NOTES.md?raw';
import assistantPreferencesMd from '../../../docs/assistant/assistant-preferences.md?raw';
import assistantMcpMd from '../../../docs/assistant/assistant-mcp.md?raw';
import assistantSkillsMd from '../../../docs/assistant/assistant-skills.md?raw';
import assistantSchedulingMd from '../../../docs/assistant/assistant-scheduling.md?raw';
import assistantFilesMd from '../../../docs/assistant/assistant-files.md?raw';
import assistantWebMd from '../../../docs/assistant/assistant-web.md?raw';
import assistantHostMd from '../../../docs/assistant/assistant-host.md?raw';
import outputFormatMd from '../../../docs/assistant/output-format.md?raw';


export interface StemGuidePage {
  /** Tool argument the model passes, and the key of the enum in the descriptor. */
  slug: string;
  /** One line of "what this covers", mirroring docs/README.md's table. */
  summary: string;
  /** Repo-relative source, so an answer can point at where the text came from. */
  source: string;
  /** The page as the model sees it (see forModel). */
  markdown: string;
}

/**
 * Strip what only means something to a human reading the docs on GitHub:
 * screenshot markup (a `<picture>` the model cannot see, sometimes centered in a
 * `<p align="center">`) and HTML comments (maintainer notes, `TODO(screenshot)`
 * reminders — the RELEASE_NOTES.md one is a whole paragraph of release process).
 * Prose, headings, links and tables are left exactly as written: the point of
 * serving the docs is that they already say it well.
 */
function forModel(markdown: string): string {
  return markdown
    .replace(/<p[^>]*>\s*<picture>[\s\S]*?<\/picture>\s*<\/p>/g, '')
    .replace(/<picture>[\s\S]*?<\/picture>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function page(slug: string, source: string, summary: string, markdown: string): StemGuidePage {
  return { slug, source, summary, markdown: forModel(markdown) };
}

/**
 * Every page the assistant can read, in docs/README.md's order — which is the
 * order of the app's own navigation, so the index the model gets reads like the
 * sidebar it is answering about. `release-notes` is the one page with no row in
 * that table; it lives at the repo root and answers "what changed recently".
 */
export const STEM_GUIDE_PAGES: readonly StemGuidePage[] = [
  page('guide', 'docs/README.md', 'index of every page below, plus the demo profile the screenshots use', guideMd),
  page('chats', 'docs/user/chats.md', 'asking, attaching files, organizing chats into folders, retry/edit/fork', chatsMd),
  page('quick-chat', 'docs/user/quick-chat.md', 'the shortcut-summoned overlay for asking from any app, and Note mode', quickChatMd),
  page('memory', 'docs/user/memory/README.md', 'what Memory learns on its own, and where Facts and Recall live', memoryMd),
  page('memory-facts', 'docs/user/memory/facts.md', 'durable facts: how they arrive, reviewing them, conflicts, erasing them', memoryFactsMd),
  page('memory-recall', 'docs/user/memory/recall.md', 'searchable chat history and summaries, its storage limit, deleting it', memoryRecallMd),
  page('tools', 'docs/user/tools/README.md', 'the Tools section: MCP servers vs skills', toolsMd),
  page('mcp-servers', 'docs/user/tools/mcp-servers.md', 'connecting remote and local MCP servers, and what to check first', mcpServersMd),
  page('skills', 'docs/user/tools/skills.md', 'reusable procedures Stem saves and follows again', skillsMd),
  page('shortcuts', 'docs/user/shortcuts.md', 'keyboard shortcuts and tricks across the app', shortcutsMd),
  page('connected-folders', 'docs/user/connected-folders.md', 'using folders where they live: indexing, Memorize, Learn facts', connectedFoldersMd),
  page('scheduled-tasks', 'docs/user/scheduled-tasks.md', 'running a prompt later or on a repeating schedule, and its controls', scheduledTasksMd),
  page('settings', 'docs/user/settings.md', 'providers and models, command approvals, Esc, notifications, Quick Chat defaults', settingsMd),
  page('moving-and-backups', 'docs/user/moving-and-backups.md', 'moving Stem to another computer, what travels, and backups', movingAndBackupsMd),
  page('release-notes', 'RELEASE_NOTES.md', 'what changed in each Stem version, newest first', releaseNotesMd),
  // Detailed assistant procedures are loaded only for the task that needs them.
  page('assistant-preferences', 'docs/assistant/assistant-preferences.md', 'saving standing instructions: actions, approval and surfaces', assistantPreferencesMd),
  page('assistant-mcp', 'docs/assistant/assistant-mcp.md', 'assistant procedure for connecting and troubleshooting MCP servers', assistantMcpMd),
  page('assistant-skills', 'docs/assistant/assistant-skills.md', 'assistant procedure for authoring, updating and saving reusable skills', assistantSkillsMd),
  page('assistant-scheduling', 'docs/assistant/assistant-scheduling.md', 'assistant procedure for schedules and autonomous-run notifications', assistantSchedulingMd),
  page('assistant-files', 'docs/assistant/assistant-files.md', 'assistant procedure for shared files, deliverables and scratch storage', assistantFilesMd),
  page('assistant-web', 'docs/assistant/assistant-web.md', 'assistant procedure for web search, fetching URLs and source safety', assistantWebMd),
  page('assistant-host', 'docs/assistant/assistant-host.md', 'server execution, device routing and persistent package installation', assistantHostMd),
  page('output-format', 'docs/assistant/output-format.md', 'supported rich-output components, exact syntax, limitations and examples', outputFormatMd)
];

/** Valid `page` arguments, in guide order — the tool descriptor's enum. */
export const STEM_GUIDE_SLUGS: readonly string[] = STEM_GUIDE_PAGES.map((p) => p.slug);

/** The page for a slug, or null — the tool turns null into an error naming the slugs. */
export function stemGuidePage(slug: unknown): StemGuidePage | null {
  if (typeof slug !== 'string') return null;
  const wanted = slug.trim().toLowerCase();
  return STEM_GUIDE_PAGES.find((p) => p.slug === wanted) ?? null;
}

/**
 * The one-line-per-page index for guide discovery. Generated rather than
 * written out beside the other instructions so a page added here shows up in the
 * prompt in the same commit — a slug the model has been told about but the tool
 * rejects (or the reverse) is the only way this feature can quietly break.
 */
export function stemGuideIndex(): string {
  return STEM_GUIDE_PAGES.map((p) => `- \`${p.slug}\` — ${p.summary}`).join('\n');
}
