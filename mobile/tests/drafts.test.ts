import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ rows: new Map<string,string>(), files: new Map<string,number>(), copyWait: null as Promise<void> | null }));
vi.mock('expo-sqlite', () => ({openDatabaseSync: () => ({execSync() {}, getFirstSync(_sql: string,id: string) {const value = fake.rows.get(id); return value ? {value} : null;}, runSync(sql: string,id?: string,value?: string) {if (sql.startsWith('INSERT')) fake.rows.set(id!,value!); else if (id) fake.rows.delete(id); else fake.rows.clear();}})}));
vi.mock('expo-file-system', () => {
  class Directory {uri: string; constructor(...parts: (string | {uri: string})[]) {this.uri = parts.map(p => typeof p === 'string' ? p : p.uri).join('/');} get exists() {return true;} create() {} delete() {for (const key of fake.files.keys()) if (key.startsWith(this.uri)) fake.files.delete(key);} }
  class File extends Directory {get exists() {return fake.files.has(this.uri);} get size() {return fake.files.get(this.uri) ?? 0;} async copy(target: File) {const size = this.size; if (fake.copyWait) await fake.copyWait; fake.files.set(target.uri,size);} delete() {fake.files.delete(this.uri);} }
  return {Directory,File,Paths:{document:'file:///documents'}};
});
import { submitDraft } from '../src/drafts/send';
import { addDraftAttachment, beginDraftSend, isDraftSending, clearDraft, clearDrafts, draftGeneration, MAX_ATTACHMENT_BYTES, readDraft, removeDraftAttachment, updateDraft } from '../src/drafts/store';
beforeEach(() => {clearDrafts(); fake.files.clear(); fake.copyWait = null;});
describe('persistent drafts', () => {
  it('keeps body, mail metadata and attachment copies isolated from another account', async () => {
    updateDraft('account-a/chat', draft => ({...draft,body:'unsent',metadata:{subject:'Saved subject',private:true}}));
    fake.files.set('file:///picked',42);
    await addDraftAttachment('account-a/chat',{uri:'file:///picked',name:'note.txt'});
    expect(JSON.parse(fake.rows.get('account-a/chat')!)).toMatchObject({body:'unsent',metadata:{subject:'Saved subject',private:true}});
    expect(readDraft('account-b/chat').body).toBe('');
    expect(readDraft('account-a/chat').attachments[0].uri).toContain('stem-draft-files');
    expect(fake.files.has('file:///picked')).toBe(true);
  });
  it('rejects oversized picks before copying and retains existing text', async () => {
    updateDraft('a', draft => ({...draft,body:'keep'}));
    fake.files.set('file:///large',MAX_ATTACHMENT_BYTES + 1);
    await expect(addDraftAttachment('a',{uri:'file:///large',name:'large'})).rejects.toThrow('100 MiB');
    expect(readDraft('a').body).toBe('keep');
    expect(readDraft('a').attachments).toEqual([]);
  });
  it('removes owned copies on discard and unpair without deleting picker originals', async () => {
    fake.files.set('file:///picked',42);
    await addDraftAttachment('a',{uri:'file:///picked',name:'note'});
    const attachment = readDraft('a').attachments[0];
    removeDraftAttachment('a',attachment.id);
    expect(fake.files.has(attachment.uri)).toBe(false);
    expect(fake.files.has('file:///picked')).toBe(true);
    updateDraft('a',draft => ({...draft,body:'saved'}));
    clearDraft('a'); expect(fake.rows.has('a')).toBe(false);
    const before = draftGeneration(); clearDrafts(); expect(draftGeneration()).toBe(before + 1);
  });
});

