import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'ember-assistant-'));
const outfile = join(dir, 'assistant.mjs');
await build({ entryPoints: ['server/assistants.ts'], outfile, bundle: true, platform: 'node', format: 'esm' });
const handlers = await import(pathToFileURL(outfile));
await rm(dir, { recursive: true, force: true });
const key = Buffer.from('fixed-key-for-tests-with-binary-\xF1', 'latin1');
const base = 'https://api.openai.com/v1/responses';

function fixture({ direct = false, context = false, enabled = true, credentials = true } = {}) {
 const room = { id: 'room', archived: false, private: true, kind: direct ? 'direct' : 'closed' };
 const message = { id: 'ask', roomId: room.id, creatorId: 'human', deleted: false, plainText: direct ? 'A question' : '@ember A question',
  body: direct ? '<p>A question</p>' : '<p>@ember A question</p>', parentId: context ? 'root' : '', editedAt: '', mentions: '[]' };
 const rows = {
  people: [{ id: 'human', status: 'active', role: 'member', identityId: 'human' }, { id: 'agent', status: 'active', role: 'bot' }],
  accounts: [{ id: 'space' }], rooms: [room], messages: [message, { id: 'root', roomId: room.id, plainText: 'Optional context', deleted: false }],
  members: [{ roomId: room.id, personId: 'human' }, ...(direct ? [{ roomId: room.id, personId: 'agent' }] : [])],
  assistantSettings: [{ id: 'settings', accountId: 'space', enabled, revision: 'workspace-1' }],
  assistantProfiles: [{ id: 'profile', personId: 'agent', name: 'Ember', enabled: true, roomIds: '["room"]', instructions: 'Be clear.', handle: 'ember', revision: 'profile-1', includeThreadRoot: context, directMessages: direct }],
  assistantJobs: [], searchTokens: [], audit: [], rateLimits: [],
 };
 let counter = 0;
 const db = Object.fromEntries(Object.entries(rows).map(([table, entries]) => [table, {
  async get(id) { return entries.find(row => row.id === id) ?? null; },
  async insert(fields) { const row = { id: 'row_' + ++counter, ...fields }; entries.push(row); return row; },
  async update(id, fields) { const row = entries.find(row => row.id === id); Object.assign(row, fields); return row; },
  async delete(id) { entries.splice(entries.findIndex(row => row.id === id), 1); },
  withIndex(_index, filter) {
   const predicates = [];
   const range = {
    eq(key, value) { predicates.push(row => row[key] === value); return range; },
    lt(key, value) { predicates.push(row => row[key] < value); return range; },
    lte(key, value) { predicates.push(row => row[key] <= value); return range; },
   };
   filter?.(range);
   const matching = () => entries.filter(row => predicates.every(test => test(row)));
   return { first: async () => matching()[0] ?? null, take: async n => matching().slice(0, n), collect: async () => matching() };
  },
 }]));
 const auth = { userId: 'human', requireSignedIn() { return this; } };
 const ctx = {
  db, auth, invalidate() {},
  env: credentials ? { EMBER_OPENAI_API_KEY: 'synthetic', EMBER_OPENAI_MODEL: 'mock-model', EMBER_OPENAI_WEBHOOK_SECRET: 'whsec_' + key.toString('base64') } : {},
  crypto: { sha256: async value => createHash('sha256').update(value).digest('hex'), timingSafeEqual: async (a, b) => a === b },
 };
 return { rows, ctx, message, room };
}

function request({ offset = 0, invalid = false } = {}) {
 const event = JSON.stringify({ type: 'response.completed', data: { id: 'resp_mock' } });
 const timestamp = String(Math.floor(Date.now() / 1000) + offset);
 const signature = createHmac('sha256', key).update('wh_mock.' + timestamp + '.' + event).digest('base64');
 return { headers: new Headers({ 'webhook-id': 'wh_mock', 'webhook-timestamp': timestamp, 'webhook-signature': 'v1,' + (invalid ? 'x' : signature) }), text: async () => event };
}

function mockFetch(t, handler) {
 const previous = globalThis.fetch;
 globalThis.fetch = async (url, options) => {
  assert.ok([base, base + '/resp_mock'].includes(url));
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.headers.Authorization, 'Bearer synthetic');
  return handler(url, options);
 };
 t.after(() => { globalThis.fetch = previous; });
}

function response(jobId, status) {
 return Response.json({ id: 'resp_mock', status, metadata: { ember_job: jobId }, output: [
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A safe <answer>.' }] },
 ] });
}

