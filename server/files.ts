import { consumeRate } from './rate';
import type { Writer, Reader } from './access';
import { accessRoom, clean, person } from './access';
import {
  attachmentRecipients, attachmentWorkspace, isPublicKey,
  MAX_ATTACHMENT_RECIPIENTS, protectedRoom, registeredDevice,
} from './attachment-devices';
import { sendCommittedAttachment, type MessageInput } from './writes';

const CHUNK_SIZE = 4 * 1024 * 1024;
const MAX_FILE_SIZE = 250 * 1024 * 1024;

interface Chunk {id: string; url: string; iv: string; size: number}
interface Thumbnail {type: string; size: number; chunks: Chunk[]}
interface Picture {width: number; height: number; thumbnail?: Thumbnail}
interface BaseManifest {name: string; type: string; size: number; chunks: Chunk[]; picture?: Picture}
interface LegacyManifest extends BaseManifest {version: 1; key: string}
interface Wrap {recipientId: string; recipientPublicKey: string; iv: string; key: string}
interface ProtectedManifest extends BaseManifest {
  version: 2; fileId: string; senderDeviceId: string; senderPublicKey: string; wraps: Wrap[];
}
type Manifest = LegacyManifest | ProtectedManifest;
type StoredManifest = LegacyManifest | (ProtectedManifest & {workspaceId: string});
type CommitMessage = Omit<MessageInput, 'roomId' | 'fileId'>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hex(value: unknown, length: number): value is string {
  return typeof value === 'string' && value.length === length && /^[a-f0-9]+$/.test(value);
}

function validSize(size: unknown): size is number {
  return typeof size === 'number' && Number.isSafeInteger(size) && size >= 1 && size <= MAX_FILE_SIZE;
}

export function validateManifest(value: unknown): Manifest {
  if (!object(value) || JSON.stringify(value).length > 150000) throw new Error('Invalid attachment.');
  const {version, name, type, size, chunks} = value;
  if ((version !== 1 && version !== 2) || typeof name !== 'string' || !name.trim() || name.length > 255 ||
      typeof type !== 'string' || type.length > 200 || !validSize(size) ||
      !Array.isArray(chunks) || chunks.length !== Math.ceil(size / CHUNK_SIZE)) throw new Error('Invalid attachment.');

  const nonces = new Set<string>();
  const ids = new Set<string>();
  function validChunk(chunk: unknown, expectedSize: number): Chunk {
    if (!object(chunk)) throw new Error('Invalid attachment chunk.');
    const {id, url, iv, size: chunkSize} = chunk;
    if (!hex(id, 32) || typeof url !== 'string' || url.length > 2000 ||
        url.split('?')[0] !== '/__stattic/u/' + id ||
        !/^\/__stattic\/u\/[a-f0-9]{32}(?:\?k=[A-Za-z0-9_-]+)?$(?![\s\S])/.test(url) ||
        !hex(iv, 24) || nonces.has(iv) || ids.has(id) ||
        chunkSize !== expectedSize) throw new Error('Invalid attachment chunk.');
    nonces.add(iv);
    ids.add(id);
    return {id, url, iv, size: chunkSize};
  }
  const validChunks = chunks.map((chunk: unknown, index) => validChunk(chunk, Math.min(CHUNK_SIZE, size - index * CHUNK_SIZE)));
  let picture: Picture | undefined;
  if (value.picture !== undefined) {
    if (!object(value.picture) || !type.startsWith('image/') || type === 'image/svg+xml') throw new Error('Invalid attachment picture.');
    const {width, height, thumbnail} = value.picture;
    if (typeof width !== 'number' || typeof height !== 'number' ||
        !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
        width < 1 || height < 1 || width * height > 250_000_000) throw new Error('Invalid attachment picture.');
    picture = {width, height};
    if (thumbnail !== undefined) {
      if (!object(thumbnail) || typeof thumbnail.type !== 'string' || !['image/webp', 'image/png', 'image/jpeg'].includes(thumbnail.type) ||
          !validSize(thumbnail.size) || thumbnail.size > CHUNK_SIZE || !Array.isArray(thumbnail.chunks) || thumbnail.chunks.length !== 1) {
        throw new Error('Invalid attachment thumbnail.');
      }
      picture.thumbnail = {type: thumbnail.type, size: thumbnail.size, chunks: [validChunk(thumbnail.chunks[0], thumbnail.size)]};
    }
  }
  const base = {name, type, size, chunks: validChunks, ...(picture && {picture})};
  if (version === 1) {
    if (!hex(value.key, 64)) throw new Error('Invalid attachment.');
    return {...base, version, key: value.key};
  }

  const {fileId, senderDeviceId, senderPublicKey, wraps} = value;
  if (Object.hasOwn(value, 'key') || typeof fileId !== 'string' || !fileId || fileId.length > 200 ||
      !hex(senderDeviceId, 32) || !isPublicKey(senderPublicKey) ||
      !Array.isArray(wraps) || !wraps.length || wraps.length > MAX_ATTACHMENT_RECIPIENTS) {
    throw new Error('Invalid encrypted attachment.');
  }
  const recipients = new Set<string>();
  const validWraps = wraps.map((wrap: unknown): Wrap => {
    if (!object(wrap)) throw new Error('Invalid attachment recipient.');
    const {recipientId, recipientPublicKey, iv, key} = wrap;
    if (!hex(recipientId, 32) || recipients.has(recipientId) || !isPublicKey(recipientPublicKey) ||
        !hex(iv, 24) || !hex(key, 96)) throw new Error('Invalid attachment recipient.');
    recipients.add(recipientId);
    return {recipientId, recipientPublicKey, iv, key};
  });
  return {...base, version, fileId, senderDeviceId, senderPublicKey, wraps: validWraps};
}

