import { messageTimeKey } from './message-order';
import { json, empty, type EndpointRequest } from '@spacefast/zero/server';
import { accessRoom, type Reader, type Writer } from './access';
import { sanitizeBody } from './richtext';
import { indexMessage } from './search';

type Room = NonNullable<Awaited<ReturnType<Reader['db']['rooms']['get']>>>;
type Message = NonNullable<Awaited<ReturnType<Reader['db']['messages']['get']>>>;
type Delivery = NonNullable<Awaited<ReturnType<Reader['db']['botDeliveries']['get']>>>;
const minute = 60_000;
const maxBots = 3;
const maxReplyLength = 4_000;

export function outgoingBotUrl(value: unknown) {
 if (value === '') return '';
 if (typeof value !== 'string' || value.length > 2048 || /[\s\\#\x00-\x1f\x7f]/.test(value)) throw new Error('Enter a public HTTPS webhook URL.');
 const match = /^https:\/\/([a-z0-9.-]+)(?=\/|\?|$)/i.exec(value);
 const host = match?.[1].toLowerCase();
 if (!host || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || /\.(?:localhost|local|internal|test|invalid|onion)$/.test(host)) throw new Error('Enter a public HTTPS webhook URL.');
 return 'https://' + host + (value[match![0].length] === '/' ? '' : '/') + value.slice(match![0].length);
}

export function botReplyOrigin(ctx: Reader) {
 const origin = ctx.env.EMBER_PUBLIC_URL;
 return origin && /^https:\/\/[a-z0-9.-]+$/i.test(origin) && (ctx.env.EMBER_BOT_SIGNING_KEY?.length ?? 0) >= 32 ? origin : null;
}

export async function directBotAllowed(ctx: Reader, personId: string) {
 const config = await ctx.db.botCallbacks.withIndex('by_person', q => q.eq('personId', personId)).first();
 if (!config?.url || !config.directMessages || !botReplyOrigin(ctx)) return false;
 return (await ctx.db.bots.get(config.botId))?.enabled === true;
}

async function botAccess(ctx: Reader, personId: string, roomId: string) {
 return ctx.db.members.withIndex('by_room_person', q => q.eq('roomId', roomId).eq('personId', personId)).first();
}

export async function enqueueBotDeliveries(ctx: Writer, room: Room, message: Message, mentions: { id: string }[]) {
 if (!message.plainText || !botReplyOrigin(ctx)) return 0;
 const candidates = room.kind === 'direct'
  ? (await ctx.db.members.withIndex('by_room', q => q.eq('roomId', room.id)).take(3)).map(member => member.personId)
  : [...new Set(mentions.map(person => person.id))];
 let queued = 0;
 for (const personId of candidates) {
  if (personId === message.creatorId) continue;
  const config = await ctx.db.botCallbacks.withIndex('by_person', q => q.eq('personId', personId)).first();
  if (!config?.url || (room.kind === 'direct' && (!config.directMessages || candidates.length !== 2))) continue;
  const bot = await ctx.db.bots.get(config.botId);
  if (!bot?.enabled || bot.personId !== personId || (room.kind !== 'direct' && !JSON.parse(bot.roomIds).includes(room.id))) continue;
  if (!await botAccess(ctx, personId, room.id)) continue;
  const now = Date.now();
  await ctx.db.botDeliveries.insert({
   botId: bot.id, messageId: message.id, revision: config.revision, editedAt: message.editedAt,
   status: 'queued', attempts: '0', dueAt: new Date(now).toISOString(),
   expiresAt: new Date(now + 45 * minute).toISOString(), replyHash: '',
  });
  if (++queued >= maxBots) break;
 }
 return queued;
}

async function contextFor(ctx: Reader, delivery: Delivery) {
 const bot = await ctx.db.bots.get(delivery.botId);
 const config = await ctx.db.botCallbacks.withIndex('by_bot', q => q.eq('botId', delivery.botId)).first();
 if (!bot?.enabled || !config?.url || config.revision !== delivery.revision || !botReplyOrigin(ctx)) return null;
 const source = await ctx.db.messages.get(delivery.messageId);
 if (!source || source.deleted || source.editedAt !== delivery.editedAt || !source.plainText || source.creatorId === bot.personId) return null;
 const room = await ctx.db.rooms.get(source.roomId);
 const author = await ctx.db.people.get(source.creatorId);
 if (!room || room.archived || !author || author.status !== 'active' || author.role === 'bot') return null;
 const botPerson = await ctx.db.people.get(bot.personId);
 if (!botPerson || botPerson.status !== 'active' || !await botAccess(ctx, bot.personId, room.id) || !await botAccess(ctx, author.id, room.id)) return null;
 if (room.kind === 'direct') {
  const members = await ctx.db.members.withIndex('by_room', q => q.eq('roomId', room.id)).take(3);
  if (!config.directMessages || members.length !== 2) return null;
 } else if (!JSON.parse(bot.roomIds).includes(room.id) || !JSON.parse(source.mentions).some((mention: { id: string }) => mention.id === bot.personId)) {
  return null;
 }
 const parent = source.parentId ? await ctx.db.messages.get(source.parentId) : null;
 if (source.parentId && (!parent || parent.deleted || parent.roomId !== room.id)) return null;
 return { bot, config, source, room, author };
}

async function deliveryKey(ctx: Reader, delivery: Delivery) {
 return ctx.crypto.hmacSha256({ key: 'EMBER_BOT_SIGNING_KEY', data: ['ember-bot-reply-v1', delivery.id, delivery.revision].join(':') });
}

function replyOf(value: string) {
 if (value.length > 24_000) return null;
 try {
  const data: unknown = JSON.parse(value);
  if (!data || typeof data !== 'object' || !('text' in data) || typeof data.text !== 'string') return null;
  const text = data.text.trim();
  return text.length && text.length <= maxReplyLength ? text : null;
 } catch {
  return null;
 }
}

async function postReply(ctx: Writer, delivery: Delivery, state: NonNullable<Awaited<ReturnType<typeof contextFor>>>, text: string) {
 const hash = await ctx.crypto.sha256(text);
 if (delivery.status === 'replied') return await ctx.crypto.timingSafeEqual(delivery.replyHash, hash);
 const { bot, room, source } = state;
 const markup = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\r\n?|\n/g, '<br>');
 const prepared = sanitizeBody('<p>' + markup + '</p>');
 const parentId = room.kind === 'direct' ? source.parentId : source.parentId || source.id;
 const clientId = 'bot-reply:' + delivery.id;
 const existing = await ctx.db.messages.withIndex('by_client', q => q.eq('creatorId', bot.personId).eq('clientId', clientId)).first();
 if (!existing) {
  const message = await ctx.db.messages.insert({
   roomId: room.id, creatorId: bot.personId, clientId, sentAt: new Date().toISOString(),
   body: prepared.body, plainText: prepared.plainText, mentions: '[]', parentId,
   inRoom: !parentId, deleted: false, editedAt: '', attachment: '', cards: '',
  });
  const sentAt = messageTimeKey(message.sentAt, message.id);
  await ctx.db.messages.update(message.id, { sentAt });
  await indexMessage(ctx, { ...message, sentAt });
 }
 await ctx.db.botDeliveries.update(delivery.id, { status: 'replied', replyHash: hash });
 ctx.invalidate('room', 'thread', 'sidebar', 'search');
 return true;
}

async function boundedReply(response: Response) {
 if (Number(response.headers.get('content-length')) > 24_000) return null;
 const reader = response.body?.getReader?.();
 if (!reader || typeof TextDecoder !== 'function') return replyOf(await response.text());
 const decoder = new TextDecoder();
 let bytes = 0;
 let body = '';
 try {
  for (;;) {
   const part = await reader.read();
   if (part.done) return replyOf(body + decoder.decode());
   bytes += part.value.byteLength;
   if (bytes > 24_000) return null;
   body += decoder.decode(part.value, { stream: true });
  }
 } finally {
  await reader.cancel().catch(() => {});
 }
}

async function deliver(ctx: Writer, delivery: Delivery) {
 const now = Date.now();
 const state = now < Date.parse(delivery.expiresAt) ? await contextFor(ctx, delivery) : null;
 if (!state) {
  await ctx.db.botDeliveries.update(delivery.id, { status: 'canceled' });
  return;
 }
 const { source, room, config, author } = state;
 const key = await deliveryKey(ctx, delivery);
 const body = JSON.stringify({
  event: 'message', deliveryId: delivery.id, messageId: source.id, text: source.plainText,
  roomId: room.id, roomKind: room.kind, threadId: source.parentId || null,
  author: { id: author.id, name: author.name },
  reply: { url: botReplyOrigin(ctx) + '/bot-replies/' + encodeURIComponent(delivery.id), key },
 });
 const attempts = Number(delivery.attempts) + 1;
 let status = 'failed';
 let reply: string | null = null;
 try {
  const response = await fetch(outgoingBotUrl(config.url), {
   method: 'POST', redirect: 'error', credentials: 'omit', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': delivery.id }, body,
   ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(3500) } : {}),
  });
  if (response.redirected) status = 'failed';
  else if (response.status === 202) status = 'awaiting';
  else if (response.status === 204) status = 'done';
  else if (response.ok) reply = await boundedReply(response);
  else if (response.status === 408 || response.status === 429 || response.status >= 500) status = 'queued';
 } catch {
  status = 'queued';
 }
 if (reply) {
  await postReply(ctx, delivery, state, reply);
  await ctx.db.botDeliveries.update(delivery.id, { attempts: String(attempts) });
  return;
 }
 await ctx.db.botDeliveries.update(delivery.id, {
  attempts: String(attempts), status: status === 'queued' && attempts >= 4 ? 'failed' : status,
  dueAt: new Date(now + (2 ** attempts) * minute).toISOString(),
 });
}

