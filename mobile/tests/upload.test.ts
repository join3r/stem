import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({
  fetch: vi.fn(), exists: true, size: 42, bytes: new Uint8Array([1, 2, 3]),
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), jpegSize: 4,
  manipulate: vi.fn(), render: vi.fn(), save: vi.fn(), releaseImage: vi.fn(), releaseContext: vi.fn(), delete: vi.fn()
}));
vi.mock('expo/fetch', () => ({fetch: native.fetch}));
vi.mock('expo-file-system', () => ({File: class {
  constructor(readonly uri: string) {}
  async bytes() { return this.uri === 'file:///cache/converted.jpg' ? native.jpeg : native.bytes; }
  get exists() {return native.exists;}
  get size() {return this.uri === 'file:///cache/converted.jpg' ? native.jpegSize : native.size;}
  delete() {native.delete(this.uri);}
}}));
vi.mock('expo-image-manipulator', () => ({ImageManipulator: {manipulate: native.manipulate}, SaveFormat: {JPEG: 'jpeg'}}));
vi.mock('../src/drafts/store', () => ({MAX_ATTACHMENT_BYTES: 100 * 1024 * 1024}));
import { uploadAttachment } from '../src/transport/upload';
const pairing = {serverUrl:'https://example.test',deviceId:'device',token:'fictional-token'};
const attachment = {id:'a',uri:'file:///draft/a',name:'hello & world.txt',mime:'text/plain',size:42};
beforeEach(() => {
  vi.resetAllMocks(); native.exists = true; native.size = 42;
  native.bytes = new Uint8Array([1, 2, 3]); native.jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); native.jpegSize = 4;
  native.manipulate.mockReturnValue({renderAsync: native.render, release: native.releaseContext});
  native.render.mockResolvedValue({saveAsync: native.save, release: native.releaseImage});
  native.save.mockResolvedValue({uri: 'file:///cache/converted.jpg'});
  native.fetch.mockResolvedValue({ok:true,json:async () => ({ok:true,result:{handle:'stem-upload:fixture'}})});
});
it('uploads raw file with authentication, rejects redirects, and maps handle to path', async () => {
  native.fetch.mockResolvedValue({ok:true,json:async () => ({ok:true,result:{handle:'stem-upload:fixture'}})});
  expect(await uploadAttachment(pairing,attachment)).toEqual({name:attachment.name,mime:'text/plain',path:'stem-upload:fixture'});
  expect(native.fetch).toHaveBeenCalledWith('https://example.test/upload?name=hello%20%26%20world.txt',expect.objectContaining({method:'POST',redirect:'error',body:new Uint8Array([1,2,3]),headers:{Authorization:'Bearer fictional-token','Content-Type':'text/plain'}}));
  expect(native.manipulate).not.toHaveBeenCalled();
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

it.each([
  {name:'IMG_123.HEIC',mime:'image/heic'},
  {name:'from-files.heif',mime:undefined},
  {name:'photo',mime:'image/heif-sequence'},
  {name:'IMG_123.HEIC',mime:'image/jpeg'}
])('uploads HEIC/HEIF as a real JPEG with matching metadata: $name / $mime', async (metadata) => {
  const photo = {...attachment,...metadata};
  const result = await uploadAttachment(pairing,photo);
  expect(result).toEqual({name:metadata.name.replace(/\.[^.]+$/, '') + '.jpg',mime:'image/jpeg',path:'stem-upload:fixture'});
  expect(native.manipulate).toHaveBeenCalledWith(photo.uri);
  expect(native.save).toHaveBeenCalledWith({format:'jpeg',compress:0.95});
  expect(native.fetch).toHaveBeenCalledWith(expect.stringContaining(encodeURIComponent(result.name)),expect.objectContaining({
    body:native.jpeg,headers:{Authorization:'Bearer fictional-token','Content-Type':'image/jpeg'}
  }));
  expect(native.delete.mock.calls).toEqual([['file:///cache/converted.jpg']]);
  expect(native.releaseImage).toHaveBeenCalledOnce(); expect(native.releaseContext).toHaveBeenCalledOnce();
  expect(photo).toEqual({...attachment,...metadata});
});

it('detects HEIC bytes in an extensionless saved draft with incorrect picker MIME', async () => {
  native.bytes = new Uint8Array([0,0,0,24,...Array.from('ftypheic',c => c.charCodeAt(0))]);
  const result = await uploadAttachment(pairing,{...attachment,name:'photo',mime:'image/jpeg'});
  expect(result).toMatchObject({name:'photo.jpg',mime:'image/jpeg'});
  expect(native.manipulate).toHaveBeenCalledOnce();
});

it('corrects stale HEIC metadata without recompressing already converted JPEG bytes', async () => {
  native.bytes = native.jpeg;
  expect(await uploadAttachment(pairing,{...attachment,name:'photo.heic',mime:'image/heic'})).toMatchObject({name:'photo.jpg',mime:'image/jpeg'});
  expect(native.manipulate).not.toHaveBeenCalled();
  expect(native.fetch).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({body:native.jpeg}));
});

it('retains the original draft and skips upload when native decoding fails', async () => {
  native.render.mockRejectedValue(new Error('Cannot decode'));
  const photo = {...attachment,name:'broken.heic',mime:'image/heic'};
  await expect(uploadAttachment(pairing,photo)).rejects.toThrow('Your draft is saved');
  expect(native.fetch).not.toHaveBeenCalled(); expect(native.delete).not.toHaveBeenCalled();
  expect(native.releaseContext).toHaveBeenCalledOnce();
  expect(photo.uri).toBe(attachment.uri);
});

it('rejects oversized converted JPEGs and cleans up the temporary file', async () => {
  native.jpegSize = 100 * 1024 * 1024 + 1;
  await expect(uploadAttachment(pairing,{...attachment,name:'large.heic'})).rejects.toThrow('100 MiB');
  expect(native.fetch).not.toHaveBeenCalled();
  expect(native.delete.mock.calls).toEqual([['file:///cache/converted.jpg']]);
});

it('does not upload non-JPEG output under a JPEG MIME type', async () => {
  native.jpeg = new Uint8Array([1,2,3]);
  await expect(uploadAttachment(pairing,{...attachment,name:'photo.heic'})).rejects.toThrow('did not produce a JPEG');
  expect(native.fetch).not.toHaveBeenCalled();
  expect(native.delete.mock.calls).toEqual([['file:///cache/converted.jpg']]);
});

it('keeps failed HEIC uploads retryable and cleans up each converted copy', async () => {
  const photo = {...attachment,name:'photo.heic'};
  native.fetch.mockResolvedValueOnce({ok:false,status:503});
  await expect(uploadAttachment(pairing,photo)).rejects.toThrow('draft is saved');
  await expect(uploadAttachment(pairing,photo)).resolves.toMatchObject({name:'photo.jpg'});
  expect(native.delete.mock.calls).toEqual([['file:///cache/converted.jpg'],['file:///cache/converted.jpg']]);
});
