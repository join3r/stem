import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ConnectedFolder } from '../../src/shared/types';
import { FolderIndexStore } from '../../src/server/folder-index/store';
import {
  DOC_DISTILL_INSTRUCTIONS,
  DOC_FACT_CONFIDENCE,
  PER_DOC_CHAR_CAP,
  buildLearnBatch,
  learnFolderBatch
} from '../../src/server/folder-index/learn';
import { RELATION_PROMPT_HEADER } from '../../src/server/recall/reconcile';
import type { LlmClient } from '../../src/server/recall/llm';
import { recallStore } from '../../src/server/recall/store';
import {
  CURSOR_KEY,
  buildDistillBatch,
  buildDocsBlock,
  distillNewMessages
} from '../../src/server/recall/distill';

// Goal 3 — folder fact learning: the learned_hash marker engine ('new'/'all'
// modes), the doc distiller, folder-tagged facts with 'folder_doc' evidence,
// and the learn-on-use leg (injected-doc log → conversation distill citation).

const dir = mkdtempSync(join(tmpdir(), 'stem-folder-learn-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let storeSeq = 0;
function freshStore(): FolderIndexStore {
  return new FolderIndexStore(() => join(dir, `learn-${storeSeq++}.sqlite`));
}

function fakeFolder(id: string, over: Partial<ConnectedFolder> = {}): ConnectedFolder {
  return {
    id,
    path: join(dir, id),
    label: 'Test Vault',
    mode: 'read',
    memorize: true,
    index: true,
    learnMode: 'all',
    ...over
  };
}

const llmReturning = (reply: string): LlmClient => ({ complete: async () => reply });

const claimsReply = (claims: unknown[]): string => JSON.stringify({ claims });

describe('connected-folder learn settings', () => {
  it('coerces and patches learnMode/learnModel; effective mode gates on index+memorize', async () => {
    const { addConnectedFolders, effectiveLearnMode, listConnectedFolders, updateConnectedFolder } = await import(
      '../../src/server/workspace/connected-folders'
    );
    const root = join(dir, 'settings-folder');
    mkdirSync(root, { recursive: true });
    // Paths are canonicalized on add (tmpdir may resolve through symlinks), so
    // match by the distinctive basename rather than the raw path.
    const byPath = (fs: ConnectedFolder[]): ConnectedFolder => fs.find((x) => x.path.endsWith('settings-folder'))!;
    let f = byPath(await addConnectedFolders([root]));
    // Default: mode absent (= 'use'), but not effective until Index is on.
    expect(f.learnMode).toBeUndefined();
    expect(effectiveLearnMode(f)).toBe('off');
    f = byPath(await updateConnectedFolder(f.id, { index: true }));
    expect(effectiveLearnMode(f)).toBe('use');

    f = byPath(await updateConnectedFolder(f.id, { learnMode: 'all', learnModel: 'prov/model-x' }));
    expect(f.learnMode).toBe('all');
    expect(f.learnModel).toBe('prov/model-x');
    expect(effectiveLearnMode(f)).toBe('all');

    // memorize off forces 'off' regardless of the stored mode.
    f = byPath(await updateConnectedFolder(f.id, { memorize: false }));
    expect(effectiveLearnMode(f)).toBe('off');
    f = byPath(await updateConnectedFolder(f.id, { memorize: true }));

    // 'use' is the absent default; empty model string clears the override. The
    // settings survive a reload (coerce round-trip).
    f = byPath(await updateConnectedFolder(f.id, { learnMode: 'use', learnModel: '' }));
    expect(f.learnMode).toBeUndefined();
    expect(f.learnModel).toBeUndefined();
    f = byPath(await listConnectedFolders());
    expect(f.learnMode).toBeUndefined();
    expect(effectiveLearnMode(f)).toBe('use');
  });
});

describe('learned_hash markers', () => {
  it('tracks pending docs oldest-first and seeds via stampAllLearned', () => {
    const store = freshStore();
    try {
      store.upsertDoc({ relPath: 'new.md', title: 'New', text: 'Newer note text.', mtime: 2000, size: 5, hash: 'hn' }, 1);
      store.upsertDoc({ relPath: 'old.md', title: 'Old', text: 'Older note text.', mtime: 1000, size: 5, hash: 'ho' }, 1);
      expect(store.pendingLearnCount()).toBe(2);
      // Oldest mtime first — chronological replay for the supersede machinery.
      expect(store.pendingLearnDocs(10).map((d) => d.relPath)).toEqual(['old.md', 'new.md']);

      // 'new'-mode seeding: everything current counts as learned.
      store.stampAllLearned();
      expect(store.pendingLearnCount()).toBe(0);

      // An edit re-pends exactly that doc; stampLearned clears it again.
      store.upsertDoc({ relPath: 'old.md', title: 'Old', text: 'Edited note text.', mtime: 3000, size: 6, hash: 'ho2' }, 2);
      expect(store.pendingLearnCount()).toBe(1);
      const [pending] = store.pendingLearnDocs(10);
      expect(pending.relPath).toBe('old.md');
      store.stampLearned([pending.id]);
      expect(store.pendingLearnCount()).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe('buildLearnBatch', () => {
  it('packs oldest-first, truncates oversized docs, and bounds the batch', () => {
    const store = freshStore();
    try {
      store.upsertDoc({ relPath: 'big.md', title: 'Big', text: 'z'.repeat(PER_DOC_CHAR_CAP + 500), mtime: 1000, size: 1, hash: 'h1' }, 1);
      store.upsertDoc({ relPath: 'later.md', title: 'Later', text: 'A later small note.', mtime: 2000, size: 1, hash: 'h2' }, 1);
      const batch = buildLearnBatch(store)!;
      expect(batch.docs.map((d) => d.relPath)).toEqual(['big.md', 'later.md']);
      expect(batch.block).toContain('[doc:1 path:"big.md"');
      expect(batch.block).toContain('[…truncated]');

      // A tight budget still takes at least the head doc, nothing more.
      const tight = buildLearnBatch(store, 100)!;
      expect(tight.docs).toHaveLength(1);
      expect(tight.docs[0].relPath).toBe('big.md');
    } finally {
      store.close();
    }
  });
});

describe('learnFolderBatch', () => {
  it('writes folder-tagged facts with folder_doc evidence and stamps the batch', async () => {
    const store = freshStore();
    try {
      store.upsertDoc(
        { relPath: 'contracts/boiler.md', title: 'Boiler', text: 'The boiler service contract QX-4411 with ThermoServ runs until 2027.', mtime: 1_700_000_000_000, size: 10, hash: 'h1' },
        1
      );
      const folder = fakeFolder('learnfolder-1');
      const res = await learnFolderBatch(
        store,
        folder,
        llmReturning(
          claimsReply([
            {
              text: 'The user\'s boiler service contract QX-4411 with ThermoServ runs until 2027.',
              category: 'finance',
              sensitivity: 'standard',
              validUntil: null,
              evidenceDocIds: [1],
              supersedesFactIds: [],
              conflictsWithFactIds: []
            }
          ])
        )
      );
      expect(res).toEqual({ processed: 1, written: 1 });
      expect(store.pendingLearnCount()).toBe(0);
      expect(store.readLearnTs()).not.toBeNull();

      expect(recallStore.countFactsBySource('folder:learnfolder-1')).toBe(1);
      const fact = recallStore.getAllFacts().find((f) => f.source === 'folder:learnfolder-1')!;
      expect(fact.confidence).toBeCloseTo(DOC_FACT_CONFIDENCE, 5);
      const details = recallStore.getFactDetails(fact.id)!;
      expect(details.evidence).toHaveLength(1);
      expect(details.evidence[0].origin).toBe('folder_doc');
      expect(details.evidence[0].folderId).toBe('learnfolder-1');
      expect(details.evidence[0].relPath).toBe('contracts/boiler.md');
      expect(details.evidence[0].timestamp).toBe(1_700_000_000);
      expect(details.evidence[0].messageId).toBeNull();

      // Nothing pending → the next call is a no-op null.
      expect(await learnFolderBatch(store, folder, llmReturning(claimsReply([])))).toBeNull();
    } finally {
      store.close();
    }
  });

  it('an empty-claims reply still consumes the batch; a failed call retries', async () => {
    const store = freshStore();
    try {
      store.upsertDoc({ relPath: 'a.md', title: 'A', text: 'Nothing durable in here at all.', mtime: 1000, size: 5, hash: 'h1' }, 1);
      const folder = fakeFolder('learnfolder-2');

      const failing: LlmClient = { complete: async () => { throw new Error('model down'); } };
      expect(await learnFolderBatch(store, folder, failing)).toEqual({ processed: 0, written: 0 });
      expect(store.pendingLearnCount()).toBe(1); // unstamped → retried later

      expect(await learnFolderBatch(store, folder, llmReturning(claimsReply([])))).toEqual({ processed: 1, written: 0 });
      expect(store.pendingLearnCount()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('gives an unparseable batch up after the strike limit instead of wedging', async () => {
    const store = freshStore();
    try {
      store.upsertDoc({ relPath: 'p.md', title: 'P', text: 'Poison batch that the model mangles.', mtime: 1000, size: 5, hash: 'h1' }, 1);
      const folder = fakeFolder('learnfolder-3');
      const garbage = llmReturning('%%% not json, not bullets');

      expect(await learnFolderBatch(store, folder, garbage)).toEqual({ processed: 0, written: 0 });
      expect(await learnFolderBatch(store, folder, garbage)).toEqual({ processed: 0, written: 0 });
      expect(store.pendingLearnCount()).toBe(1);
      // Third strike: stamped-and-skipped, learning moves on.
      expect(await learnFolderBatch(store, folder, garbage)).toEqual({ processed: 1, written: 0 });
      expect(store.pendingLearnCount()).toBe(0);
    } finally {
      store.close();
    }
  });
});

describe('temporal succession (doc-over-doc authority)', () => {
  const relationLlm = (claims: unknown[], verdict: string): LlmClient => ({
    complete: async (prompt) =>
      prompt.includes(RELATION_PROMPT_HEADER) ? JSON.stringify({ verdict }) : claimsReply(claims)
  });
  const docEvidence = (folderId: string, ts: number) => [
    { messageId: null, threadId: null, role: null, timestamp: ts, excerpt: 'seed', origin: 'folder_doc' as const, folderId, relPath: 'seed.pdf' }
  ];
  const claimFor = (text: string, over: Record<string, unknown> = {}): unknown => ({
    text, category: 'finance', sensitivity: 'standard', validUntil: null,
    evidenceDocIds: [1], supersedesFactIds: [], conflictsWithFactIds: [], ...over
  });

  it('anchors extraction to natural identifiers (gap 3 prompt regression)', () => {
    expect(DOC_DISTILL_INSTRUCTIONS).toMatch(/invoice number/i);
    expect(DOC_DISTILL_INSTRUCTIONS).toMatch(/DIFFERENT identifiers/);
  });

  it('a newer doc fact silently supersedes an older doc fact on a supersede verdict', async () => {
    const conflictsBefore = recallStore.getMemoryConflicts().length;
    const old = recallStore.upsertFact('The ts1 domain is registered through 2026.', {
      source: 'folder:ts-1', evidence: docEvidence('ts-1', 1_700_000_000)
    })!;
    const store = freshStore();
    try {
      store.upsertDoc({ relPath: 'renewal.pdf', title: 'R', text: 'ts1 domain renewed through 2027.', mtime: 1_800_000_000_000, size: 10, hash: 'h1' }, 1);
      await learnFolderBatch(store, fakeFolder('ts-1'), relationLlm(
        [claimFor('The ts1 domain is registered through 2027.', { supersedesFactIds: [old] })],
        'b_supersedes_a'
      ));
      const renewed = recallStore.getAllFacts().find((f) => /ts1 domain is registered through 2027/.test(f.text))!;
      expect(recallStore.getFactDetails(old)?.status).toBe('superseded');
      expect(recallStore.getFactDetails(old)?.supersededBy).toBe(renewed.id);
      expect(recallStore.getFactDetails(renewed.id)?.status).toBe('active');
      expect(recallStore.getMemoryConflicts()).toHaveLength(conflictsBefore);
    } finally {
      store.close();
    }
  });

  it('a stale doc processed late loses to the newer existing fact instead of clobbering it', async () => {
    const conflictsBefore = recallStore.getMemoryConflicts().length;
    const current = recallStore.upsertFact('The ts2 fee is €134.07 per month.', {
      source: 'folder:ts-2', evidence: docEvidence('ts-2', 1_800_000_000)
    })!;
    const store = freshStore();
    try {
      store.upsertDoc({ relPath: 'old-fee.pdf', title: 'O', text: 'ts2 fee was €129.15.', mtime: 1_700_000_000_000, size: 10, hash: 'h1' }, 1);
      await learnFolderBatch(store, fakeFolder('ts-2'), relationLlm(
        [claimFor('The ts2 fee is €129.15 per month.', { supersedesFactIds: [current] })],
        'a_supersedes_b'
      ));
      const stale = recallStore.getAllFacts().find((f) => /ts2 fee is €129.15/.test(f.text))!;
      expect(recallStore.getFactDetails(stale.id)?.status).toBe('superseded');
      expect(recallStore.getFactDetails(stale.id)?.supersededBy).toBe(current);
      expect(recallStore.getFactDetails(current)?.status).toBe('active');
      expect(recallStore.getMemoryConflicts()).toHaveLength(conflictsBefore);
    } finally {
      store.close();
    }
  });

  it('a doc fact never silently supersedes a conversation-derived fact — conflict instead', async () => {
    const conflictsBefore = recallStore.getMemoryConflicts().length;
    const distilled = recallStore.upsertFact('The user pays €129.15 for the ts3 service.', 'distilled')!;
    const store = freshStore();
    try {
      store.upsertDoc({ relPath: 'invoice.pdf', title: 'I', text: 'ts3 service now €134.07.', mtime: 1_800_000_000_000, size: 10, hash: 'h1' }, 1);
      await learnFolderBatch(store, fakeFolder('ts-3'), relationLlm(
        [claimFor('The user pays €134.07 for the ts3 service.', { supersedesFactIds: [distilled] })],
        'b_supersedes_a'
      ));
      expect(recallStore.getFactDetails(distilled)?.status).toBe('conflicted');
      expect(recallStore.getFactDetails(distilled)?.supersededBy).toBeNull();
      const conflicts = recallStore.getMemoryConflicts();
      expect(conflicts).toHaveLength(conflictsBefore + 1);
      expect(conflicts[0].reason).toMatch(/appears to update/);
    } finally {
      store.close();
    }
  });

  it('gates the ambiguous "conflictsWith" path on the verdict (regression: was unconditional)', async () => {
    const conflictsBefore = recallStore.getMemoryConflicts().length;
    const target = recallStore.upsertFact('The user has a ts4 appointment with a deposit due.', {
      source: 'folder:ts-4', evidence: docEvidence('ts-4', 1_700_000_000)
    })!;
    const store = freshStore();
    try {
      store.upsertDoc({ relPath: 'note.md', title: 'N', text: 'Interpreter secured for ts4 appointment.', mtime: 1_800_000_000_000, size: 10, hash: 'h1' }, 1);
      await learnFolderBatch(store, fakeFolder('ts-4'), relationLlm(
        [claimFor('An interpreter was secured for the user\'s ts4 appointment.', { conflictsWithFactIds: [target] })],
        'compatible'
      ));
      expect(recallStore.getMemoryConflicts()).toHaveLength(conflictsBefore);
      expect(recallStore.getFactDetails(target)?.status).toBe('active');
    } finally {
      store.close();
    }
  });
});

describe('forgetFactsBySource', () => {
  it('deletes a folder\'s learned facts but spares pinned ones', () => {
    const a = recallStore.upsertFact('The user\'s test vineyard lease ends in 2029.', { source: 'folder:forget-x' })!;
    const b = recallStore.upsertFact('The user\'s test apiary permit renews yearly.', { source: 'folder:forget-x' })!;
    recallStore.setFactPinned(b, true);
    expect(a).not.toBeNull();
    expect(recallStore.countFactsBySource('folder:forget-x')).toBe(2);
    expect(recallStore.forgetFactsBySource('folder:forget-x')).toBe(1);
    const left = recallStore.getAllFacts().filter((f) => f.source === 'folder:forget-x');
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(b);
  });
});

describe('learn on use: injected-doc log → distill citation', () => {
  it('folds unconsumed doc excerpts into the distill batch and writes folder_doc evidence', async () => {
    // Two captured messages under one turn, plus an injected-doc log row.
    recallStore.recordMessage({ threadId: 'th-use', turnId: 'turn-use-1', role: 'user', text: 'How much was the cottage deposit again?', ts: 1_700_000_100 });
    recallStore.recordMessage({ threadId: 'th-use', turnId: 'turn-use-1', role: 'assistant', text: 'Your notes say the cottage deposit was 450 euro.', ts: 1_700_000_101 });
    recallStore.recordTurnInjectedDocs('th-use', 'turn-use-1', [
      { folderId: 'usefolder-1', folderLabel: 'Vault', relPath: 'cottage.md', mtime: 1_699_000_000_000, excerpt: 'Cottage rental: the deposit is 450 euro, paid on arrival.' }
    ]);

    const firstId = recallStore.getMessagesForDistillFrom(1, 1)[0].id;
    const batch = buildDistillBatch({ messageId: firstId, offset: 0 })!;
    expect(batch.docs).toHaveLength(1);
    expect(batch.docs[0].key).toBe(1);
    expect(batch.docs[0].relPath).toBe('cottage.md');
    const block = buildDocsBlock(batch.docs);
    expect(block).toContain('[doc:1 folder:"Vault" path:"cottage.md"');
    expect(block).toContain('deposit is 450 euro');

    // Drive the real conversation distiller with a doc-citing reply.
    recallStore.setMeta(CURSOR_KEY, JSON.stringify({ messageId: firstId, offset: 0 }));
    let sawDocsSection = false;
    const llm: LlmClient = {
      complete: async (prompt) => {
        sawDocsSection = prompt.includes('Documents shown to the assistant') && prompt.includes('[doc:1');
        return claimsReply([
          {
            text: 'The user\'s cottage rental deposit is 450 euro.',
            category: 'finance',
            sensitivity: 'standard',
            validUntil: null,
            evidenceMessageIds: [],
            evidenceDocIds: [1],
            supersedesFactIds: [],
            conflictsWithFactIds: []
          }
        ]);
      }
    };
    expect(await distillNewMessages(llm)).toBe(1);
    expect(sawDocsSection).toBe(true);

    const fact = recallStore.getAllFacts().find((f) => f.text.includes('cottage rental deposit'))!;
    expect(fact).toBeDefined();
    // Doc-only citations never earn the direct-user treatment.
    expect(fact.confidence).toBeCloseTo(0.55, 5);
    const details = recallStore.getFactDetails(fact.id)!;
    const docEvidence = details.evidence.filter((e) => e.origin === 'folder_doc');
    expect(docEvidence).toHaveLength(1);
    expect(docEvidence[0].folderId).toBe('usefolder-1');
    expect(docEvidence[0].relPath).toBe('cottage.md');

    // The log row was consumed with the segment — a later batch can't recite it.
    expect(recallStore.getUnconsumedTurnDocs(['turn-use-1'])).toHaveLength(0);
  });
});

describe("'new' mode chosen before the first scan", () => {
  it('counts the files the first scan finds as learned, and learns only later ones', async () => {
    const { writeFileSync } = await import('node:fs');
    const { addConnectedFolders, updateConnectedFolder } = await import('../../src/server/workspace/connected-folders');
    const { learnAllIndexedFolders, scanAllIndexedFolders, seedFolderLearnMarks } = await import(
      '../../src/server/folder-index'
    );
    const root = join(dir, 'fresh-new-mode');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'old-a.md'), '# A\nThe garage door code is 4411.');
    writeFileSync(join(root, 'old-b.md'), '# B\nThe boiler is serviced every November.');

    // What the connect wizard does: connect, then index + 'new' in one patch,
    // before any scan has run (the IPC handler seeds the marks right away).
    const folder = (await addConnectedFolders([root])).find((f) => f.path.endsWith('fresh-new-mode'))!;
    await updateConnectedFolder(folder.id, { index: true, learnMode: 'new' });
    await seedFolderLearnMarks(folder.id);

    const seen: string[] = [];
    const makeLlm = (): LlmClient => ({
      complete: async (prompt: string) => {
        seen.push(prompt);
        return claimsReply([]);
      }
    });

    await scanAllIndexedFolders();
    await learnAllIndexedFolders({ makeLlm });
    expect(seen).toHaveLength(0);

    writeFileSync(join(root, 'later.md'), '# Later\nThe new router password is on the fridge.');
    await scanAllIndexedFolders();
    await learnAllIndexedFolders({ makeLlm });
    expect(seen.join('\n')).toContain('router password');
    expect(seen.join('\n')).not.toContain('garage door');

    await updateConnectedFolder(folder.id, { index: false });
  });
});
