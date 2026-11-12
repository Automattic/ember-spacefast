import { empty, type EndpointRequest } from '@spacefast/zero/server';
import { accessRoom, person, type Reader, type Writer } from './access';
import { activityPushRequest, pushOrigin, vapidConfiguration } from './push-request.mjs';
import { consumeRate } from './rate';

type Room = NonNullable<Awaited<ReturnType<Reader['db']['rooms']['get']>>>;
type Message = NonNullable<Awaited<ReturnType<Reader['db']['messages']['get']>>>;
type Membership = Awaited<ReturnType<typeof findMembership>>;
type Delivery = NonNullable<Awaited<ReturnType<Reader['db']['pushDeliveries']['get']>>>;
const deviceLimit = 4;
const immediateLimit = 6;
const fanoutLimit = 24;
const minute = 60_000;

function config(ctx: Reader) {
  return vapidConfiguration(ctx.env.EMBER_PUSH_PRIVATE_KEY, ctx.env.EMBER_PUSH_CONTACT);
}

async function signedInMember(ctx: Reader, expected: unknown) {
  const member = await person(ctx);
  if (member.id !== expected || member.role === 'bot') throw new Error('Your Ember account changed.');
  return member;
}

async function subscriptionFor(ctx: Reader, endpoint: string) {
  const endpointHash = await ctx.crypto.sha256(endpoint);
  const subscription = await ctx.db.pushSubscriptions.withIndex('by_endpoint_hash', (q) => q.eq('endpointHash', endpointHash)).first();
  return { endpointHash, subscription };
}

export async function pushSettings(ctx: Reader, endpoint: unknown, expectedPersonId: unknown) {
  const member = await signedInMember(ctx, expectedPersonId);
  const publicKey = config(ctx)?.publicKey ?? null;
  if (typeof endpoint !== 'string' || !pushOrigin(endpoint)) return { publicKey, enabled: false, needsRefresh: false };
  const { subscription } = await subscriptionFor(ctx, endpoint);
  const enabled = subscription?.personId === member.id;
  return { publicKey, enabled, needsRefresh: Boolean(enabled && publicKey && subscription.publicKey !== publicKey) };
}

export async function savePush(ctx: Writer, input: { endpoint: unknown; expectedPersonId: unknown; publicKey: unknown }) {
  const member = await signedInMember(ctx, input.expectedPersonId);
  const keys = config(ctx);
  const endpoint = input.endpoint;
  if (!keys || input.publicKey !== keys.publicKey || typeof endpoint !== 'string' || !pushOrigin(endpoint)) {
    throw new Error('This browser’s push subscription is unavailable.');
  }
  const { endpointHash, subscription } = await subscriptionFor(ctx, endpoint);
  if (subscription) {
    if (subscription.personId !== member.id) throw new Error('This browser is already subscribed under another Ember account.');
    if (subscription.publicKey !== keys.publicKey) throw new Error('This browser’s push subscription needs to be refreshed.');
    return true;
  }
  await consumeRate(ctx, member.id, 'push-subscriptions', 12, 60 * minute);
  const existing = await ctx.db.pushSubscriptions.withIndex('by_person', (q) => q.eq('personId', member.id)).order('desc').take(deviceLimit);
  if (existing.length >= deviceLimit) await ctx.db.pushSubscriptions.delete(existing[deviceLimit - 1].id);
  await ctx.db.pushSubscriptions.insert({ personId: member.id, endpoint, endpointHash, publicKey: keys.publicKey });
  return true;
}

export async function removePush(ctx: Writer, input: { endpoint: unknown; expectedPersonId: unknown }) {
  const member = await signedInMember(ctx, input.expectedPersonId);
  if (typeof input.endpoint !== 'string' || !pushOrigin(input.endpoint)) return false;
  const { subscription } = await subscriptionFor(ctx, input.endpoint);
  if (subscription?.personId !== member.id) return false;
  await ctx.db.pushSubscriptions.delete(subscription.id);
  return true;
}

export async function revokeMemberPush(ctx: Writer, personId: string) {
  const devices = await ctx.db.pushSubscriptions.withIndex('by_person', (q) => q.eq('personId', personId)).take(deviceLimit);
  for (const device of devices) await ctx.db.pushSubscriptions.delete(device.id);
}

function findMembership(ctx: Reader, roomId: string, personId: string) {
  return ctx.db.members.withIndex('by_room_person', (q) => q.eq('roomId', roomId).eq('personId', personId)).first();
}

function mentionedIds(message: Message): Set<string> {
  return new Set((JSON.parse(message.mentions || '[]') as { id: string }[]).map((mention) => mention.id));
}

function eligible(room: Room, message: Message, personId: string, membership: Membership, mentioned: Set<string>) {
  if (room.archived || message.deleted || personId === message.creatorId) return false;
  if (!membership && (room.private || room.kind === 'direct')) return false;
  const preference = membership?.involvement || (room.kind === 'direct' ? 'everything' : 'mentions');
  if (preference !== 'everything' && (preference !== 'mentions' || !mentioned.has(personId))) return false;
  return !membership?.lastReadAt || membership.lastReadAt < message.createdAt;
}

