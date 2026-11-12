import type { Reader, Writer } from './access';
import { accessRoom, account, person } from './access';
import { consumeRate } from './rate';

const DEVICES_PER_PERSON = 5;
const MAX_ROOM_MEMBERS = 500;
export const MAX_ATTACHMENT_RECIPIENTS = 256;
const deviceIdPattern = /^[a-f0-9]{32}$/;
function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 32 && deviceIdPattern.test(value);
}
const p256Prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const p256B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

export function isPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 130 || !/^04[a-f0-9]{128}$/.test(value)) return false;
  const x = BigInt('0x' + value.slice(2, 66));
  const y = BigInt('0x' + value.slice(66));
  return x < p256Prime && y < p256Prime &&
    (y * y - x * x * x + 3n * x - p256B) % p256Prime === 0n;
}

export function protectedRoom(room: {private: boolean; kind: string}) {
  return room.private || room.kind === 'direct';
}

export async function attachmentWorkspace(ctx: Reader) {
  const workspace = await account(ctx);
  if (!workspace) throw new Error('Workspace unavailable.');
  return workspace.id;
}

export function registeredDevice(ctx: Reader, workspaceId: string, deviceId: string) {
  return ctx.db.attachmentDevices.withIndex('by_workspace_device', q => q.eq('workspaceId', workspaceId).eq('deviceId', deviceId)).first();
}

function activeDevices(ctx: Reader, workspaceId: string, personId: string) {
  return ctx.db.attachmentDevices.withIndex('by_workspace_person_active', q => q.eq('workspaceId', workspaceId).eq('personId', personId).eq('active', true)).take(DEVICES_PER_PERSON + 1);
}

export async function attachmentDevices(ctx: Reader, currentDeviceId?: string) {
  const me = await person(ctx);
  const workspaceId = await attachmentWorkspace(ctx);
  const devices = await activeDevices(ctx, workspaceId, me.id);
  const current = isDeviceId(currentDeviceId)
    ? await registeredDevice(ctx, workspaceId, currentDeviceId) : null;
  return {
    workspaceId, personId: me.id, currentDeviceRevoked: current?.personId === me.id && !current.active,
    devices: devices.map(({deviceId, publicKey, createdAt}) => ({deviceId, publicKey, createdAt})),
  };
}

export async function registerAttachmentDevice(ctx: Writer, input: {deviceId: string; publicKey: string; expectedPersonId?: string}) {
  const me = await person(ctx);
  if (input.expectedPersonId !== undefined && input.expectedPersonId !== me.id) throw new Error("Attachment account changed.");
  if (me.role === 'bot' || !isDeviceId(input.deviceId) || !isPublicKey(input.publicKey)) {
    throw new Error('Invalid attachment device.');
  }
  const workspaceId = await attachmentWorkspace(ctx);
  const existing = await registeredDevice(ctx, workspaceId, input.deviceId);
  if (existing) {
    if (existing.personId !== me.id || !existing.active || existing.publicKey !== input.publicKey) {
      throw new Error('Attachment device unavailable.');
    }
    return {deviceId: existing.deviceId, publicKey: existing.publicKey, createdAt: existing.createdAt};
  }
  const devices = await activeDevices(ctx, workspaceId, me.id);
  if (devices.length >= DEVICES_PER_PERSON) throw new Error('Remove an attachment device before adding another.');
  await consumeRate(ctx, me.id, 'attachment-device', 20, 3600000);
  const {deviceId, publicKey, createdAt} = await ctx.db.attachmentDevices.insert({
    workspaceId, personId: me.id, deviceId: input.deviceId, publicKey: input.publicKey, active: true,
  });
  return {deviceId, publicKey, createdAt};
}

export async function revokeAttachmentDevice(ctx: Writer, deviceId: string, expectedPersonId?: string) {
  const me = await person(ctx);
  if (expectedPersonId !== undefined && expectedPersonId !== me.id) throw new Error("Attachment account changed.");
  if (!isDeviceId(deviceId)) throw new Error('Attachment device unavailable.');
  const device = await registeredDevice(ctx, await attachmentWorkspace(ctx), deviceId);
  if (!device || device.personId !== me.id) throw new Error('Attachment device unavailable.');
  if (device.active) await ctx.db.attachmentDevices.update(device.id, {active: false});
  return true;
}

export async function attachmentRecipients(ctx: Reader, roomId: string) {
  const {me, room} = await accessRoom(ctx, roomId);
  const workspaceId = await attachmentWorkspace(ctx);
  const protectedRoomAccess = protectedRoom(room);
  const devices: {deviceId: string; publicKey: string; personId: string}[] = [];
  const roster = {workspaceId, senderId: me.id, protected: protectedRoomAccess, devices, missing: 0};
  if (!protectedRoomAccess) return roster;

  const memberships = await ctx.db.members.withIndex('by_room', q => q.eq('roomId', room.id)).take(MAX_ROOM_MEMBERS + 1);
  if (memberships.length > MAX_ROOM_MEMBERS) throw new Error('This room is too large for encrypted attachments.');
  const people = await Promise.all([...new Set(memberships.map(membership => membership.personId))]
    .map(personId => ctx.db.people.get(personId)));
  for (const recipient of people) {
    if (!recipient || recipient.status !== 'active' || recipient.role === 'bot') continue;
    const keys = await activeDevices(ctx, workspaceId, recipient.id);
    if (!keys.length) roster.missing += 1;
    for (const {deviceId, publicKey} of keys) devices.push({deviceId, publicKey, personId: recipient.id});
    if (devices.length > MAX_ATTACHMENT_RECIPIENTS) throw new Error('This room has too many encrypted attachment devices.');
  }
  return roster;
}
