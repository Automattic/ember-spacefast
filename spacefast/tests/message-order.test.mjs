import assert from 'node:assert/strict';
import test from 'node:test';
import {build} from 'esbuild';

const {outputFiles} = await build({
  stdin: {
    contents: `
      export * from './client/ember/lib/room-state';
      export * from './client/ember/lib/thread-state';
      export {messageTimeKey} from './server/message-order';
    `,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
});
const {compareMessageIds, initialRoomState, initialThreadState, messageTimeKey, resumed,
  roomReducer, threadReducer, welcomed} = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64')
);

const message = id => ({id, clientMessageId: 'client-' + id, creator: {id: 'author'}, plainText: id});
const page = (ids, overrides = {}) => ({
  messages: ids.map(message), hasMore: false, hasNewer: false, around: null, ...overrides,
});
const idsIn = state => state.messages.map(message => message.id);
const threadFrame = (state, type, data) => threadReducer(state, {
  type: 'frame', now: 0, frame: {type, parentId: '1', ...data},
});

test('orders decimal and stock IDs and uses the same decimal tie-break on the server', () => {
  const ids = ['101', '99', '9', '100', '10', '9007199254740993', '9007199254740992'];
  const expected = ['9', '10', '99', '100', '101', '9007199254740992', '9007199254740993'];
  assert.deepEqual([...ids].sort(compareMessageIds), expected);
  const timestamp = '2026-11-12T00:00:00.000Z';
  assert.deepEqual(ids.map(id => messageTimeKey(timestamp, id)).sort(),
    expected.map(id => messageTimeKey(timestamp, id)));
  assert.ok(compareMessageIds('000000000000000z', '0000000000000010') < 0);
  assert.equal(messageTimeKey(timestamp, '000000000000000z'), timestamp + '|000000000000000z');
});

test('room catch-up inserts numeric IDs only inside the loaded window', () => {
  const state = welcomed(initialRoomState, page(['9', '11'], {hasMore: true, hasNewer: true}), []);
  const updated = resumed(state, {messages: ['12', '10', '8'].map(message), deletedIds: []}, []);
  assert.deepEqual(idsIn(updated), ['9', '10', '11']);
  assert.equal(updated.oldestId, '9');
  assert.equal(updated.newestId, '11');
  assert.equal(updated.arrivals, state.arrivals + 1);
  const advanced = roomReducer(updated, {type: 'frame', now: 0, frame: {
    type: 'history.after', after: '11', ...page(['12', '13']),
  }});
  assert.deepEqual(idsIn(advanced), ['9', '10', '11', '12', '13']);
  assert.equal(advanced.newestId, '13');
});

test('a delayed acknowledgement inserts its message in order and preserves pending drafts', () => {
  let state = welcomed(initialRoomState, page(['8']), []);
  state = roomReducer(state, {type: 'pending', message: {...message('pending'), pending: true}});
  for (const id of ['10', '9']) {
    state = roomReducer(state, {type: 'outbox-acknowledged', message: message(id)});
  }
  assert.deepEqual(idsIn(state), ['8', '9', '10', 'pending']);
});

test('a live thread snapshot keeps replies in posting order across decimal boundaries', () => {
  let state = initialThreadState({parentId: '1'});
  state = threadFrame(state, 'thread.opened', {parent: message('1'), ...page(['5', '9'])});
  state = threadFrame(state, 'thread.opened', {parent: message('1'), ...page(['4', '5', '9', '10', '35'])});
  assert.deepEqual(idsIn(state.replies), ['4', '5', '9', '10', '35']);
  state = threadFrame(state, 'thread.opened', {parent: message('1'), ...page(['9', '10', '35'], {hasMore: true})});
  assert.deepEqual(idsIn(state.replies), ['9', '10', '35']);
  assert.equal(state.replies.oldestId, '9');
});

test('a reply permalink pages across a digit boundary and focuses the exact message', () => {
  let state = initialThreadState({parentId: '1', replyId: '9'});
  state = threadFrame(state, 'thread.opened', {parent: message('1'), ...page(['10', '11'], {hasMore: true})});
  assert.equal(state.openingAt, '9');
  assert.equal(state.replies.oldestId, '10');
  state = threadFrame(state, 'thread.history', {before: '10', ...page(['8', '9'])});
  assert.deepEqual(idsIn(state.replies), ['8', '9', '10', '11']);
  assert.equal(state.openingAt, undefined);
  assert.deepEqual(state.replies.focus, {messageId: '9'});
});
