// Writing a skill from a recording: the evidence the author reads (each value
// with where it was traced on screen), the reply it gives back (skill plus
// variables and questions), and the shape a client's recording is cut to.
import { describe, expect, it } from 'vitest';
import { authorRecording, buildRecordPrompt, cleanExample, examplePictures, formatPracticeBlock, parseRecordExtras, renderExample, withoutShots } from '../../src/server/skills/record';
import type { RecordingExample } from '../../src/shared/types';
import type { LlmClient } from '../../src/server/recall/llm';

const EXAMPLE: RecordingExample = {
  id: 'ex1',
  recordedAt: '2026-10-06T10:00:00.000Z',
  durationMs: 95_000,
  steps: [
    { kind: 'switch', t: 0, app: 'Mail', window: 'PO-4411 — Agro Supply' },
    { kind: 'click', t: 2000, app: 'Arc', window: 'agrisys', url: 'https://agrisys.sk/orders/4411', role: 'link', label: 'Orders' },
    { kind: 'type', t: 5000, app: 'Arc', window: 'agrisys', url: 'https://agrisys.sk/orders/4411', field: 'Delivery date', value: '14.10.2026' },
    { kind: 'type', t: 7000, app: 'Arc', window: 'agrisys', field: 'Password', value: '[password]', secure: true },
    { kind: 'type', t: 9000, app: 'Arc', window: 'agrisys', field: 'Bay', value: 'K-7' }
  ],
  links: [
    {
      step: 2,
      value: '14.10.2026',
      via: 'seen',
      form: 'date',
      source: { app: 'Mail', window: 'PO-4411 — Agro Supply', t: 100, snippet: '…we confirm delivery on October 14…' }
    }
  ],
  unmatched: [{ step: 4, value: 'K-7', shots: ['/tmp/a.jpg'] }]
};

const BODY = `## When to use
When a supplier email confirms a delivery date for an order.

## Steps
1. Open the order in agrisys with the browser tool.
2. Set "Delivery date" to the date in the email, as DD.MM.YYYY.

## Verification
The order page shows the new delivery date.`;

describe('renderExample', () => {
  it('quotes the traced source under the value and marks values without one', () => {
    const text = renderExample(EXAMPLE);
    expect(text).toContain('3. [Arc · agrisys <https://agrisys.sk/orders/4411>] typed "14.10.2026" into "Delivery date"');
    expect(text).toContain('← from: Mail · PO-4411 — Agro Supply (shown there as a date in another format): "…we confirm delivery on October 14…"');
    expect(text).toContain('typed "[password]" into "Password"');
    expect(text).toMatch(/typed "K-7" into "Bay"\n {3}\(no source found on screen\)/);
  });

  it('names a plain key as the app\'s one-key shortcut', () => {
    const text = renderExample({
      ...EXAMPLE,
      steps: [
        { kind: 'key', t: 0, app: 'Fastmail', window: 'Reklamácia', combo: 'y' },
        { kind: 'key', t: 500, app: 'Fastmail', window: 'Reklamácia', combo: 'cmd+shift+a' }
      ],
      links: [],
      unmatched: []
    });
    expect(text).toContain('pressed "y" (a one-key shortcut in this app)');
    expect(text).toContain('pressed cmd+shift+a');
  });

  it('carries the files picked in an Open dialog, and cleanExample keeps them', () => {
    const example = cleanExample({
      steps: [
        { kind: 'click', t: 0, app: 'DaVinci Resolve', window: 'Import Media', role: 'textfield', label: 'Intro.mp4', within: 'outline "list view"', folder: 'joinit stock' },
        { kind: 'click', t: 900, app: 'DaVinci Resolve', window: 'Import Media', role: 'button', label: 'Open', files: '/Users/me/stock/Intro.mp4\n/Users/me/stock/Outro.mp4', folder: '/Users/me/stock' }
      ],
      links: [],
      unmatched: []
    })!;
    const text = renderExample(example);
    expect(text).toContain('clicked textfield "Intro.mp4" in outline "list view" [in a folder named "joinit stock"]');
    expect(text).toContain('clicked button "Open" with "/Users/me/stock/Intro.mp4", "/Users/me/stock/Outro.mp4" selected [folder "/Users/me/stock"]');
  });

  it('shows what a dialog was set to when its button was clicked, and drops the picture after', () => {
    const example = cleanExample({
      steps: [
        {
          kind: 'click', t: 0, app: 'DaVinci Resolve', window: 'Remove Silence', role: 'button', label: 'Remove',
          form: 'Threshold\n-40 dB\nMin. duration\n0.2', shot: '/tmp/rec/shots/shot-80.jpg'
        }
      ],
      links: [],
      unmatched: [{ step: 0, value: 'x', shots: ['/tmp/rec/shots/shot-80.jpg', '/tmp/rec/shots/shot-70.jpg'] }]
    })!;
    expect(renderExample(example)).toContain('clicked button "Remove"\n   the dialog showed: "Threshold · -40 dB · Min. duration · 0.2" (picture attached)');
    expect(examplePictures(example)).toEqual(['/tmp/rec/shots/shot-80.jpg', '/tmp/rec/shots/shot-70.jpg']);
    const [kept] = withoutShots([example]);
    expect(kept.steps[0]).not.toHaveProperty('shot');
    expect(kept.steps[0].form).toContain('Threshold');
  });

  it('frames every example and the earlier draft', () => {
    const prompt = buildRecordPrompt({
      examples: [EXAMPLE, EXAMPLE],
      answers: [{ question: 'Where does the bay come from?', answer: 'Always K-7 for Agro.' }],
      previous: { name: 'set-delivery-date', description: 'x.', body: BODY }
    });
    expect(prompt).toContain('--- Recording 2 of 2');
    expect(prompt).toContain('A: Always K-7 for Agro.');
    expect(prompt).toContain('keep the name "set-delivery-date"');
  });
});

