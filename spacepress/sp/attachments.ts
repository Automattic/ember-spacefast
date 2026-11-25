import { HttpError, mutation, query } from "spacepress";
import { attachmentDevices, attachments, memberships } from "spacepress:db";
import { attachmentChunks } from "./schema";
import { actor, numericId, personView, requireRoom } from "./access";
import { consumeRate } from "./records";
import { attachmentReservationCutoff } from "./upload-access";

const chunkSize = 4194304;
const maxFileSize = 262144000;
const workspaceId = "ember-wordpress";
type Chunk = { id: string; url: string; iv: string; size: number };
type Picture = { width: number; height: number; thumbnail?: { type: string; size: number; chunks: Chunk[] } };
type Wrap = { recipientId: string; recipientPublicKey: string; iv: string; key: string };
export type Manifest = {
  version: number; name: string; type: string; size: number; chunks: Chunk[]; picture?: Picture;
  key?: string; fileId?: string; senderDeviceId?: string; senderPublicKey?: string; wraps?: Wrap[];
};

function hex(value: string, length: number) {
  return value.length === length && /^[a-f0-9]+$/.test(value);
}

function validPublicKey(value: string) {
  if (value.length !== 130 || !/^04[a-f0-9]{128}$/.test(value)) return false;
  const prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const b = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
  const x = BigInt("0x" + value.slice(2, 66));
  const y = BigInt("0x" + value.slice(66));
  return x < prime && y < prime && (y * y - x * x * x + 3n * x - b) % prime === 0n;
}

async function registered(deviceId: string) {
  const [device] = await attachmentDevices.system.list({ where: { deviceId }, limit: 1 });
  return device;
}

export const attachmentDeviceList = query({ access: "authenticated" }, async ({ deviceId }: { deviceId?: string }) => {
  const me = await actor();
  const devices = await attachmentDevices.system.list({ where: { personId: me.wpId, active: true }, limit: 5 });
  const current = deviceId ? await registered(deviceId) : undefined;
  return {
    workspaceId, personId: me.id,
    currentDeviceRevoked: Boolean(current && current.personId === me.wpId && !current.active),
    devices: devices.map(device => ({ deviceId: device.deviceId, publicKey: device.publicKey, createdAt: device.createdAt })),
  };
});

export const registerAttachmentDevice = mutation({ access: "authenticated", rateLimit: "20/hour" }, async (input: {
  deviceId: string; publicKey: string; expectedPersonId?: string;
}) => {
  const me = await actor();
  if ((input.expectedPersonId && input.expectedPersonId !== me.id) || !hex(input.deviceId, 32) || !validPublicKey(input.publicKey)) {
    throw new HttpError(422, "invalid_device", "Invalid attachment device.");
  }
  const previous = await registered(input.deviceId);
  if (previous) {
    if (previous.personId !== me.wpId || !previous.active || previous.publicKey !== input.publicKey) {
      throw new HttpError(403, "device_unavailable", "Attachment device unavailable.");
    }
    return { deviceId: previous.deviceId, publicKey: previous.publicKey, createdAt: previous.createdAt };
  }
  if (await attachmentDevices.system.count({ where: { personId: me.wpId, active: true } }) >= 5) {
    throw new HttpError(422, "device_limit", "Remove an attachment device before adding another.");
  }
  const device = await attachmentDevices.system.create({ personId: me.wpId, deviceId: input.deviceId, publicKey: input.publicKey });
  return { deviceId: device.deviceId, publicKey: device.publicKey, createdAt: device.createdAt };
});

export const revokeAttachmentDevice = mutation({ access: "authenticated" }, async ({ id, expectedPersonId }: { id: string; expectedPersonId?: string }) => {
  const me = await actor();
  const device = await registered(id);
  if (!device || device.personId !== me.wpId || (expectedPersonId && expectedPersonId !== me.id)) {
    throw new HttpError(404, "device_unavailable", "Attachment device unavailable.");
  }
  await attachmentDevices.system.update(device.id, { active: false });
  return true;
});

