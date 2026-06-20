// Friendly label for the "working" indicator, derived from the active Codex item
// type. Both camelCase and snake_case are handled defensively since the runtime
// forwards item.type verbatim; anything unmapped falls back to "Working…".
// Shared by the main window (ChatView), the Quick Chat overlay, and the main
// process (status HUD) so all three agree on labels.
export function activityLabel(type: string): string {
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