export async function enqueuePush(ctx: Writer, room: Room, message: Message) {
  const keys = config(ctx);
  if (!keys || room.archived || message.deleted) return 0;
  const activeSubscription = await ctx.db.pushSubscriptions.withIndex('by_public_key', (q) => q.eq('publicKey', keys.publicKey)).first();
  if (!activeSubscription) return 0;
  const mentioned = mentionedIds(message);
  const members = await ctx.db.members.withIndex('by_room', (q) => q.eq('roomId', room.id)).take(100);
  const byPerson = new Map(members.map((member) => [member.personId, member]));
  const candidates = new Set([...mentioned, ...byPerson.keys()]);
  let count = 0;
  const now = Date.now();
  const dueAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 45 * minute).toISOString();
  for (const personId of candidates) {
    if (personId === message.creatorId) continue;
    const membership = byPerson.get(personId) ?? await findMembership(ctx, room.id, personId);
    if (!eligible(room, message, personId, membership, mentioned)) continue;
    const devices = await ctx.db.pushSubscriptions.withIndex('by_person', (q) => q.eq('personId', personId)).take(deviceLimit);
    if (!devices.length) continue;
    const recipient = await ctx.db.people.get(personId);
    if (recipient?.status !== 'active' || recipient.role === 'bot') continue;
    for (const device of devices) {
      if (device.publicKey !== keys.publicKey) continue;
      await ctx.db.pushDeliveries.insert({
        subscriptionId: device.id, messageId: message.id, dueAt, expiresAt, attempts: '0',
      });
      if (++count === fanoutLimit) return immediateLimit;
    }
  }
  return Math.min(count, immediateLimit);
}

export async function pendingPush(ctx: Reader, messageId: string) {
  if (!config(ctx)) return 0;
  const now = new Date().toISOString();
  return (await ctx.db.pushDeliveries.withIndex('by_message_due', (q) => q.eq('messageId', messageId).lte('dueAt', now)).take(immediateLimit)).length;
}

async function deliver(ctx: Writer, delivery: Delivery, transport: typeof fetch) {
  const now = Date.now();
  const remove = () => ctx.db.pushDeliveries.delete(delivery.id);
  if (delivery.expiresAt <= new Date(now).toISOString()) return remove();
  const keys = config(ctx);
  const device = await ctx.db.pushSubscriptions.get(delivery.subscriptionId);
  if (!keys || !device || device.publicKey !== keys.publicKey || !pushOrigin(device.endpoint)) return remove();
  const message = await ctx.db.messages.get(delivery.messageId);
  if (!message) return remove();
  const room = await ctx.db.rooms.get(message.roomId);
  const recipient = await ctx.db.people.get(device.personId);
  if (!room || recipient?.status !== 'active' || recipient.role === 'bot') return remove();
  const membership = await findMembership(ctx, room.id, recipient.id);
  if (!eligible(room, message, recipient.id, membership, mentionedIds(message))) return remove();

  const request = activityPushRequest({ endpoint: device.endpoint, key: keys.key, contact: keys.contact, now });
  let status = 0;
  try {
    const response = await transport(request.url, request.init as RequestInit);
    status = response.status;
  } catch {
    // Retry broker failures without exposing endpoint capability URLs.
  }
  if (status === 404 || status === 410) {
    await ctx.db.pushSubscriptions.delete(device.id);
    return remove();
  }
  const attempts = Number(delivery.attempts) + 1;
  if (attempts >= 3 || (status !== 0 && status !== 408 && status !== 429 && status < 500)) return remove();
  const dueAt = new Date(now + attempts * 2 * minute).toISOString();
  if (dueAt >= delivery.expiresAt) return remove();
  return ctx.db.pushDeliveries.update(delivery.id, { attempts: String(attempts), dueAt });
}

export async function dispatchPush(ctx: Writer, messageId: unknown, transport: typeof fetch = fetch) {
  if (typeof messageId !== 'string' || messageId.length > 150) return false;
  const source = await ctx.db.messages.get(messageId);
  if (!source) return false;
  const { me } = await accessRoom(ctx, source.roomId);
  if (source.creatorId !== me.id) return false;
  const now = new Date().toISOString();
  const next = await ctx.db.pushDeliveries.withIndex('by_message_due', (q) => q.eq('messageId', source.id).lte('dueAt', now)).first();
  if (!next) return false;
  await deliver(ctx, next, transport);
  return true;
}

export async function recoverPush(ctx: Writer, request: EndpointRequest, transport: typeof fetch = fetch) {
  const token = ctx.env.EMBER_PUSH_CRON_TOKEN;
  const authorization = request.headers.get('Authorization');
  const manual = token && token.length >= 32 && authorization?.length === token.length + 7
    && await ctx.crypto.timingSafeEqual(authorization, 'Bearer ' + token);
  if (!request.headers.get('x-spacefast-cron') && !manual) return empty({ status: 404 });

  const now = new Date().toISOString();
  const expired = await ctx.db.pushDeliveries.withIndex('by_expiry', (q) => q.lte('expiresAt', now)).take(40);
  for (const delivery of expired) await ctx.db.pushDeliveries.delete(delivery.id);
  const next = await ctx.db.pushDeliveries.withIndex('by_due', (q) => q.lte('dueAt', now)).first();
  if (next) await deliver(ctx, next, transport);
  return empty({ status: 204, headers: { 'Cache-Control': 'no-store' } });
}
