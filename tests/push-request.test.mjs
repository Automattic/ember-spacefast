import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { activityPushRequest, pushOrigin, vapidConfiguration } from '../server/push-request.mjs';

const endpoint = 'https://fcm.googleapis.com/fcm/send/mock_test_token_0001';
const key = new Uint8Array(32);
key[31] = 1; // Public test-only scalar.
const contact = 'mailto:push@example.com';
const now = 1_800_000_000_000;

test('accepts exact supported vendor endpoint patterns only', () => {
  assert.equal(pushOrigin(endpoint), 'https://fcm.googleapis.com');
  assert.equal(pushOrigin('https://updates.push.services.mozilla.com/wpush/v2/mock_test_token_0001'), 'https://updates.push.services.mozilla.com');
  assert.equal(pushOrigin('https://web.push.apple.com/mock_test_token_0001'), 'https://web.push.apple.com');
  for (const candidate of [
    'https://127.0.0.1/',
    'https://fcm.googleapis.com@localhost/fcm/send/mock_test_token_0001',
    'https://fcm.googleapis.com.example.com/fcm/send/mock_test_token_0001',
    'https://fcm.googleapis.com:443/fcm/send/mock_test_token_0001',
    'https://fcm.googleapis.com/fcm/send/mock_test_token_0001?redirect=https://example.org',
    'https://fcm.googleapis.com/fcm/send/mock_test_token_0001#fragment',
    'https://fcm.googleapis.com/fcm/send/%2fmock_test_token_0001',
    'https://fcm.googleapis.com/fcm/send/../mock_test_token_0001',
    'https://fcm.googleapis.com/v1/projects/demo/messages:send',
    'http://fcm.googleapis.com/fcm/send/mock_test_token_0001',
    endpoint + '\n',
  ]) assert.equal(pushOrigin(candidate), null, candidate);
});

test('produces a bodyless POST and independently verifiable deterministic VAPID', () => {
  const input = { endpoint, key, contact, now };
  const { url, init } = activityPushRequest(input);
  assert.equal(url, endpoint);
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.equal('body' in init, false);
  assert.equal(init.headers.TTL, '300');
  assert.equal(init.headers.Topic, 'ember_activity');
  assert.deepEqual(activityPushRequest(input), { url, init });

  const match = /^vapid t=([^,]+), k=(.+)$/.exec(init.headers.Authorization);
  assert.ok(match);
  const [, jwt, encodedPoint] = match;
  const [header, claims, signature] = jwt.split('.');
  const decode = (segment) => JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  assert.deepEqual(decode(header), { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(decode(claims), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 3600, sub: contact });
  const publicPoint = Buffer.from(encodedPoint, 'base64url');
  assert.equal(publicPoint.length, 65);
  assert.equal(publicPoint[0], 4);
  const publicKey = createPublicKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: publicPoint.subarray(1, 33).toString('base64url'),
      y: publicPoint.subarray(33).toString('base64url'),
    },
  });
  const rawSignature = Buffer.from(signature, 'base64url');
  assert.equal(rawSignature.length, 64);
  assert.equal(verify('sha256', Buffer.from(`${header}.${claims}`), {
    key: publicKey,
    dsaEncoding: 'ieee-p1363',
  }, rawSignature), true);
  assert.throws(() => activityPushRequest({ ...input, key: new Uint8Array(32) }));
  assert.throws(() => activityPushRequest({ ...input, contact: 'https://localhost' }));
  assert.throws(() => activityPushRequest({ ...input, endpoint: 'https://example.com' }));
});

test('worker shows generic activity and opens or focuses Ember without fetch interception', async () => {
  const listeners = new Map();
  const shown = [];
  const actions = [];
  let windows = [{ url: 'https://ember.example/rooms/private', focus: () => actions.push('private') }];
  const self = {
    addEventListener: (event, handler) => listeners.set(event, handler),
    registration: { showNotification: async (...args) => { shown.push(args); } },
    location: { origin: 'https://ember.example' },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url) => { actions.push(url); },
    },
  };
  runInNewContext(await readFile(new URL('../service-worker.js', import.meta.url), 'utf8'), { self, URL });
  assert.deepEqual([...listeners.keys()], ['push', 'notificationclick']);
  let pending;
  const event = { notification: { close: () => actions.push('close') }, waitUntil: (task) => { pending = task; } };
  listeners.get('push')(event);
  await pending;
  assert.equal(shown[0][0], 'Ember');
  assert.equal(shown[0][1].body, 'New activity in Ember.');
  listeners.get('notificationclick')(event);
  await pending;
  windows = [{ url: 'https://ember.example/', focus: async () => { actions.push('focus'); } }];
  listeners.get('notificationclick')(event);
  await pending;
  assert.deepEqual(actions, ['close', 'https://ember.example/', 'close', 'focus']);
});

test('configuration decodes the canonical 32-byte base64url scalar and derives the right public point', () => {
  const scalar = Buffer.from(Array.from({ length: 32 }, (_, index) => 32 - index));
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(scalar);
  const encoded = scalar.toString('base64url');
  const configuration = vapidConfiguration(encoded, contact);
  assert.deepEqual(Buffer.from(configuration.key), scalar);
  assert.equal(configuration.publicKey, ecdh.getPublicKey().toString('base64url'));
  assert.equal(vapidConfiguration(encoded + '=', contact), null);
  assert.equal(vapidConfiguration(encoded, 'https://localhost'), null);
  assert.equal(vapidConfiguration(encoded, 'https://example.com/about').publicKey, configuration.publicKey);
  assert.equal(vapidConfiguration(encoded, 'https://localhost@example.com/about'), null);
  assert.equal(vapidConfiguration(encoded, 'https://example.com:65536/about'), null);
  assert.equal(vapidConfiguration(Buffer.alloc(32).toString('base64url'), contact), null);
});
