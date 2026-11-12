import { messageTimeKey } from './message-order';
import { empty, type EndpointRequest } from '@spacefast/zero/server';
import { account, accessRoom, administrator, audit, clean, type Reader, type Writer } from './access';
import { consumeRate } from './rate';
import { sanitizeBody } from './richtext';
import { indexMessage } from './search';
import { signWebhook } from './vendor/assistant-signature';

type Room = NonNullable<Awaited<ReturnType<Reader['db']['rooms']['get']>>>;
type Message = NonNullable<Awaited<ReturnType<Reader['db']['messages']['get']>>>;
type Job = NonNullable<Awaited<ReturnType<Reader['db']['assistantJobs']['get']>>>;
type Profile = NonNullable<Awaited<ReturnType<Reader['db']['assistantProfiles']['get']>>>;
const minute = 60_000;
const maxText = 4_000;
const responseUrl = 'https://api.openai.com/v1/responses';
const responseId = /^resp_[a-zA-Z0-9_-]{1,120}$/;
const secretFormat = /^whsec_[A-Za-z0-9+/]{24,128}={0,2}$/;

export function assistantConfigured(ctx: Reader) {
 return Boolean(ctx.env.EMBER_OPENAI_API_KEY && ctx.env.EMBER_OPENAI_MODEL && secretFormat.test(ctx.env.EMBER_OPENAI_WEBHOOK_SECRET ?? ''));
}

async function settings(ctx: Reader) {
 const workspace = await account(ctx);
 return workspace ? await ctx.db.assistantSettings.withIndex('by_account', q => q.eq('accountId', workspace.id)).first() : null;
}

export async function assistants(ctx: Reader) {
 await administrator(ctx);
 return {
  ready: assistantConfigured(ctx),
  enabled: (await settings(ctx))?.enabled ?? false,
  profiles: (await ctx.db.assistantProfiles.withIndex('by_creation').take(20)).map(profile => ({
   id: profile.id, name: profile.name, handle: profile.handle, instructions: profile.instructions,
   roomIds: JSON.parse(profile.roomIds) as string[], includeThreadRoot: profile.includeThreadRoot, directMessages: profile.directMessages, enabled: profile.enabled,
  })),
 };
}

export async function setAssistants(ctx: Writer, input: { enabled: boolean }) {
 const me = await administrator(ctx);
 if (typeof input.enabled !== 'boolean') throw new Error('Invalid assistant setting.');
 if (input.enabled && !assistantConfigured(ctx)) throw new Error('Connect OpenAI before enabling assistants.');
 const workspace = await account(ctx);
 if (!workspace) throw new Error('Workspace unavailable.');
 const current = await settings(ctx);
 if (current?.enabled === input.enabled) return;
 const revision = await ctx.crypto.sha256(JSON.stringify([current?.revision, input.enabled]));
 if (current) await ctx.db.assistantSettings.update(current.id, { enabled: input.enabled, revision });
 else await ctx.db.assistantSettings.insert({ accountId: workspace.id, enabled: input.enabled, revision });
 if (input.enabled && !await ctx.db.assistantProfiles.withIndex('by_handle', q => q.eq('handle', 'ember')).first()) {
  const actor = await ctx.db.people.insert({ identityId: 'assistant:ember', name: 'Ember', email: '', role: 'bot', status: 'deactivated', avatar: '', bio: 'AI assistant', timeZone: '' });
  await ctx.db.assistantProfiles.insert({ personId: actor.id, name: 'Ember', handle: 'ember', instructions: 'Help people with questions and writing. Keep replies concise.', roomIds: '[]', includeThreadRoot: false, directMessages: false, enabled: false, revision: 'initial' });
 }
 for (const profile of await ctx.db.assistantProfiles.withIndex('by_creation').take(20)) {
  await ctx.db.people.update(profile.personId, { status: input.enabled && profile.enabled ? 'active' : 'deactivated' });
 }
 await audit(ctx, me.id, input.enabled ? 'assistant.enable' : 'assistant.disable', workspace.id);
}

