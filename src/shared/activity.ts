// Friendly label for the "working" indicator, derived from the active backend item.
// When the real tool `name` is known it produces a specific phrase ("Reading
// runtime.ts…", "Running grep…"); otherwise it falls back to the coarse `type`
// bucket. Both camelCase and snake_case types are handled defensively since the
// runtime forwards item.type verbatim; anything unmapped falls back to "Working…".
// Shared by the main window (ChatView), the Quick Chat overlay, and the main
// process (status HUD) so all three agree on labels.

/** Phrase a specific label from the raw tool name + optional target. */
function labelForTool(name: string, detail?: string): string | undefined {
  const n = name.toLowerCase();
  const on = detail ? ` ${detail}` : '';
  if (n === 'read') return detail ? `Reading ${detail}…` : 'Reading a file…';
  if (n === 'bash' || n === 'cmd') return detail ? `Running ${detail}…` : 'Running a command…';
  if (n === 'grep') return detail ? `Searching for ${detail}…` : 'Searching files…';
  if (n === 'glob' || n === 'ls') return 'Listing files…';
  if (n === 'edit' || n === 'write' || n === 'multiedit' || n === 'apply_patch')
    return detail ? `Editing ${detail}…` : 'Editing files…';
  if (n.includes('search') || n.includes('web')) return detail ? `Searching the web for ${detail}…` : 'Searching the web…';
  if (n.startsWith('mcp')) {
    // mcp__server__tool → show the tool segment; keep it readable.
    const tool = name.split('__').filter(Boolean).pop() ?? name;
    return `Using ${tool}${on}…`;
  }
  return `Using ${name}${on}…`;
}

export function activityLabel(type: string, name?: string, detail?: string): string {
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
    default:
      return 'Working…';
  }
}