export async function reserveFile(ctx: Writer, input: {roomId: string; name: string; type: string; size: number; expectedCreatorId?: string}) {
  const {me, room} = await accessRoom(ctx, input.roomId, input.expectedCreatorId);
  if (!validSize(input.size)) throw new Error('Invalid attachment size.');
  const name = clean(input.name, 255);
  if (!name) throw new Error('Attachment name required.');
  await consumeRate(ctx, me.id, 'file-count', 20, 3600000);
  await consumeRate(ctx, me.id, 'file-bytes', 500 * 1024 * 1024, 3600000, input.size);
  return ctx.db.files.insert({roomId: room.id, creatorId: me.id, name, type: clean(input.type, 200), size: String(input.size), parts: '', key: '', status: 'uploading'});
}

export async function commitFile(ctx: Writer, input: {fileId: string; manifest: unknown; message?: CommitMessage}) {
  const file = await ctx.db.files.get(clean(input.fileId));
  if (!file) throw new Error('File unavailable.');
  if (input.message !== undefined && !object(input.message)) throw new Error('Invalid attachment message.');
  const {me, room} = await accessRoom(ctx, file.roomId, input.message?.expectedCreatorId);
  if (file.creatorId !== me.id) throw new Error('File unavailable.');
  const message = input.message && {...input.message, roomId: room.id, fileId: file.id};
  if (file.status === 'attached' && message) return sendCommittedAttachment(ctx, message);
  if (file.status !== 'uploading') throw new Error('File unavailable.');

  const manifest = validateManifest(input.manifest);
  if (manifest.name !== file.name || manifest.type !== file.type || String(manifest.size) !== file.size) {
    throw new Error('Attachment changed.');
  }
  if (protectedRoom(room) !== (manifest.version === 2)) throw new Error('Attachment encryption requirements changed.');
  let stored: StoredManifest;
  if (manifest.version === 2) {
    if (manifest.fileId !== file.id) throw new Error('Attachment changed.');
    if (!message) throw new Error('Encrypted attachments must be posted with a message.');
    const roster = await attachmentRecipients(ctx, room.id);
    const sender = roster.devices.find(device => device.deviceId === manifest.senderDeviceId);
    const wraps = new Map(manifest.wraps.map(wrap => [wrap.recipientId, wrap.recipientPublicKey]));
    if (roster.missing || sender?.personId !== me.id || sender.publicKey !== manifest.senderPublicKey ||
        wraps.size !== roster.devices.length || roster.devices.some(device => wraps.get(device.deviceId) !== device.publicKey)) {
      throw new Error('Attachment devices changed. Check the room’s devices and try again.');
    }
    stored = {...manifest, workspaceId: roster.workspaceId};
  } else {
    stored = manifest;
  }

  await ctx.db.files.update(file.id, {parts: JSON.stringify(stored), status: 'ready'});
  if (!message) return {id: file.id};
  const result = await sendCommittedAttachment(ctx, message);
  await ctx.db.files.update(file.id, {status: 'attached'});
  return result;
}

export async function attachment(ctx: Reader, fileId: string, deviceId?: string) {
  const file = await ctx.db.files.get(clean(fileId));
  if (!file || (file.status !== 'ready' && file.status !== 'attached')) throw new Error('File unavailable.');
  const {me, room} = await accessRoom(ctx, file.roomId);
  const manifest = JSON.parse(file.parts) as StoredManifest;
  if (manifest.version === 1) return manifest;

  if (file.status !== 'attached' || !hex(deviceId, 32) || manifest.workspaceId !== await attachmentWorkspace(ctx)) {
    throw new Error('Encrypted attachment unavailable for this device.');
  }
  const device = await registeredDevice(ctx, manifest.workspaceId, deviceId);
  const wrap = manifest.wraps.find(item => item.recipientId === deviceId);
  if (!device?.active || device.personId !== me.id || !wrap || wrap.recipientPublicKey !== device.publicKey) return null;
  return {...manifest, wraps: [wrap], roomId: room.id, senderId: file.creatorId};
}

export async function cancelFile(ctx: Writer, fileId: string) {
  const me = await person(ctx);
  const file = await ctx.db.files.get(clean(fileId));
  if (!file || file.creatorId !== me.id || file.status !== 'uploading') throw new Error('Upload unavailable.');
  await ctx.db.files.update(file.id, {status: 'deleted', parts: '', key: ''});
  return true;
}