export async function saveAssistant(ctx: Writer, input: { id?: string; handle: string; name: string; instructions: string; roomIds: string[]; includeThreadRoot: boolean; directMessages: boolean; enabled: boolean }) {
 const me = await administrator(ctx);
 const previous = input.id === undefined ? null : await ctx.db.assistantProfiles.get(clean(input.id));
 if (input.id !== undefined && !previous) throw new Error('Assistant unavailable.');
 const name = clean(input.name, 60);
 const instructions = clean(input.instructions, 2_000);
 const handle = clean(input.handle, 32).toLowerCase();
 if (!name || !instructions || !/^[a-z][a-z0-9-]{0,31}$/.test(handle)) throw new Error('Enter a name, instructions and a valid @handle.');
 if ((handle === 'ember' && previous?.handle !== 'ember') || (previous?.handle === 'ember' && handle !== 'ember')) throw new Error('@ember is reserved for Ember.');
 if (typeof input.enabled !== 'boolean' || typeof input.includeThreadRoot !== 'boolean' || typeof input.directMessages !== 'boolean') throw new Error('Invalid assistant setting.');
 if (!Array.isArray(input.roomIds) || input.roomIds.length > 40 || (input.enabled && !input.roomIds.length && !input.directMessages)) throw new Error('Choose up to 40 rooms. An enabled assistant needs a room or direct messages.');
 const roomIds = [...new Set(input.roomIds.map(roomId => clean(roomId)))];
 for (const roomId of roomIds) {
  const { room } = await accessRoom(ctx, roomId);
  if (room.kind === 'direct') throw new Error('Assistants can only be enabled in rooms.');
 }
 const duplicate = await ctx.db.assistantProfiles.withIndex('by_handle', q => q.eq('handle', handle)).first();
 if (duplicate && duplicate.id !== previous?.id) throw new Error('That @handle is already in use.');
 if (!previous && (await ctx.db.assistantProfiles.withIndex('by_creation').take(20)).length >= 20) throw new Error('The workspace has 20 assistant profiles.');
 const changes = { name, handle, instructions, roomIds: JSON.stringify(roomIds), includeThreadRoot: input.includeThreadRoot, directMessages: input.directMessages, enabled: input.enabled };
 const revision = await ctx.crypto.sha256(JSON.stringify([previous?.revision, changes]));
 const active = input.enabled && (await settings(ctx))?.enabled && assistantConfigured(ctx);
 if (previous) {
  await ctx.db.assistantProfiles.update(previous.id, { ...changes, revision });
  await ctx.db.people.update(previous.personId, { name, status: active ? 'active' : 'deactivated' });
 } else {
  const actor = await ctx.db.people.insert({ identityId: 'assistant:' + handle, name, email: '', role: 'bot', status: active ? 'active' : 'deactivated', avatar: '', bio: 'AI assistant', timeZone: '' });
  await ctx.db.assistantProfiles.insert({ ...changes, revision, personId: actor.id });
 }
 await audit(ctx, me.id, 'assistant.save', previous?.id ?? handle);
}

function leadingHandle(text: string) {
 return /^@([a-z][a-z0-9-]{0,31})(?=\s|[:,!?]|$)/i.exec(text)?.[1].toLowerCase();
}

function mentioned(message: Message, profile: Profile) {
 return (message.body.startsWith("<p>@") && leadingHandle(message.plainText) === profile.handle) ||
  (JSON.parse(message.mentions) as { id: string }[]).some(mention => mention.id === profile.personId);
}

function inRoom(profile: Profile, room: Room) {
 return profile.enabled && !room.archived && room.kind !== 'direct' && (JSON.parse(profile.roomIds) as string[]).includes(room.id);
}

export async function directAssistantAllowed(ctx: Reader, personId: string) {
 if (!assistantConfigured(ctx) || !(await settings(ctx))?.enabled) return false;
 const profile = await ctx.db.assistantProfiles.withIndex('by_person', q => q.eq('personId', personId)).first();
 return Boolean(profile?.enabled && profile.directMessages);
}

async function directRecipient(ctx: Reader, room: Room, authorId: string) {
 const members = await ctx.db.members.withIndex('by_room', q => q.eq('roomId', room.id)).take(3);
 return members.length === 2 && members.some(member => member.personId === authorId)
  ? members.find(member => member.personId !== authorId)?.personId : undefined;
}

export async function enqueueAssistant(ctx: Writer, room: Room, message: Message, role: string) {
 if (!assistantConfigured(ctx) || room.id !== message.roomId || room.archived || role === 'bot' || !message.plainText) return false;
 const workspace = await settings(ctx);
 if (!workspace?.enabled) return false;
 const recipient = room.kind === 'direct' ? await directRecipient(ctx, room, message.creatorId) : undefined;
 const profiles = await ctx.db.assistantProfiles.withIndex('by_creation').take(20);
 const profile = profiles.find(candidate => room.kind === 'direct'
  ? candidate.enabled && candidate.directMessages && candidate.personId === recipient
  : inRoom(candidate, room) && mentioned(message, candidate));
 if (!profile) return false;
 const now = Date.now();
 await ctx.db.assistantJobs.insert({
  profileId: profile.id, messageId: message.id, profileRevision: profile.revision, workspaceRevision: workspace.revision,
  editedAt: message.editedAt, responseId: '', status: 'queued', attempts: '0',
  dueAt: new Date(now).toISOString(), expiresAt: new Date(now + 25 * minute).toISOString(),
 });
 return true;
}

