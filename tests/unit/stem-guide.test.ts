// The app's own docs, served to the model by the `read_stem_guide` tool. What
// can actually break here is wiring, not logic: a `?raw` import that silently
// resolves to nothing, a page renamed in docs/ and never re-imported, or a slug
// the system prompt advertises that the tool's enum rejects. All three fail
// invisibly at runtime — the model just gets an empty page or a tool error —
// so they are asserted here instead.
import { describe, expect, it } from 'vitest';
import {
  STEM_GUIDE_PAGES,
  STEM_GUIDE_SLUGS,
  stemGuideIndex,
  stemGuidePage
} from '../../src/server/recall/stem-guide';

/** The tool descriptor's `page` enum, read out of the server module's tools/list. */
async function guideEnum(): Promise<string[]> {
  const { toolDescriptors } = await import('../../src/server/recall/mcp-server-main');
  const guide = toolDescriptors().find((t) => t.name === 'read_stem_guide');
  const schema = guide?.inputSchema as { properties?: { page?: { enum?: string[] } } } | undefined;
  return schema?.properties?.page?.enum ?? [];
}

describe('stem guide pages', () => {
  it('resolves every slug to real content', () => {
    expect(STEM_GUIDE_PAGES.length).toBeGreaterThan(0);
    for (const page of STEM_GUIDE_PAGES) {
      // A `?raw` import of a missing file fails the build, but one of a file that
      // was emptied (or of a page still holding only a placeholder header) does
      // not — require a heading plus some prose under it.
      expect(page.markdown.length, `${page.slug} (${page.source}) is empty`).toBeGreaterThan(80);
      expect(page.markdown, `${page.slug} lost its heading`).toMatch(/^#\s+\S/);
      expect(page.summary.length, `${page.slug} has no summary`).toBeGreaterThan(10);
    }
  });

  it('has unique slugs and covers the guide index and release notes', () => {
    expect(new Set(STEM_GUIDE_SLUGS).size).toBe(STEM_GUIDE_SLUGS.length);
    expect(STEM_GUIDE_SLUGS).toContain('guide');
    expect(STEM_GUIDE_SLUGS).toContain('release-notes');
    // Whatever docs/README.md's feature table links must be servable: a page
    // added to the index and not imported here is one the model will be told
    // about (the index is what the system prompt mirrors) and cannot read. The
    // reverse is allowed — pages can exist outside that table.
    const index = STEM_GUIDE_PAGES.find((p) => p.slug === 'guide')!.markdown;
    const sources = STEM_GUIDE_PAGES.map((p) => p.source);
    const linked = [...index.matchAll(/\]\((user\/[\w./-]+\.md)\)/g)].map((m) => `docs/${m[1]}`);
    expect(linked.length).toBeGreaterThan(5);
    for (const source of linked) expect(sources, `${source} is linked from docs/README.md`).toContain(source);
  });

  it('drops screenshot markup and maintainer comments', () => {
    for (const page of STEM_GUIDE_PAGES) {
      expect(page.markdown, `${page.slug} kept image markup`).not.toContain('<picture');
      expect(page.markdown, `${page.slug} kept an HTML comment`).not.toContain('<!--');
    }
    // …without touching the prose around them: chats.md has a screenshot wedged
    // between its intro and its first section.
    const chats = STEM_GUIDE_PAGES.find((p) => p.slug === 'chats')!.markdown;
    expect(chats).toContain('## Ask');
    expect(chats).toContain('Review this launch plan');
  });

  it('preserves detailed procedures and exact component syntax behind their guide pages', () => {
    expect(stemGuidePage('assistant-preferences')?.markdown).toContain('"quickChat"');
    expect(stemGuidePage('assistant-mcp')?.markdown).toContain("chat's history");
    expect(stemGuidePage('assistant-skills')?.markdown).toContain('initiated_by: "user"');
    expect(stemGuidePage('assistant-skills')?.markdown).toContain('FULL body');
    expect(stemGuidePage('assistant-scheduling')?.markdown).toContain('5 fields, local time');
    expect(stemGuidePage('assistant-files')?.markdown).toContain('cp report.pdf files/');
    expect(stemGuidePage('assistant-web')?.markdown).toContain('UNTRUSTED DATA');
    const output = stemGuidePage('output-format')!.markdown;
    expect(output).toContain('```json\n[{"label":"Q1","value":12}');
    expect(output).toContain('<Form prompt="…" submitLabel="…">');
    expect(output).toContain('`answer` must exactly match');
    expect(output).not.toContain('\\`');
  });

  it('looks pages up case-insensitively and rejects anything else', () => {
    expect(stemGuidePage('settings')?.source).toBe('docs/user/settings.md');
    expect(stemGuidePage(' Settings ')?.slug).toBe('settings');
    expect(stemGuidePage('docs/user/settings.md')).toBeNull();
    expect(stemGuidePage(undefined)).toBeNull();
    expect(stemGuidePage(7)).toBeNull();
  });

  it('lists every slug in the guide discovery index', () => {
    const index = stemGuideIndex();
    for (const page of STEM_GUIDE_PAGES) {
      expect(index).toContain(`\`${page.slug}\` — ${page.summary}`);
    }
    expect(index.split('\n')).toHaveLength(STEM_GUIDE_PAGES.length);
  });
});

describe('read_stem_guide descriptor', () => {
  it('offers exactly the slugs the map holds, in the same order', async () => {
    expect(await guideEnum()).toEqual([...STEM_GUIDE_SLUGS]);
  });
});
