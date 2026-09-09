import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({fetch: vi.fn(), exists: true, size: 42}));
vi.mock('expo/fetch', () => ({fetch: native.fetch}));
vi.mock('expo-file-system', () => ({File: class { async bytes() { return new Uint8Array([1, 2, 3]); } get type() { return null; } get exists() {return native.exists;} get size() {return native.size;} }}));
vi.mock('../src/drafts/store', () => ({MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024}));
import { uploadAttachment } from '../src/transport/upload';
const pairing = {serverUrl:'https://example.test',deviceId:'device',token:'fictional-token'};
const attachment = {id:'a',uri:'file:///draft/a',name:'hello & world.txt',mime:'text/plain',size:42};
beforeEach(() => {native.fetch.mockReset(); native.exists = true; native.size = 42;});
it('uploads raw file with authentication, rejects redirects, and maps handle to path', async () => {
  native.fetch.mockResolvedValue({ok:true,json:async () => ({ok:true,result:{handle:'stem-upload:fixture'}})});
  expect(await uploadAttachment(pairing,attachment)).toEqual({name:attachment.name,mime:'text/plain',path:'stem-upload:fixture'});
  expect(native.fetch).toHaveBeenCalledWith('https://example.test/upload?name=hello%20%26%20world.txt',expect.objectContaining({method:'POST',redirect:'error',body:new Uint8Array([1,2,3]),headers:{Authorization:'Bearer fictional-token','Content-Type':'text/plain'}}));
});
it('retains retryable input after a failed or unconfirmed upload', async () => {
  native.fetch.mockResolvedValue({ok:false,status:503});
  await expect(uploadAttachment(pairing,attachment)).rejects.toThrow('draft is saved');
  native.fetch.mockResolvedValue({ok:true,json:async () => ({ok:true,result:{handle:'/unsafe/path'}})});
  await expect(uploadAttachment(pairing,attachment)).rejects.toThrow('did not confirm');
  expect(attachment.uri).toBe('file:///draft/a');
});
it('checks current file existence and size before networking', async () => {
  native.exists = false;
  await expect(uploadAttachment(pairing,attachment)).rejects.toThrow('no longer available');
  native.exists = true; native.size = 100 * 1024 * 1024 + 1;
  await expect(uploadAttachment(pairing,attachment)).rejects.toThrow('100 MiB');
  expect(native.fetch).not.toHaveBeenCalled();
});