async function authorized(ctx: Reader, job: Job) {
 if (!assistantConfigured(ctx) || Date.now() >= Date.parse(job.expiresAt)) return null;
 const workspace = await settings(ctx);
 if (!workspace?.enabled || workspace.revision !== job.workspaceRevision) return null;
 const profile = await ctx.db.assistantProfiles.get(job.profileId);
 const message = await ctx.db.messages.get(job.messageId);
 if (!profile || profile.revision !== job.profileRevision || !message || message.deleted || message.editedAt !== job.editedAt || !message.plainText) return null;
 const room = await ctx.db.rooms.get(message.roomId);
 const author = await ctx.db.people.get(message.creatorId);
 const actor = await ctx.db.people.get(profile.personId);
 if (!room || room.archived || !profile.enabled || author?.status !== 'active' || author.role === 'bot' || actor?.status !== 'active') return null;
 if (!await ctx.db.members.withIndex('by_room_person', q => q.eq('roomId', room.id).eq('personId', author.id)).first()) return null;
 if (room.kind === 'direct') {
  if (!profile.directMessages || await directRecipient(ctx, room, author.id) !== profile.personId) return null;
 } else if (!inRoom(profile, room) || !mentioned(message, profile)) return null;
 const parent = message.parentId ? await ctx.db.messages.get(message.parentId) : null;
 if (message.parentId && (!parent || parent.deleted || parent.roomId !== room.id)) return null;
 return { profile, message, parent, room };
}

async function updateJob(ctx: Writer, job: Job, status: string) {
 await ctx.db.assistantJobs.update(job.id, { status });
}

async function provider(ctx: Reader, suffix: string, input?: object) {
 const result = await fetch(responseUrl + suffix, {
  method: input ? 'POST' : 'GET', redirect: 'error', credentials: 'omit',
  headers: { Authorization: 'Bearer ' + ctx.env.EMBER_OPENAI_API_KEY, ...(input ? { 'Content-Type': 'application/json' } : {}) },
  body: input ? JSON.stringify(input) : undefined,
  ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? { signal: AbortSignal.timeout(3500) } : {}),
 });
 if (!result.ok) return { status: result.status, value: null };
 if (Number(result.headers.get('content-length')) > 64_000) return { status: 502, value: null };
 const reader = result.body?.getReader?.();
 let body: string;
 if (!reader || typeof TextDecoder !== 'function') body = await result.text();
 else {
  const decoder = new TextDecoder();
  let received = 0;
  body = '';
  try {
   for (;;) {
    const part = await reader.read();
    if (part.done) { body += decoder.decode(); break; }
    received += part.value.byteLength;
    if (received > 64_000) return { status: 502, value: null };
    body += decoder.decode(part.value, { stream: true });
   }
  } finally { await reader.cancel().catch(() => {}); }
 }
 if (body.length > 64_000) return { status: 502, value: null };
 return { status: result.status, value: JSON.parse(body) as ProviderResponse };
}

type ProviderResponse = {
 id: string; status: string; metadata?: { ember_job?: string };
 output?: { type: string; role?: string; content?: { type: string; text?: string }[] }[];
};

