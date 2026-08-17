// Row labels for tool calls. The regression these lock in: MCP tools unwrapped
// from invoke_tool keep server-side names like ha_search, and a name merely
// containing "search"/"web" must not be phrased as a web search — only the
// exact pi-web-access tool names (or an explicit webSearch type) get that.
import { describe, expect, it } from 'vitest';
import { activityLabel, settledActivityLabel } from '../../src/shared/activity';

describe('web-search phrasing', () => {
  it('labels the real web-access tools as web searches', () => {
    expect(settledActivityLabel('mcpToolCall', 'web_search', 'spálňa')).toBe('Searched the web for spálňa');
    expect(activityLabel('mcpToolCall', 'web_search', 'spálňa')).toBe('Searching the web for spálňa…');
    expect(settledActivityLabel('webSearch', undefined, undefined)).toBe('Searched the web');
  });

  it('does not mistake an MCP search tool for a web search', () => {
    expect(settledActivityLabel('mcpToolCall', 'ha_search', 'spálňa')).toBe('Used ha_search spálňa');
    expect(settledActivityLabel('mcpToolCall', 'search_messages', 'deploy')).toBe('Used search_messages deploy');
    expect(activityLabel('mcpToolCall', 'ha_search', 'spálňa')).toBe('Using ha_search spálňa…');
  });

  it('names a loaded skill instead of guessing at a tool', () => {
    // The skill's name is a slug, not a tool name — through labelForTool it would
    // come out as "Using extract-video-captions…", which reads like a tool call.
    expect(settledActivityLabel('skill', 'extract-video-captions')).toBe('Used the skill extract-video-captions');
    expect(activityLabel('skill', 'extract-video-captions')).toBe('Reading the skill extract-video-captions…');
    expect(settledActivityLabel('skill')).toBe('Used a saved skill');
  });

  it('reads naturally with the parenthesized server-name fallback', () => {
    expect(settledActivityLabel('mcpToolCall', 'ha_get_history', '(homeassistant)')).toBe(
      'Used ha_get_history (homeassistant)'
    );
  });
});
