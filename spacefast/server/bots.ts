import { messageTimeKey } from './message-order';
import {consumeRate} from './rate';
import type { EndpointRequest } from '@spacefast/zero/server';
import {text} from '@spacefast/zero/server';
import type {Reader,Writer} from './access';
import {administrator,audit,clean} from './access';
import { botReplyOrigin, outgoingBotUrl } from './bot-delivery';
import {sanitizeBody} from './richtext';
import {indexMessage} from './search';
import {slackMessage,slackPayloadOf} from './vendor/ember-slack';
async function validRooms(ctx:Writer,ids:string[]) {if(!Array.isArray(ids)||ids.length<1||ids.length>100||new Set(ids).size!==ids.length)throw new Error('Choose one to 100 rooms.');for(const id of ids){const room=await ctx.db.rooms.get(clean(id));if(!room||room.archived||room.kind==='direct')throw new Error('Room unavailable.');}return ids;}
type CallbackInput = { outgoingUrl?: string; directMessages?: boolean };
type Bot = NonNullable<Awaited<ReturnType<Reader['db']['bots']['get']>>>;

async function saveCallback(ctx: Writer, bot: Bot, input: CallbackInput, revoke: boolean) {
 const existing = await ctx.db.botCallbacks.withIndex('by_bot', q => q.eq('botId', bot.id)).first();
 const url = input.outgoingUrl === undefined ? existing?.url ?? '' : outgoingBotUrl(typeof input.outgoingUrl === 'string' ? input.outgoingUrl.trim() : input.outgoingUrl);
 if (input.directMessages !== undefined && typeof input.directMessages !== 'boolean') throw new Error('Invalid direct message setting.');
 const directMessages = Boolean(url && (input.directMessages ?? existing?.directMessages));
 if (!existing && !url) return;
 if (!revoke && existing?.url === url && existing.directMessages === directMessages) return;
 const revision = await ctx.crypto.sha256(JSON.stringify([existing?.revision, bot.id, url, directMessages]));
 if (existing) await ctx.db.botCallbacks.update(existing.id, { url, directMessages, revision });
 else await ctx.db.botCallbacks.insert({ botId: bot.id, personId: bot.personId, url, directMessages, revision });
}

export async function bots(ctx: Reader) {
 await administrator(ctx);
 const rows = await ctx.db.bots.withIndex('by_creation').take(100);
 const outgoingReady = Boolean(botReplyOrigin(ctx));
 return Promise.all(rows.map(async bot => {
  const callback = await ctx.db.botCallbacks.withIndex('by_bot', q => q.eq('botId', bot.id)).first();
  return { id: bot.id, name: bot.name, roomIds: JSON.parse(bot.roomIds), enabled: bot.enabled,
   personId: bot.personId, outgoingReady, outgoingUrl: callback?.url ?? '', directMessages: callback?.directMessages ?? false };
 }));
}

export async function createBot(ctx: Writer, input: { name: string; roomIds: string[]; secret: string } & CallbackInput) {
 const me = await administrator(ctx);
 const name = clean(input.name, 80);
 const secret = clean(input.secret, 200);
 if (!name || !/^[a-zA-Z0-9_-]{32,200}$/.test(secret)) throw new Error('A name and a secure webhook key are required.');
 const ids = await validRooms(ctx, input.roomIds);
 await consumeRate(ctx, me.id, 'bots', 20, 86_400_000);
 const secretHash = await ctx.crypto.sha256(secret);
 const p = await ctx.db.people.insert({ identityId: 'incoming-bot:' + secretHash, name, email: '', role: 'bot', status: 'active', avatar: '', bio: 'Webhook bot', timeZone: '' });
 const bot = await ctx.db.bots.insert({ name, personId: p.id, roomIds: JSON.stringify(ids), secretHash, enabled: true });
 await saveCallback(ctx, bot, input, false);
 for (const id of ids) await ctx.db.members.insert({ roomId: id, personId: p.id, lastReadAt: '', involvement: 'nothing', favorite: false, order: '' });
 await audit(ctx, me.id, 'bot.create', bot.id);
 ctx.invalidate('bots', 'directory');
 return { id: bot.id, name, roomIds: ids, enabled: true };
}