async function finish(ctx: Writer, original: Job, result: ProviderResponse) {
 const job = await ctx.db.assistantJobs.get(original.id);
 if (!job || !['submitting', 'awaiting'].includes(job.status)) return;
 const state = await authorized(ctx, job);
 if (!state) return updateJob(ctx, job, 'canceled');
 if (result.metadata?.ember_job !== job.id || !responseId.test(result.id) || (job.responseId && result.id !== job.responseId)) return;
 if (result.status === 'queued' || result.status === 'in_progress') {
  await ctx.db.assistantJobs.update(job.id, { responseId: result.id, status: 'awaiting' });
  return;
 }
 const reply = result.status === 'completed' ? (result.output ?? [])
  .filter(item => item.type === 'message' && item.role === 'assistant')
  .flatMap(item => item.content ?? [])
  .filter(part => part.type === 'output_text' && typeof part.text === 'string')
  .map(part => part.text)
  .join('\n').trim().slice(0, maxText) : '';
 if (!reply) {
  await ctx.db.assistantJobs.update(job.id, { responseId: result.id, status: 'failed' });
  return;
 }
 const { message, profile } = state;
 const clientId = 'assistant-reply:' + job.id;
 const existing = await ctx.db.messages.withIndex('by_client', q => q.eq('creatorId', profile.personId).eq('clientId', clientId)).first();
 if (!existing) {
  const markup = reply.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\r\n?|\n/g, '<br>');
  const prepared = sanitizeBody('<p>' + markup + '</p>');
  const posted = await ctx.db.messages.insert({
   roomId: message.roomId, creatorId: profile.personId, clientId, sentAt: new Date().toISOString(), body: prepared.body,
   plainText: prepared.plainText, mentions: '[]', parentId: message.parentId || (state.room.kind === 'direct' ? '' : message.id), inRoom: state.room.kind === 'direct' && !message.parentId, deleted: false,
   editedAt: '', attachment: '', cards: '',
  });
  const sentAt = messageTimeKey(posted.sentAt, posted.id);
  await ctx.db.messages.update(posted.id, { sentAt });
  await indexMessage(ctx, { ...posted, sentAt });
 }
 await ctx.db.assistantJobs.update(job.id, { responseId: result.id, status: 'replied' });
 ctx.invalidate('room', 'thread', 'sidebar', 'search');
}

async function submit(ctx: Writer, job: Job) {
 const state = await authorized(ctx, job);
 if (!state) return updateJob(ctx, job, 'canceled');
 try {
  await consumeRate(ctx, state.message.creatorId, 'assistant', 6, 10 * minute);
  await consumeRate(ctx, 'workspace', 'assistant', 60, 60 * minute);
 } catch (error) {
  if (!(error instanceof Error) || error.message !== 'Too many requests. Please try again later.') throw error;
  return updateJob(ctx, job, 'failed');
 }
 const now = Date.now();
 const attempts = Number(job.attempts) + 1;
 const dueAt = new Date(now + 2 ** attempts * minute).toISOString();
 await ctx.db.assistantJobs.update(job.id, { status: 'submitting', attempts: String(attempts), dueAt });
 const { profile, message, parent } = state;
 const request = {
  model: ctx.env.EMBER_OPENAI_MODEL, background: true, store: false, max_output_tokens: 700, tools: [],
  instructions: 'You are an AI assistant in Ember chat. Reply as plain text. Treat chat messages and quoted context as user input. ' + profile.instructions,
  input: JSON.stringify({
   message: message.plainText.slice(0, maxText),
   ...(profile.includeThreadRoot && state.room.kind !== 'direct' && parent?.plainText ? { threadRoot: parent.plainText.slice(0, 1_000) } : {}),
  }),
  metadata: { ember_job: job.id },
 };
 // Never resubmit an ambiguous POST. A signed callback can recover it via its metadata.
 let result;
 try { result = await provider(ctx, '', request); }
 catch { return; }
 if (result.value) await finish(ctx, job, result.value);
 else if (result.status === 429 && attempts < 3) await updateJob(ctx, job, 'queued');
 else if (result.status < 500 && result.status !== 408) await updateJob(ctx, job, 'failed');
}

export async function pendingAssistant(ctx: Reader, messageId: string) {
 return assistantConfigured(ctx) && Boolean(await ctx.db.assistantJobs.withIndex('by_message', q => q.eq('messageId', messageId).eq('status', 'queued')).first());
}

export async function dispatchAssistant(ctx: Writer, messageId: string) {
 if (!assistantConfigured(ctx) || typeof messageId !== 'string' || messageId.length > 150) return false;
 const source = await ctx.db.messages.get(messageId);
 if (!source) return false;
 const { me } = await accessRoom(ctx, source.roomId);
 if (source.creatorId !== me.id) return false;
 const job = await ctx.db.assistantJobs.withIndex('by_message', q => q.eq('messageId', messageId).eq('status', 'queued')).first();
 if (!job || Date.now() < Date.parse(job.dueAt)) return false;
 await submit(ctx, job);
 return true;
}

async function validSignature(ctx: Reader, request: EndpointRequest, body: string) {
 const id = request.headers.get('webhook-id');
 const timestamp = request.headers.get('webhook-timestamp');
 const signatures = request.headers.get('webhook-signature');
 if (!id || !/^[A-Za-z0-9_-]{1,160}$/.test(id) || !timestamp || !/^\d{1,12}$/.test(timestamp) ||
     Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !signatures || signatures.length > 512) return false;
 const expected = signWebhook(ctx.env.EMBER_OPENAI_WEBHOOK_SECRET!, id + '.' + timestamp + '.' + body);
 for (const signature of signatures.split(' ')) {
  if (signature.length === expected.length && await ctx.crypto.timingSafeEqual(signature, expected)) return true;
 }
 return false;
}