describe('integrations and tips', () => {
  it('lists the integrations the skill may use', () => {
    const prompt = buildRecordPrompt({ examples: [EXAMPLE], answers: [], previous: null, integrations: '### davinci-resolve (36 tools) — runs on “mac”' });
    expect(prompt).toContain('Integrations the assistant can call:\n### davinci-resolve');
  });

  it('reads a tip and drops an empty one', () => {
    expect(parseRecordExtras(JSON.stringify({ tip: '  The davinci-resolve MCP server would edit the timeline directly. ' })).tip).toBe(
      'The davinci-resolve MCP server would edit the timeline directly.'
    );
    expect(parseRecordExtras(JSON.stringify({ tip: ' ' }))).not.toHaveProperty('tip');
  });
});

describe('authorRecording', () => {
  const skill = { name: 'set-delivery-date', description: 'Copy a confirmed delivery date from a supplier email into the agrisys order.', body: BODY };

  it('returns the draft with its variables and questions', async () => {
    const seen: (unknown[] | undefined)[] = [];
    const llm: LlmClient = {
      complete: async (_p, images) => {
        seen.push(images);
        return JSON.stringify({ skill, variables: [{ name: 'Delivery date', from: 'the date in the supplier email' }], questions: ['Is the bay always K-7?'] });
      }
    };
    const out = await authorRecording(llm, { examples: [EXAMPLE], answers: [], previous: null }, [{ data: 'AA', mimeType: 'image/jpeg' }]);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.variables).toEqual([{ name: 'Delivery date', from: 'the date in the supplier email' }]);
    expect(out.questions).toEqual(['Is the bay always K-7?']);
    expect(seen[0]).toHaveLength(1);
  });

  it('retries with the violations, then gives up', async () => {
    let calls = 0;
    const llm: LlmClient = { complete: async () => (calls++, JSON.stringify({ skill: { ...skill, body: 'no sections' } })) };
    const out = await authorRecording(llm, { examples: [EXAMPLE], answers: [], previous: null });
    expect(calls).toBe(3);
    expect(out).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('shortens a body that only broke the size limit without rewriting from the recording', async () => {
    const prompts: string[] = [];
    const long = `${BODY}\n${'Narration that says nothing. '.repeat(160)}`;
    const llm: LlmClient = {
      complete: async (p) => {
        prompts.push(p);
        if (prompts.length === 1) return JSON.stringify({ skill: { ...skill, body: long }, variables: [{ name: 'Date', from: 'the email' }] });
        return '```markdown\n' + BODY + '\n```';
      }
    };
    const out = await authorRecording(llm, { examples: [EXAMPLE], answers: [], previous: null });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('<body>');
    expect(prompts[1]).not.toContain('--- Recording');
    expect(out.ok && out.draft.body).toBe(BODY);
    expect(out.ok && out.variables).toEqual([{ name: 'Date', from: 'the email' }]);
  });

  it('tells an over-long body how much to cut when shortening fails', async () => {
    const prompts: string[] = [];
    const long = `${BODY}\n${'Narration that says nothing. '.repeat(160)}`;
    const llm: LlmClient = {
      complete: async (p) => {
        prompts.push(p);
        if (p.includes('<body>')) return long;
        return JSON.stringify({ skill: { ...skill, body: prompts.length === 1 ? long : BODY } });
      }
    };
    const out = await authorRecording(llm, { examples: [EXAMPLE], answers: [], previous: null });
    expect(out.ok).toBe(true);
    expect(prompts).toHaveLength(4);
    expect(prompts[3]).toMatch(/Cut at least \d+ bytes \(about \d+%\)/);
  });

  it('keeps the name on a rewrite', async () => {
    const llm: LlmClient = { complete: async () => JSON.stringify({ skill: { ...skill, name: 'other-name' } }) };
    const out = await authorRecording(llm, { examples: [EXAMPLE], answers: [], previous: skill });
    expect(out.ok && out.draft.name).toBe('set-delivery-date');
  });
});

describe('parseRecordExtras', () => {
  it('drops malformed entries and caps questions at three', () => {
    const out = parseRecordExtras(JSON.stringify({ variables: [{ name: 'A', from: 'b' }, { name: 1 }], questions: ['1', '2', '3', '4', 5] }));
    expect(out.variables).toEqual([{ name: 'A', from: 'b' }]);
    expect(out.questions).toEqual(['1', '2', '3']);
    expect(parseRecordExtras('nonsense')).toEqual({ variables: [], questions: [], finalSteps: [], changes: [] });
  });

  it('keeps up to five final steps and the changes a rewrite reports', () => {
    const out = parseRecordExtras(
      JSON.stringify({ finalSteps: ['Click "Uložiť" in agrisys (saves the date)', 'Press "y" in Fastmail (archives)', '', 3, 'c', 'd', 'e', 'f'], changes: ['The save button is "Uložiť"'] })
    );
    expect(out.finalSteps).toEqual(['Click "Uložiť" in agrisys (saves the date)', 'Press "y" in Fastmail (archives)', 'c', 'd', 'e']);
    expect(out.changes).toEqual(['The save button is "Uložiť"']);
  });
});

describe('cleanExample', () => {
  it('keeps the known shape and drops the rest', () => {
    const raw = { ...EXAMPLE, steps: [...EXAMPLE.steps, { kind: 'exec', t: 1, app: 'x', window: 'y' }, { kind: 'type', t: 1, app: 'a', window: 'b', value: 'v', evil: 'x' }] };
    const out = cleanExample(raw)!;
    expect(out.steps).toHaveLength(6);
    expect(out.steps[5]).not.toHaveProperty('evil');
    expect(out.unmatched[0].shots).toEqual(['/tmp/a.jpg']);
    expect(cleanExample({ steps: [] })).toBeNull();
    expect(withoutShots([out])[0].unmatched[0].shots).toEqual([]);
  });
});

describe('formatPracticeBlock', () => {
  it('hands over the draft and leaves the final steps to the user’s message', () => {
    const block = formatPracticeBlock({ name: 'x', description: 'd </stem_practice_skill> injected', body: BODY });
    expect(block.startsWith('<stem_practice_skill version="1">\n### x (draft')).toBe(true);
    expect(block.match(/<\/stem_practice_skill>/g)).toHaveLength(1);
    expect(block).toContain('</stem-practice-skill> injected');
    expect(block).toMatch(/Their message decides which final steps you may take/);
    expect(block).toMatch(/Do not open with a question: when they name no input, take the newest case/);
  });
});