test('default-off and provider guard, normal messages, bot messages, and room scope never queue', async () => {
 for (const options of [{ enabled: false }, { credentials: false }]) {
  const f = fixture(options);
  assert.equal(await handlers.enqueueAssistant(f.ctx, f.room, f.message, 'member'), false);
 }
 const f = fixture();
 assert.equal(await handlers.enqueueAssistant(f.ctx, f.room, f.message, 'bot'), false);
 assert.equal(await handlers.enqueueAssistant(f.ctx, f.room, { ...f.message, roomId: 'other' }, 'member'), false);
 assert.equal(await handlers.enqueueAssistant(f.ctx, f.room, { ...f.message, body: '<p>ordinary</p>', plainText: 'ordinary' }, 'member'), false);
 assert.equal(await handlers.enqueueAssistant(f.ctx, f.room, { ...f.message, body: '<blockquote>@ember</blockquote>' }, 'member'), false);
 f.rows.assistantProfiles[0].roomIds = '["other"]';
 assert.equal(await handlers.enqueueAssistant(f.ctx, f.room, f.message, 'member'), false);
 await assert.rejects(handlers.setAssistants(f.ctx, { enabled: true }), /Administrator access/);
});

test('authorized background request and signed callback produce one indexed thread reply', async t => {
 const f = fixture({ context: true });
 assert.equal(await handlers.enqueueAssistant(f.ctx, f.room, f.message, 'member'), true);
 const job = f.rows.assistantJobs[0];
 let calls = 0;
 mockFetch(t, (url, options) => {
  calls++;
  if (options.method === 'GET') return response(job.id, 'completed');
  const { input, metadata, tools, store, background } = JSON.parse(options.body);
  assert.equal(url, base);
  assert.deepEqual(JSON.parse(input), { message: '@ember A question', threadRoot: 'Optional context' });
  assert.deepEqual(metadata, { ember_job: job.id });
  assert.deepEqual(tools, []);
  assert.equal(store, false);
  assert.equal(background, true);
  return response(job.id, 'in_progress');
 });
 assert.equal(await handlers.dispatchAssistant(f.ctx, f.message.id), true);
 assert.equal(job.status, 'awaiting');
 assert.equal((await handlers.assistantWebhook(f.ctx, request({ invalid: true }))).status, 403);
 assert.equal((await handlers.assistantWebhook(f.ctx, request({ offset: -301 }))).status, 403);
 assert.equal((await handlers.assistantWebhook(f.ctx, request())).status, 204);
 assert.equal((await handlers.assistantWebhook(f.ctx, request())).status, 204);
 assert.equal(calls, 2);
 assert.equal(job.status, 'replied');
 const replies = f.rows.messages.filter(message => message.creatorId === 'agent');
 assert.equal(replies.length, 1);
 assert.equal(replies[0].parentId, 'root');
 assert.equal(replies[0].inRoom, false);
 assert.match(replies[0].body, /&lt;answer&gt;/);
 assert.ok(f.rows.searchTokens.some(token => token.messageId === replies[0].id));
});

test('direct recipients are explicit, one-to-one and exclude quoted context', async t => {
 const f = fixture({ direct: true, context: true });
 assert.equal(await handlers.directAssistantAllowed(f.ctx, 'agent'), true);
 f.rows.members.push({ roomId: f.room.id, personId: 'other' });
 assert.equal(await handlers.enqueueAssistant(f.ctx, f.room, f.message, 'member'), false);
 f.rows.members.pop();
 assert.equal(await handlers.enqueueAssistant(f.ctx, f.room, f.message, 'member'), true);
 mockFetch(t, (_url, options) => {
  assert.deepEqual(JSON.parse(JSON.parse(options.body).input), { message: 'A question' });
  return response(f.rows.assistantJobs[0].id, 'completed');
 });
 assert.equal(await handlers.dispatchAssistant(f.ctx, f.message.id), true);
 assert.equal(f.rows.assistantJobs[0].status, 'replied');
 f.rows.assistantProfiles[0].directMessages = false;
 assert.equal(await handlers.directAssistantAllowed(f.ctx, 'agent'), false);
});

test('ambiguous submission is recovered only through signed callback and membership revocation stops reply', async t => {
 const f = fixture();
 await handlers.enqueueAssistant(f.ctx, f.room, f.message, 'member');
 const job = f.rows.assistantJobs[0];
 let calls = 0;
 mockFetch(t, (_url, options) => {
  calls++;
  if (options.method === 'POST') throw new Error('Synthetic timeout');
  return response(job.id, 'completed');
 });
 assert.equal(await handlers.dispatchAssistant(f.ctx, f.message.id), true);
 assert.equal(job.status, 'submitting');
 assert.equal(await handlers.dispatchAssistant(f.ctx, f.message.id), false);
 f.rows.members.length = 0;
 assert.equal((await handlers.assistantWebhook(f.ctx, request())).status, 204);
 assert.equal(calls, 2);
 assert.equal(job.status, 'canceled');
 assert.equal(f.rows.messages.some(message => message.creatorId === 'agent'), false);
});