const respond = (status: number) => empty({ status, headers: { 'Cache-Control': 'no-store' } });

export async function assistantWebhook(ctx: Writer, request: EndpointRequest) {
 if (!assistantConfigured(ctx) || !(await settings(ctx))?.enabled) return respond(404);
 if (Number(request.headers.get('content-length')) > 16_000) return respond(413);
 const body = await request.text();
 if (body.length > 16_000) return respond(413);
 if (!await validSignature(ctx, request, body).catch(() => false)) return respond(403);
 let event: { type?: string; data?: { id?: string } };
 try { event = JSON.parse(body); } catch { return respond(400); }
 if (!event?.type || !['response.completed', 'response.failed', 'response.incomplete', 'response.cancelled'].includes(event.type)) return respond(204);
 const id = event.data?.id;
 if (typeof id !== 'string' || !responseId.test(id)) return respond(400);
 const known = await ctx.db.assistantJobs.withIndex('by_response', q => q.eq('responseId', id)).first();
 if (known && known.status !== 'awaiting') return respond(204);
 let result;
 try { result = await provider(ctx, '/' + id); } catch { return respond(503); }
 if (!result.value) return respond(result.status === 404 ? 204 : 503);
 const jobId = result.value.metadata?.ember_job;
 if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(jobId) || result.value.id !== id) return respond(204);
 const job = known ?? await ctx.db.assistantJobs.get(jobId);
 if (job?.status === 'queued') return respond(503);
 if (!job || !['submitting', 'awaiting'].includes(job.status)) return respond(204);
 await finish(ctx, job, result.value);
 return respond(204);
}

export async function recoverAssistants(ctx: Writer, request: EndpointRequest) {
 const token = ctx.env.EMBER_ASSISTANT_CRON_TOKEN;
 const auth = request.headers.get('Authorization');
 if (!request.headers.get('x-spacefast-cron') && !(token && token.length >= 32 && auth?.length === token.length + 7 && await ctx.crypto.timingSafeEqual(auth, 'Bearer ' + token))) return respond(404);
 if (!assistantConfigured(ctx)) return respond(204);
 const now = new Date().toISOString();
 const expired = await ctx.db.assistantJobs.withIndex('by_expiry', q => q.lt('expiresAt', now)).take(20);
 for (const job of expired) await ctx.db.assistantJobs.delete(job.id);
 const awaiting = await ctx.db.assistantJobs.withIndex('by_due', q => q.eq('status', 'awaiting').lte('dueAt', now)).first();
 if (awaiting) {
  if (!await authorized(ctx, awaiting)) await updateJob(ctx, awaiting, 'canceled');
  else if (responseId.test(awaiting.responseId)) {
   await ctx.db.assistantJobs.update(awaiting.id, { dueAt: new Date(Date.now() + 5 * minute).toISOString() });
   let result;
   try { result = await provider(ctx, '/' + awaiting.responseId); } catch { return respond(204); }
   if (result.value) await finish(ctx, awaiting, result.value);
   else if (result.status === 404) await updateJob(ctx, awaiting, 'failed');
  }
 }
 const queued = await ctx.db.assistantJobs.withIndex('by_due', q => q.eq('status', 'queued').lte('dueAt', now)).first();
 if (queued) await submit(ctx, queued);
 return respond(204);
}

export async function assistantNotice(ctx: Reader, roomId: string) {
 if (!assistantConfigured(ctx)) return '';
 const { me, room } = await accessRoom(ctx, roomId);
 if (!(await settings(ctx))?.enabled) return '';
 if (room.kind === 'direct') {
  const recipient = await directRecipient(ctx, room, me.id);
  return recipient && await directAssistantAllowed(ctx, recipient)
   ? 'Messages sent to this AI assistant are shared with OpenAI.' : '';
 }
 const profiles = await ctx.db.assistantProfiles.withIndex('by_creation').take(20);
 const active = profiles.filter(profile => inRoom(profile, room));
 if (!active.length) return '';
 return active.some(profile => profile.includeThreadRoot)
  ? 'Mention an AI assistant to share your message with OpenAI. Some assistants also receive the original thread message.'
  : 'Mention an AI assistant to share your message with OpenAI.';
}