export async function dispatchBotDelivery(ctx: Writer, messageId: string) {
 if (typeof messageId !== 'string' || messageId.length > 150) return false;
 const source = await ctx.db.messages.get(messageId);
 if (!source) return false;
 const { me } = await accessRoom(ctx, source.roomId);
 if (source.creatorId !== me.id) return false;
 const next = await ctx.db.botDeliveries.withIndex('by_message_due', q => q.eq('messageId', messageId).eq('status', 'queued').lte('dueAt', new Date().toISOString())).first();
 if (!next) return false;
 await deliver(ctx, next);
 return true;
}

export async function recoverBotDelivery(ctx: Writer, request: EndpointRequest) {
 // The scheduled header is supplied by Spacefast. The optional bearer enables manual runs.
 const token = ctx.env.EMBER_BOT_CRON_TOKEN;
 const authorization = request.headers.get('Authorization');
 const manual = token && token.length >= 32 && authorization?.length === token.length + 7
  && await ctx.crypto.timingSafeEqual(authorization, 'Bearer ' + token);
 if (!request.headers.get('x-spacefast-cron') && !manual) return empty({ status: 404 });
 const now = new Date().toISOString();
 const next = await ctx.db.botDeliveries.withIndex('by_due', q => q.eq('status', 'queued').lte('dueAt', now)).first();
 if (next) await deliver(ctx, next);
 const expired = await ctx.db.botDeliveries.withIndex('by_expiry', q => q.lt('expiresAt', new Date(Date.now() - 24 * 60 * minute).toISOString())).take(30);
 for (const delivery of expired) await ctx.db.botDeliveries.delete(delivery.id);
 return empty({ status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export async function botReply(ctx: Writer, request: EndpointRequest) {
 const replyError = (status: number) => empty({ status, headers: { 'Cache-Control': 'no-store' } });
 const signature = request.headers.get('X-Ember-Signature');
 if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) return replyError(403);
 const delivery = await ctx.db.botDeliveries.get(request.params.deliveryId);
 if (!delivery || !botReplyOrigin(ctx) || Date.now() >= Date.parse(delivery.expiresAt) || !['queued', 'awaiting', 'replied'].includes(delivery.status)) return replyError(403);
 const body = await request.text();
 if (body.length > 24_000) return replyError(413);
 const expected = await ctx.crypto.hmacSha256({ key: { value: await deliveryKey(ctx, delivery) }, data: body });
 if (!await ctx.crypto.timingSafeEqual(signature.slice(7), expected)) return replyError(403);
 const text = replyOf(body);
 if (!text) return replyError(400);
 const state = await contextFor(ctx, delivery);
 if (!state) return replyError(403);
 if (delivery.status === 'queued') return empty({ status: 425, headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' } });
 if (!await postReply(ctx, delivery, state, text)) return replyError(409);
 return json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
}