it('shares the send lease across remounts and retains a failed send draft', () => {
  updateDraft('a', draft => ({...draft,body:'once'}));
  const lease = beginDraftSend('a');
  expect(isDraftSending('a')).toBe(true);
  expect(() => beginDraftSend('a')).toThrow('already');
  expect(() => updateDraft('a', draft => ({...draft,body:'new'}))).toThrow('sending');
  expect(() => clearDraft('a')).toThrow('sending');
  lease.finish(false);
  expect(readDraft('a').body).toBe('once');
  expect(isDraftSending('a')).toBe(false);
  beginDraftSend('a').finish(true);
  expect(readDraft('a').body).toBe('');
});
it('late send acceptance after unpair cannot clear a newer draft', () => {
  updateDraft('a', draft => ({...draft,body:'old'}));
  const lease = beginDraftSend('a');
  clearDrafts();
  updateDraft('a', draft => ({...draft,body:'new'}));
  lease.finish(true);
  expect(readDraft('a').body).toBe('new');
});
it('reports corrupt saved drafts and preserves the row until discard', () => {
  fake.rows.set('broken','{');
  expect(readDraft('broken').body).toBe('');
  expect(() => updateDraft('broken', draft => ({...draft,body:'replacement'}))).toThrow('saved draft');
  expect(fake.rows.get('broken')).toBe('{');
  clearDraft('broken');
  updateDraft('broken', draft => ({...draft,body:'replacement'}));
  expect(readDraft('broken').body).toBe('replacement');
});

it('does not submit to a new account after an in-flight upload completes', async () => {
  updateDraft('a', draft => ({...draft,body:'old account message'}));
  const lease = beginDraftSend('a');
  let resolveUpload!: (value: {name: string; path: string}) => void;
  const upload = vi.fn(() => new Promise<{name: string; path: string}>(resolve => { resolveUpload = resolve; }));
  const send = vi.fn(async () => {});
  const pending = submitDraft({lease,body:'old account message',attachments:[{id:'1',uri:'file:///a',name:'a',size:1}],upload,send});
  clearDrafts();
  updateDraft('new-account', draft => ({...draft,body:'new account message'}));
  resolveUpload({name:'a',path:'stem-upload:fixture'});
  await expect(pending).rejects.toThrow('account changed');
  expect(send).not.toHaveBeenCalled();
});
it('rejects malformed attachment entries without exposing them to the composer', () => {
  fake.rows.set('bad-attachment',JSON.stringify({body:'hello',metadata:{},attachments:[null]}));
  expect(readDraft('bad-attachment').attachments).toEqual([]);
  expect(() => beginDraftSend('bad-attachment')).toThrow('saved draft');
});

it('waits for the native copy before persisting attachment size or URI', async () => {
  fake.files.set('file:///picked',42);
  let complete!: () => void;
  fake.copyWait = new Promise<void>(resolve => { complete = resolve; });
  const pending = addDraftAttachment('copy',{uri:'file:///picked',name:'note'});
  expect(readDraft('copy').attachments).toEqual([]);
  expect(fake.rows.has('copy')).toBe(false);
  complete(); await pending;
  expect(readDraft('copy').attachments[0].size).toBe(42);
});
it('does not recreate an old-account draft when an asynchronous copy completes', async () => {
  fake.files.set('file:///picked',42);
  let complete!: () => void;
  fake.copyWait = new Promise<void>(resolve => { complete = resolve; });
  const pending = addDraftAttachment('copy',{uri:'file:///picked',name:'note'});
  clearDrafts(); complete();
  await expect(pending).rejects.toThrow('account or draft changed');
  expect(fake.rows.has('copy')).toBe(false);
  expect([...fake.files.keys()].filter(key => key.includes('stem-draft-files'))).toEqual([]);
});
it('rebases owned files from a previous iOS container and repairs an old null size', () => {
  fake.files.set('file:///documents/stem-draft-files/123-safe',42);
  fake.rows.set('rebase',JSON.stringify({body:'keep text',metadata:{},attachments:[{id:'123-safe',uri:'file:///old-container/Documents/stem-draft-files/123-safe',name:'note',size:null}]}));
  expect(readDraft('rebase')).toMatchObject({body:'keep text',attachments:[{uri:'file:///documents/stem-draft-files/123-safe',size:42}]});
});