export async function updateBot(ctx: Writer, input: { id: string; name?: string; roomIds?: string[]; secret?: string; enabled?: boolean } & CallbackInput) {
 const me = await administrator(ctx);
 const bot = await ctx.db.bots.get(clean(input.id));
 if (!bot) throw new Error('Webhook unavailable.');
 const ids = input.roomIds === undefined ? JSON.parse(bot.roomIds) : await validRooms(ctx, input.roomIds);
 const name = input.name === undefined ? bot.name : clean(input.name, 80);
 if (!name) throw new Error('Name required.');
 if (input.secret !== undefined && (typeof input.secret !== 'string' || !/^[a-zA-Z0-9_-]{32,200}$/.test(input.secret))) throw new Error('Invalid webhook key.');
 const enabled = input.enabled === undefined ? bot.enabled : input.enabled === true;
 await saveCallback(ctx, bot, input, enabled !== bot.enabled || input.secret !== undefined || JSON.stringify(ids) !== bot.roomIds);
 await ctx.db.bots.update(bot.id, { name, roomIds: JSON.stringify(ids), secretHash: input.secret === undefined ? bot.secretHash : await ctx.crypto.sha256(input.secret), enabled });
 await ctx.db.people.update(bot.personId, { name, status: enabled ? 'active' : 'deactivated' });
 if (input.roomIds !== undefined) {
  const previous: string[] = JSON.parse(bot.roomIds);
  for (const id of previous) {
   if (ids.includes(id)) continue;
   const membership = await ctx.db.members.withIndex('by_room_person', q => q.eq('roomId', id).eq('personId', bot.personId)).first();
   if (membership) await ctx.db.members.delete(membership.id);
  }
  for (const id of ids) {
   const membership = await ctx.db.members.withIndex('by_room_person', q => q.eq('roomId', id).eq('personId', bot.personId)).first();
   if (!membership) await ctx.db.members.insert({ roomId: id, personId: bot.personId, lastReadAt: '', involvement: 'nothing', favorite: false, order: '' });
  }
 }
 await audit(ctx, me.id, 'bot.update', bot.id);
 ctx.invalidate('bots', 'directory', 'room');
 return true;
}
export async function webhook(ctx:Writer,req:EndpointRequest) {
 const b=await ctx.db.bots.get(req.params.botId);if(!b||!b.enabled||!await ctx.crypto.timingSafeEqual(b.secretHash,await ctx.crypto.sha256(req.params.secret || '')))return text('invalid_token',{status:403});
 const botPerson=await ctx.db.people.get(b.personId);if(!botPerson || botPerson.status!=='active')return text('invalid_token',{status:403});
 const ids=JSON.parse(b.roomIds);const roomId=req.params.roomId;const membership=await ctx.db.members.withIndex('by_room_person',q=>q.eq('roomId',roomId).eq('personId',b.personId)).first();if(!membership)return text('channel_not_found',{status:404});if(!ids.includes(roomId))return text('channel_not_found',{status:404});const room=await ctx.db.rooms.get(roomId);if(!room||room.archived)return text('channel_not_found',{status:404});
 const source=await req.text();if(source.length>200000)return text('invalid_payload',{status:413});const payload=slackPayloadOf(source);if(!payload)return text('invalid_payload',{status:400});const parsed=slackMessage(payload);if(typeof parsed==='string')return text(parsed,{status:400});const prepared=sanitizeBody(parsed.markup);
 const idempotency=req.headers.get('Idempotency-Key');if(idempotency!==null && !/^[a-zA-Z0-9_-]{1,100}$/.test(idempotency))return text('invalid_payload',{status:400});const clientId='webhook:'+b.id+':'+roomId+':'+(idempotency || String(Date.now())+':'+(await ctx.crypto.sha256(source)).slice(0,16));const old=await ctx.db.messages.withIndex('by_client',q=>q.eq('creatorId',b.personId).eq('clientId',clientId)).first();if(old){if(old.roomId!==roomId || old.body!==prepared.body || old.cards!==JSON.stringify(parsed.cards))return text('idempotency_conflict',{status:409});return text('ok');}
 const minute=String(Math.floor(Date.now()/60000));const key=b.id;const counter=await ctx.db.webhookCounters.withIndex('by_key',q=>q.eq('key',key)).first();if(Number(counter?.window===minute?counter.count:0)>=60)return text('rate_limited',{status:429,headers:{'Retry-After':'60'}});if(counter)await ctx.db.webhookCounters.update(counter.id,{window:minute,count:String(Number(counter.window===minute?counter.count:0)+1)});else await ctx.db.webhookCounters.insert({key,botId:b.id,window:minute,count:'1'});

 let m=await ctx.db.messages.insert({roomId,creatorId:b.personId,clientId,sentAt:new Date().toISOString(),body:prepared.body,plainText:prepared.plainText || clean(String(payload.text || 'Webhook message'),20000),mentions:'[]',parentId:'',inRoom:true,deleted:false,editedAt:'',attachment:'',cards:JSON.stringify(parsed.cards)});await ctx.db.messages.update(m.id,{sentAt:messageTimeKey(m.sentAt, m.id)});m=(await ctx.db.messages.get(m.id))!;await indexMessage(ctx,m);ctx.invalidate('room','sidebar','search');return text('ok');
}
