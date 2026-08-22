import { copyFileSync, mkdtempSync, mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FolderIndexStore } from '../../src/server/folder-index/store';
import {
  docEmbedText,
  docTitle,
  scanFolder,
  SKIP_BINARY,
  SKIP_PDF_NO_TEXT,
  SKIP_PDF_UNREADABLE,
  SKIP_TOO_LARGE,
  SKIP_WORD_NO_TEXT,
  SKIP_WORD_UNREADABLE
} from '../../src/server/folder-index/scan';
import { embedMissingDocVectors } from '../../src/server/folder-index/embed';
import { ftsSearchDocs, hybridSearchDocs, semanticSearchDocsCore } from '../../src/server/recall/search-core';
import type { EmbeddingsClient } from '../../src/server/recall/embeddings';
import * as activity from '../../src/server/activity';
import { makePdf } from './make-pdf';
import { makeDocx } from './make-docx';

// The indexed-connected-folders pipeline: store schema, incremental scan with
// mirror semantics (upsert changed, prune vanished), skip classification, the
// embed backfill, and the shared search-core legs over the per-folder DB.

const dir = mkdtempSync(join(tmpdir(), 'stem-folder-index-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let storeSeq = 0;
function freshStore(): FolderIndexStore {
  return new FolderIndexStore(() => join(dir, `index-${storeSeq++}.sqlite`));
}

let folderSeq = 0;
function freshFolder(): string {
  const root = join(dir, `folder-${folderSeq++}`);
  mkdirSync(root, { recursive: true });
  return root;
}

/** Back-date a file's mtime so a subsequent write visibly changes it. */
function backdate(path: string): void {
  const past = (Date.now() - 60_000) / 1000;
  utimesSync(path, past, past);
}


describe('FolderIndexStore', () => {
  it('indexes, FTS-searches, and prunes docs with vector cleanup', () => {
    const store = freshStore();
    try {
      const gen1 = store.nextScanGeneration();
      store.upsertDoc(
        { relPath: 'notes/cottage.md', title: 'Cottage', text: 'The cottage deposit is 400 euro.', mtime: 1, size: 10, hash: 'h1' },
        gen1
      );
      store.upsertDoc(
        { relPath: 'notes/other.md', title: 'Other', text: 'Unrelated grocery list for the week.', mtime: 1, size: 10, hash: 'h2' },
        gen1
      );
      store.upsertDocVector(1, 'test-model', Float32Array.from([1, 0, 0]));

      const hits = ftsSearchDocs(store.handle(), 'cottage deposit');
      expect(hits).toHaveLength(1);
      expect(hits[0].relPath).toBe('notes/cottage.md');
      expect(hits[0].title).toBe('Cottage');

      // Semantic leg finds the vectored doc.
      const sem = semanticSearchDocsCore(store.handle(), Float32Array.from([1, 0, 0]), 'test-model', {
        limit: 5,
        minCosine: 0.5
      });
      expect(sem).toHaveLength(1);
      expect(sem[0].id).toBe(1);

      // A scan generation that only saw "other.md" prunes the cottage doc — and
      // its vectors go with it (delete trigger).
      store.transaction(() => {
        const gen = store.nextScanGeneration();
        store.touchDoc(2, 1, 10, gen);
        expect(store.pruneNotSeen(gen)).toBe(1);
      });
      expect(ftsSearchDocs(store.handle(), 'cottage deposit')).toHaveLength(0);
      expect(
        semanticSearchDocsCore(store.handle(), Float32Array.from([1, 0, 0]), 'test-model', { limit: 5, minCosine: 0 })
      ).toHaveLength(0);
      expect(store.readStatus().indexedCount).toBe(1);
    } finally {
      store.close();
    }
  });

  it('drops stale vectors when a doc\'s content changes, keeps them when only mtime moves', () => {
    const store = freshStore();
    try {
      store.upsertDoc({ relPath: 'a.md', title: 'A', text: 'Original content here today.', mtime: 1, size: 5, hash: 'h1' }, 1);
      store.upsertDocVector(1, 'm', Float32Array.from([1, 0]));
      // Same hash → vectors survive.
      store.upsertDoc({ relPath: 'a.md', title: 'A', text: 'Original content here today.', mtime: 2, size: 5, hash: 'h1' }, 2);
      expect(store.getDocsMissingVector('m', 10)).toHaveLength(0);
      // Changed hash → vectors dropped, doc is pending again.
      store.upsertDoc({ relPath: 'a.md', title: 'A', text: 'Rewritten content, quite different.', mtime: 3, size: 6, hash: 'h2' }, 3);
      expect(store.getDocsMissingVector('m', 10)).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe('scanFolder', () => {
  it('indexes txt/md, counts skips by extension, and guards size/binary', async () => {
    const root = freshFolder();
    writeFileSync(join(root, 'note.md'), '# Cottage plan\nThe deposit is 400 euro, due in August.');
    writeFileSync(join(root, 'todo.txt'), 'Call the plumber about the boiler valve.');
    writeFileSync(join(root, 'photo.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    writeFileSync(join(root, 'report.pdf'), 'not really a pdf');
    writeFileSync(join(root, 'binary.txt'), Buffer.from([0x41, 0x00, 0x42]));
    writeFileSync(join(root, 'huge.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config.md'), 'never indexed');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'pkg.md'), 'never indexed');

    const store = freshStore();
    try {
      const res = await scanFolder(store, root);
      expect(res.indexed).toBe(2);
      expect(res.skippedByExt['.jpg']).toBe(1);
      // .pdf is a supported type now; a file that only pretends to be one is
      // counted as unreadable, not as an unsupported extension.
      expect(res.skippedByExt[SKIP_PDF_UNREADABLE]).toBe(1);
      expect(res.skippedByExt[SKIP_BINARY]).toBe(1);
      expect(res.skippedByExt[SKIP_TOO_LARGE]).toBe(1);
      // Dot-dirs and node_modules are ignored silently, not counted as skips.
      expect(Object.values(res.skippedByExt).reduce((s, n) => s + n, 0)).toBe(4);

      const status = store.readStatus();
      expect(status.indexedCount).toBe(2);
      expect(status.skippedCount).toBe(4);
      expect(status.lastScanTs).not.toBeNull();

      const hits = ftsSearchDocs(store.handle(), 'plumber boiler');
      expect(hits).toHaveLength(1);
      expect(hits[0].relPath).toBe('todo.txt');
      // Markdown title comes from the first heading.
      expect(ftsSearchDocs(store.handle(), 'deposit august')[0].title).toBe('Cottage plan');
    } finally {
      store.close();
    }
  });

  it('is incremental: edits reindex, deletions prune, untouched files are not reread', async () => {
    const root = freshFolder();
    const keep = join(root, 'keep.md');
    const edit = join(root, 'edit.md');
    const gone = join(root, 'gone.md');
    writeFileSync(keep, 'Stable note about the garden fence.');
    writeFileSync(edit, 'First draft about the car insurance.');
    writeFileSync(gone, 'Temporary note soon deleted.');
    backdate(keep);
    backdate(edit);
    backdate(gone);

    const store = freshStore();
    try {
      await scanFolder(store, root);
      expect(store.readStatus().indexedCount).toBe(3);

      writeFileSync(edit, 'Second draft: the car insurance moved to Allianz.');
      rmSync(gone);
      const res = await scanFolder(store, root);
      expect(res.indexed).toBe(2);
      expect(res.removed).toBe(1);

      expect(ftsSearchDocs(store.handle(), 'allianz insurance')).toHaveLength(1);
      expect(ftsSearchDocs(store.handle(), 'temporary deleted')).toHaveLength(0);
      expect(ftsSearchDocs(store.handle(), 'garden fence')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('indexes PDF text layers with metadata titles and reindexes edits', async () => {
    const root = freshFolder();
    const invoice = join(root, 'invoice.pdf');
    writeFileSync(
      invoice,
      makePdf(
        [
          ['Invoice 2024-018 for Awantech', 'Deposit: 400 euro, due in August.'],
          ['Second page: bank reference SK-7781.']
        ],
        'Awantech Invoice'
      )
    );
    backdate(invoice);

    const store = freshStore();
    try {
      const res = await scanFolder(store, root);
      expect(res.indexed).toBe(1);
      expect(Object.keys(res.skippedByExt)).toHaveLength(0);

      // Both pages land in one doc; the title comes from PDF metadata.
      const hits = ftsSearchDocs(store.handle(), 'deposit august');
      expect(hits).toHaveLength(1);
      expect(hits[0].relPath).toBe('invoice.pdf');
      expect(hits[0].title).toBe('Awantech Invoice');
      expect(ftsSearchDocs(store.handle(), 'bank reference')).toHaveLength(1);

      // An edited PDF is re-extracted and re-indexed.
      writeFileSync(invoice, makePdf([['Corrected deposit: 500 euro.']]));
      await scanFolder(store, root);
      expect(ftsSearchDocs(store.handle(), 'corrected deposit')).toHaveLength(1);
      expect(ftsSearchDocs(store.handle(), 'bank reference')).toHaveLength(0);
      // No metadata title → filename.
      expect(ftsSearchDocs(store.handle(), 'corrected deposit')[0].title).toBe('invoice');
    } finally {
      store.close();
    }
  });

  it('skips image-only PDFs once and remembers them across rescans', async () => {
    const root = freshFolder();
    const scanOnly = join(root, 'scan.pdf');
    writeFileSync(scanOnly, makePdf([[]]));
    backdate(scanOnly);

    const store = freshStore();
    try {
      const res1 = await scanFolder(store, root);
      expect(res1.indexed).toBe(0);
      expect(res1.skippedByExt[SKIP_PDF_NO_TEXT]).toBe(1);
      const cached = JSON.parse(store.readMeta('extract_skip_cache') ?? '{}') as Record<string, { reason: string }>;
      expect(cached['scan.pdf']?.reason).toBe(SKIP_PDF_NO_TEXT);

      // Unchanged (mtime, size) → still counted as skipped, served from cache.
      const res2 = await scanFolder(store, root);
      expect(res2.skippedByExt[SKIP_PDF_NO_TEXT]).toBe(1);

      // Rewritten with real text → cache entry invalidated, doc indexed.
      writeFileSync(scanOnly, makePdf([['Now it has an OCR text layer.']]));
      const res3 = await scanFolder(store, root);
      expect(res3.indexed).toBe(1);
      expect(res3.skippedByExt[SKIP_PDF_NO_TEXT]).toBeUndefined();
      expect(JSON.parse(store.readMeta('extract_skip_cache') ?? '{}')).toEqual({});
    } finally {
      store.close();
    }
  });

  it('indexes Word documents — .docx and legacy .doc — with filename titles', async () => {
    const root = freshFolder();
    writeFileSync(
      join(root, 'minutes.docx'),
      makeDocx(['Meeting minutes for the cottage purchase.', 'Deposit agreed: 400 euro, due in August.'])
    );
    // Legacy OLE .doc is not practical to synthesize; a real Word 97 file
    // (generated once with macOS textutil) lives in fixtures.
    copyFileSync(new URL('../fixtures/legacy-word.doc', import.meta.url), join(root, 'contract.doc'));

    const store = freshStore();
    try {
      const res = await scanFolder(store, root);
      expect(res.indexed).toBe(2);
      expect(Object.keys(res.skippedByExt)).toHaveLength(0);

      const docxHits = ftsSearchDocs(store.handle(), 'deposit august');
      expect(docxHits).toHaveLength(1);
      expect(docxHits[0].relPath).toBe('minutes.docx');
      // word-extractor exposes no metadata title → filename.
      expect(docxHits[0].title).toBe('minutes');

      const docHits = ftsSearchDocs(store.handle(), 'boiler contract renewal');
      expect(docHits).toHaveLength(1);
      expect(docHits[0].relPath).toBe('contract.doc');
      expect(docHits[0].title).toBe('contract');

      // An edited document is re-extracted and re-indexed.
      writeFileSync(join(root, 'minutes.docx'), makeDocx(['Corrected deposit: 500 euro.']));
      await scanFolder(store, root);
      expect(ftsSearchDocs(store.handle(), 'corrected deposit')).toHaveLength(1);
      // FTS terms are OR-ed, so probe with words that only the old text had.
      expect(ftsSearchDocs(store.handle(), 'august meeting')).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it('skips unreadable and empty Word files once and remembers them across rescans', async () => {
    const root = freshFolder();
    const fake = join(root, 'fake.doc');
    const empty = join(root, 'empty.docx');
    writeFileSync(fake, 'not really a word document');
    writeFileSync(empty, makeDocx([]));
    backdate(fake);
    backdate(empty);

    const store = freshStore();
    try {
      const res1 = await scanFolder(store, root);
      expect(res1.indexed).toBe(0);
      expect(res1.skippedByExt[SKIP_WORD_UNREADABLE]).toBe(1);
      expect(res1.skippedByExt[SKIP_WORD_NO_TEXT]).toBe(1);
      const cached = JSON.parse(store.readMeta('extract_skip_cache') ?? '{}') as Record<string, { reason: string }>;
      expect(cached['fake.doc']?.reason).toBe(SKIP_WORD_UNREADABLE);
      expect(cached['empty.docx']?.reason).toBe(SKIP_WORD_NO_TEXT);

      // Unchanged (mtime, size) → still counted as skipped, served from cache.
      const res2 = await scanFolder(store, root);
      expect(res2.skippedByExt[SKIP_WORD_UNREADABLE]).toBe(1);
      expect(res2.skippedByExt[SKIP_WORD_NO_TEXT]).toBe(1);

      // Rewritten with real text → cache entries invalidated, docs indexed.
      writeFileSync(empty, makeDocx(['Now it says something worth indexing.']));
      const res3 = await scanFolder(store, root);
      expect(res3.indexed).toBe(1);
      expect(res3.skippedByExt[SKIP_WORD_NO_TEXT]).toBeUndefined();
      expect(ftsSearchDocs(store.handle(), 'worth indexing')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('seeds the skip cache from the legacy pdf_skip_cache meta key', async () => {
    const root = freshFolder();
    const scanOnly = join(root, 'scan.pdf');
    // Garbage bytes: extraction would report pdf-unreadable. The planted legacy
    // cache says pdf-no-text — seeing that reason proves the entry was served
    // from the migrated cache, not re-extracted.
    writeFileSync(scanOnly, 'not really a pdf');
    backdate(scanOnly);
    const s = statSync(scanOnly);

    const store = freshStore();
    try {
      store.writeMeta(
        'pdf_skip_cache',
        JSON.stringify({ 'scan.pdf': { mtime: Math.floor(s.mtimeMs), size: s.size, reason: SKIP_PDF_NO_TEXT } })
      );
      const res = await scanFolder(store, root);
      expect(res.skippedByExt[SKIP_PDF_NO_TEXT]).toBe(1);
      expect(res.skippedByExt[SKIP_PDF_UNREADABLE]).toBeUndefined();
      // The entry now lives under the new key.
      const cached = JSON.parse(store.readMeta('extract_skip_cache') ?? '{}') as Record<string, { reason: string }>;
      expect(cached['scan.pdf']?.reason).toBe(SKIP_PDF_NO_TEXT);
    } finally {
      store.close();
    }
  });
});

describe('embedMissingDocVectors + hybridSearchDocs', () => {
  const fakeClient = (vec: number[]): EmbeddingsClient => ({
    available: async () => true,
    modelId: async () => 'fake-model',
    embed: async (texts) => texts.map(() => Float32Array.from(vec))
  });

  it('embeds pending docs and the hybrid search fuses both legs', async () => {
    const root = freshFolder();
    writeFileSync(join(root, 'trip.md'), '# Vienna trip\nThe hotel booking reference is VN-2211.');
    const store = freshStore();
    try {
      await scanFolder(store, root);
      expect(store.readStatus().pendingEmbeds).toBe(1);

      const written = await embedMissingDocVectors(store, fakeClient([0.5, 0.5]));
      expect(written).toBe(1);
      expect(store.readStatus().pendingEmbeds).toBe(0);

      const hits = await hybridSearchDocs(store.handle(), 'vienna hotel booking', {
        limit: 3,
        embedQuery: async () => ({ vec: Float32Array.from([0.5, 0.5]), model: 'fake-model' })
      });
      expect(hits).toHaveLength(1);
      expect(hits[0].relPath).toBe('trip.md');
      // Both legs saw it: bm25 evidence + cosine evidence survive fusion.
      expect(hits[0].ftsScore).toBeLessThan(0);
      expect(hits[0].cosine).toBeCloseTo(1, 5);
    } finally {
      store.close();
    }
  });

  it('FTS-only search ranks best-first on the shared RRF scale (no embeddings)', async () => {
    const root = freshFolder();
    writeFileSync(join(root, 'strong.md'), 'Vienna hotel booking: the Vienna hotel reservation and booking confirmation for the Vienna trip.');
    writeFileSync(join(root, 'weak.md'), 'A note that mentions a hotel once among unrelated grocery lists and errands.');
    const store = freshStore();
    try {
      await scanFolder(store, root);
      const hits = await hybridSearchDocs(store.handle(), 'vienna hotel booking', { limit: 3 });
      expect(hits.map((h) => h.relPath)).toEqual(['strong.md', 'weak.md']);
      // RRF scale on every path: positive, higher = better. Raw bm25 leaking
      // through the FTS-only path (negative, more-negative = better) inverted
      // this ordering and the cross-folder merge in folder-index/index.ts.
      expect(hits.every((h) => h.score > 0)).toBe(true);
      expect(hits[0].score).toBeGreaterThan(hits[1].score);
      expect(hits[0].ftsScore).toBeLessThan(0);
    } finally {
      store.close();
    }
  });

  it('short docs are FTS-searchable but never queued for embedding', async () => {
    const root = freshFolder();
    writeFileSync(join(root, 'tiny.md'), 'ok thanks');
    const store = freshStore();
    try {
      await scanFolder(store, root);
      expect(store.readStatus().indexedCount).toBe(1);
      expect(store.readStatus().pendingEmbeds).toBe(0);
      expect(await embedMissingDocVectors(store, fakeClient([1]))).toBe(0);
    } finally {
      store.close();
    }
  });

  // The pass swallows embedding failures and returns a count, so the caller can't
  // tell a dead worker from a folder with nothing to do. The activity registry is
  // the only place that distinction survives.
  it('reports an embedding failure to the activity registry', async () => {
    const root = freshFolder();
    writeFileSync(join(root, 'trip.md'), '# Vienna trip\nThe hotel booking reference is VN-2211.');
    const store = freshStore();
    activity.resetActivity();
    try {
      await scanFolder(store, root);
      const dead: EmbeddingsClient = {
        available: async () => true,
        modelId: async () => 'fake-model',
        embed: async () => {
          throw new Error('worker died');
        }
      };
      expect(await embedMissingDocVectors(store, dead)).toBe(0);
      const snap = activity.snapshot();
      expect(snap.unseenFailure).toBe(true);
      expect(snap.history[0]).toMatchObject({ kind: 'folders.embed', state: 'failed', error: 'worker died' });
    } finally {
      activity.resetActivity();
      store.close();
    }
  });
});

describe('end to end: registry → scan → recall injection', () => {
  it('an indexed folder\'s note reaches the injected recall payload with provenance', async () => {
    // Module imports are inside the test so the setup-unit env (throwaway
    // connected-folders store + folder-index dir) is unmistakably in effect.
    const { addConnectedFolders, updateConnectedFolder } = await import('../../src/server/workspace/connected-folders');
    const { scanAllIndexedFolders, searchFolderDocs } = await import('../../src/server/folder-index');
    const { buildRecallContext } = await import('../../src/server/recall/inject');
    const { folderIndexDir } = await import('../../src/server/workspace/paths');
    const { readFileSync } = await import('node:fs');

    const root = freshFolder();
    writeFileSync(join(root, 'kotolna.md'), '# Boiler room\nThe boiler service contract number is BX-7781, expires in November.');

    const [folder] = await addConnectedFolders([root]);
    await updateConnectedFolder(folder.id, { index: true, memorize: false });
    await scanAllIndexedFolders();

    // The manifest for the MCP server lists the indexed folder.
    const manifest = JSON.parse(readFileSync(join(folderIndexDir(), 'manifest.json'), 'utf8'));
    expect(manifest.folders.map((f: { id: string }) => f.id)).toContain(folder.id);

    // Cross-folder search finds the doc and carries the privacy flag.
    const hits = await searchFolderDocs('boiler service contract');
    expect(hits).toHaveLength(1);
    expect(hits[0].relPath).toBe('kotolna.md');
    expect(hits[0].private).toBe(true);

    // The recall context payload carries the doc with folder/path provenance,
    // and the private-docs flag fires so the caller taints the turn. A private
    // folder's excerpts are never logged for fact learning.
    const flags: { privateDocsInjected?: boolean } = {};
    const injectedDocs: import('../../src/server/recall/store').InjectedDocRef[] = [];
    const context = await buildRecallContext('what is the boiler service contract number?', { flags, injectedDocs });
    expect(context).not.toBeNull();
    expect(context!).toContain('folderDocuments');
    expect(context!).toContain('kotolna.md');
    expect(context!).toContain('BX-7781');
    expect(flags.privateDocsInjected).toBe(true);
    expect(injectedDocs).toHaveLength(0);

    // Memorize on (default learn mode 'use') → the same hit becomes
    // learn-eligible and lands in the injected-docs sink with its excerpt.
    await updateConnectedFolder(folder.id, { memorize: true });
    const eligibleHits = await searchFolderDocs('boiler service contract');
    expect(eligibleHits[0].learnEligible).toBe(true);
    const eligibleDocs: import('../../src/server/recall/store').InjectedDocRef[] = [];
    await buildRecallContext('what is the boiler service contract number?', { injectedDocs: eligibleDocs });
    expect(eligibleDocs).toHaveLength(1);
    expect(eligibleDocs[0].folderId).toBe(folder.id);
    expect(eligibleDocs[0].relPath).toBe('kotolna.md');
    expect(eligibleDocs[0].excerpt).toContain('BX-7781');

    // Un-indexing drops the DB file and the doc stops surfacing.
    await updateConnectedFolder(folder.id, { index: false });
    const { syncFolderIndexes } = await import('../../src/server/folder-index');
    await syncFolderIndexes();
    expect(await searchFolderDocs('boiler service contract')).toHaveLength(0);
  });
});

describe('docTitle / docEmbedText', () => {
  it('prefers the first markdown heading, falls back to the filename', () => {
    expect(docTitle('a/b/plan.md', '## Kitchen renovation\ndetails')).toBe('Kitchen renovation');
    expect(docTitle('a/b/plan.md', 'no heading here')).toBe('plan');
  });

  it('bounds the embed input and includes the title', () => {
    const text = 'x'.repeat(5000);
    const input = docEmbedText('Title', text);
    expect(input).not.toBeNull();
    expect(input!.startsWith('Title\n')).toBe(true);
    expect(input!.length).toBe(1500);
    expect(docEmbedText('T', 'short')).toBeNull();
  });
});