async function roster(roomId: number) {
  const me = await actor();
  const room = await requireRoom(roomId);
  const devices: { personId: string; publicKey: string; deviceId: string }[] = [];
  let missing = 0;
  if (room.closed) {
    const members = await memberships.system.list({ where: { roomId }, limit: 500 });
    for (const member of members) {
      const person = await personView(member.personId);
      if (person.status !== "active" || person.role === "bot") continue;
      const active = await attachmentDevices.system.list({ where: { personId: member.personId, active: true }, limit: 5 });
      if (!active.length) missing++;
      for (const device of active) devices.push({ personId: String(member.personId), deviceId: device.deviceId, publicKey: device.publicKey });
    }
    if (devices.length > 256) throw new HttpError(422, "too_many_devices", "Too many attachment devices in this room.");
  }
  return { protected: room.closed, workspaceId, senderId: me.id, missing, devices };
}

export const attachmentRecipients = query({ access: "authenticated" }, async ({ id }: { id: string }) => {
  return await roster(numericId(id));
});

export const reserveFile = mutation({ access: "authenticated", rateLimit: "20/hour" }, async (input: {
  roomId: string; name: string; type: string; size: number; expectedCreatorId?: string;
}) => {
  const me = await actor();
  const room = await requireRoom(numericId(input.roomId));
  if (input.expectedCreatorId && input.expectedCreatorId !== me.id) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
  if (!input.name.trim() || input.name.length > 255 || !Number.isInteger(input.size) || input.size < 1 || input.size > maxFileSize) {
    throw new HttpError(422, "invalid_file", "Invalid attachment details.");
  }
  await consumeRate(me.id + ":file-bytes", 500 * 1024 * 1024, 3600000, input.size);
  const file = await attachments.system.create({ roomId: room.id, personId: me.wpId, name: input.name, type: input.type, size: input.size });
  return { id: String(file.id) };
});

function chunkId(id: string) {
  if (!hex(id, 32)) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
  const value = parseInt(id, 16);
  if (!Number.isInteger(value) || value < 1 || value > 9007199254740991) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
  return value;
}

async function checkedChunks(chunks: Chunk[], size: number, owner: number, ids: string[], nonces: string[]) {
  if (!Number.isInteger(size) || size < 1 || size > maxFileSize || chunks.length !== Math.ceil(size / chunkSize)) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
  const result: Chunk[] = [];
  let index = 0;
  for (const chunk of chunks) {
    const expected = Math.min(chunkSize, size - index * chunkSize);
    if (!hex(chunk.iv, 24) || ids.includes(chunk.id) || nonces.includes(chunk.iv) || chunk.size !== expected) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
    const stored = await attachmentChunks.get(chunkId(chunk.id));
    if (!stored || stored.ownerId !== owner || stored.size !== expected + 16) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
    ids.push(chunk.id);
    nonces.push(chunk.iv);
    result.push({ id: chunk.id, iv: chunk.iv, size: expected, url: "" });
    index++;
  }
  return result;
}

