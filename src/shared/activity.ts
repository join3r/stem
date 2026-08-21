// Friendly label for the "working" indicator, derived from the active backend item.
// When the real tool `name` is known it produces a specific phrase ("Reading
// runtime.ts…", "Running grep…"); otherwise it falls back to the coarse `type`
// bucket. Both camelCase and snake_case types are handled defensively since the
// runtime forwards item.type verbatim; anything unmapped falls back to "Working…".
// Shared by the main window (ChatView), the Quick Chat overlay, and the main
// process (status HUD) so all three agree on labels.

// Exact names of the web-access tools (the pi-web-access set gated by the bridge
// extension). Only these get the "web" phrasing — substring matching on
// 'search'/'web' is wrong here because MCP tools unwrapped from invoke_tool keep
// their server-side names (e.g. Home Assistant's ha_search), and those must not
// masquerade as web searches.
export const WEB_ACCESS_TOOL_NAMES = new Set([
  'web_search',
  'source_check',
  'fetch_content',
  'get_search_content'
]);

/** Phrase a specific label from the raw tool name + optional target. */
function labelForTool(name: string, detail?: string): string | undefined {
  const n = name.toLowerCase();
  const on = detail ? ` ${detail}` : '';
  if (n === 'coding_agent') {
    if (!detail) return 'Running a coding agent…';
    // The harness's live detail is already a full phrase ("claude: editing
    // src/foo.ts · 3 tool calls · $0.40"); the initial detail is the bare agent name.
    return detail.includes(':') ? `${detail}…` : `Running the ${detail} coding agent…`;
  }
  if (n === 'read') return detail ? `Reading ${detail}…` : 'Reading a file…';
  if (n === 'bash' || n === 'cmd') return detail ? `Running ${detail}…` : 'Running a command…';
  if (n === 'grep') return detail ? `Searching for ${detail}…` : 'Searching files…';
  if (n === 'glob' || n === 'ls') return 'Listing files…';
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'apply_patch')
    return detail ? `Editing ${detail}…` : 'Editing files…';
  if (WEB_ACCESS_TOOL_NAMES.has(n)) return detail ? `Searching the web for ${detail}…` : 'Searching the web…';
  if (n.startsWith('mcp')) {
    // mcp__server__tool → show the tool segment; keep it readable.
    const tool = name.split('__').filter(Boolean).pop() ?? name;
    return `Using ${tool}${on}…`;
  }
  return `Using ${name}${on}…`;
}

/** Past-tense row label for a finished tool call ("Read foo.ts", "Searched the web for x"). */
export function settledActivityLabel(type: string, name?: string, detail?: string): string {
  const n = (name ?? '').toLowerCase();
  const on = detail ? ` ${detail}` : '';
  // Same standing as "Read foo.ts": the thing was put in front of the model. The
  // reply may still have gone its own way, which the skills block explicitly
  // allows for — as a file's contents may go unused.
  if (type === 'skill') return name ? `Used the skill ${name}` : 'Used a saved skill';
  if (n === 'coding_agent' || type === 'codingAgent') return 'Ran a coding agent';
  if (n === 'read') return detail ? `Read ${detail}` : 'Read a file';
  if (n === 'bash' || n === 'cmd') return detail ? `Ran ${detail}` : 'Ran a command';
  if (n === 'grep') return detail ? `Searched for ${detail}` : 'Searched files';
  if (n === 'glob' || n === 'ls') return 'Listed files';
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'apply_patch')
    return detail ? `Edited ${detail}` : 'Edited files';
  if (WEB_ACCESS_TOOL_NAMES.has(n) || type === 'webSearch' || type === 'web_search')
    return detail ? `Searched the web for ${detail}` : 'Searched the web';
  if (n.startsWith('mcp')) {
    const tool = (name ?? '').split('__').filter(Boolean).pop() ?? name;
    return `Used ${tool}${on}`;
  }
  if (type === 'compaction') return 'Condensed chat history to free up space';
  if (name) return `Used ${name}${on}`;
  switch (type) {
    case 'commandExecution':
    case 'command_execution':
    case 'exec':
      return 'Ran a command';
    case 'fileChange':
    case 'file_change':
      return 'Edited files';
    default:
      return 'Used a tool';
  }
}

export function activityLabel(type: string, name?: string, detail?: string): string {
  // Ahead of labelForTool: a skill's name is not a tool name, and left to that
  // fallback it would come out as "Using extract-video-captions…".
  if (type === 'skill') return name ? `Reading the skill ${name}…` : 'Reading a saved skill…';
  if (name && type !== 'reasoning') {
    const specific = labelForTool(name, detail);
    if (specific) return specific;
  }
  switch (type) {
    case 'reasoning':
      return 'Thinking…';
    case 'webSearch':
    case 'web_search':
      return 'Searching the web…';
    case 'commandExecution':
    case 'command_execution':
    case 'exec':
      return 'Running a command…';
    case 'mcpToolCall':
    case 'mcp_tool_call':
      return 'Using a tool…';
    case 'fileChange':
    case 'file_change':
      return 'Editing files…';
    case 'compaction':
      return 'Condensing chat history…';
    default:
      return 'Working…';
  }
}