export async function acceptAttachment(value: string, manifest: Manifest, withMessage: boolean) {
  const me = await actor();
  const id = numericId(value);
  const file = await attachments.system.get(id);
  if (!file || file.personId !== me.wpId) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
  const room = await requireRoom(file.roomId);
  if (file.status === "attached" && withMessage) return file;
  if (file.status !== "uploading" || file.createdAt <= attachmentReservationCutoff() ||
    manifest.name !== file.name || manifest.type !== file.type || manifest.size !== file.size) {
    throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
  }
  if (manifest.version !== (room.closed ? 2 : 1) || JSON.stringify(manifest).length > 150000) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
  if (room.closed) {
    const current = await roster(room.id);
    const sender = current.devices.find(device => device.deviceId === manifest.senderDeviceId);
    const wraps = manifest.wraps ?? [];
    if (manifest.key !== undefined || !withMessage || manifest.fileId !== value || current.missing || !sender || sender.personId !== me.id || sender.publicKey !== manifest.senderPublicKey ||
      wraps.length !== current.devices.length || !current.devices.every(device =>
        wraps.filter(wrap => wrap.recipientId === device.deviceId && wrap.recipientPublicKey === device.publicKey && hex(wrap.iv, 24) && hex(wrap.key, 96)).length === 1)) {
      throw new HttpError(422, "device_roster_changed", "Attachment devices changed. Reload the room and try again.");
    }
  } else if (!hex(manifest.key ?? "", 64)) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");

  const ids: string[] = [];
  const nonces: string[] = [];
  const chunks = await checkedChunks(manifest.chunks, file.size, me.wpId, ids, nonces);
  const picture = manifest.picture;
  let normalized: Picture | undefined;
  if (picture) {
    if (!file.type.startsWith("image/") || file.type === "image/svg+xml" || !Number.isInteger(picture.width) ||
      !Number.isInteger(picture.height) || picture.width < 1 || picture.height < 1 || picture.width * picture.height > 250000000) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
    const preview = picture.thumbnail;
    if (preview) {
      if (!["image/webp", "image/png", "image/jpeg"].includes(preview.type) || preview.size > chunkSize) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
      const previewChunks = await checkedChunks(preview.chunks, preview.size, me.wpId, ids, nonces);
      normalized = { width: picture.width, height: picture.height, thumbnail: { type: preview.type, size: preview.size, chunks: previewChunks } };
    } else normalized = { width: picture.width, height: picture.height };
  }
  const stored = { ...manifest, chunks, picture: normalized };
  return await attachments.system.update(id, { manifest: JSON.stringify(stored), status: "ready" });
}

async function signedChunks(chunks: Chunk[]) {
  const result: Chunk[] = [];
  for (const chunk of chunks) {
    const stored = await attachmentChunks.get(chunkId(chunk.id));
    if (!stored) throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
    result.push({ ...chunk, url: stored.url });
  }
  return result;
}

async function signedManifest(manifest: Manifest) {
  const picture = manifest.picture;
  const preview = picture?.thumbnail;
  const signed = picture && preview ? { ...picture, thumbnail: { ...preview, chunks: await signedChunks(preview.chunks) } } : picture;
  return { ...manifest, chunks: await signedChunks(manifest.chunks), picture: signed };
}

export async function attachmentSummary(id: number) {
  if (!id) return undefined;
  const file = await attachments.system.get(id);
  if (!file || !file.manifest || file.status === "deleted") return undefined;
  const manifest = JSON.parse(file.manifest) as Manifest;
  const picture = manifest.picture;
  const summary = {
    id: String(id), name: file.name, type: file.type, size: file.size, version: manifest.version,
    workspaceId, roomId: String(file.roomId), senderId: String(file.personId),
    picture: picture ? { width: picture.width, height: picture.height, thumbnail: Boolean(picture.thumbnail) } : undefined,
    manifest: manifest.version === 1 ? await signedManifest(manifest) : undefined,
  };
  return summary;
}

export const attachment = query({ access: "authenticated" }, async ({ id, deviceId }: { id: string; deviceId?: string }) => {
  const me = await actor();
  const file = await attachments.system.get(numericId(id));
  if (!file || file.status !== "attached") throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
  await requireRoom(file.roomId);
  const manifest = JSON.parse(file.manifest) as Manifest;
  if (manifest.version === 1) return await signedManifest(manifest);
  const device = deviceId ? await registered(deviceId) : undefined;
  const wrap = manifest.wraps?.find(item => item.recipientId === deviceId);
  if (!device || !device.active || device.personId !== me.wpId || !wrap || device.publicKey !== wrap.recipientPublicKey) return null;
  return { ...(await signedManifest(manifest)), workspaceId, roomId: String(file.roomId), senderId: String(file.personId), wraps: [wrap] };
});

export const cancelFile = mutation({ access: "authenticated" }, async ({ id }: { id: string }) => {
  const me = await actor();
  const file = await attachments.system.get(numericId(id));
  if (!file || file.personId !== me.wpId || file.status !== "uploading") throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
  await attachments.system.update(file.id, { status: "deleted" });
  return true;
});
