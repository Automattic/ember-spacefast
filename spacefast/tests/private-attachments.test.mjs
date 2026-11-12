import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptAttachment, decryptAttachment, discardAttachment, CHUNK_SIZE } from '../client/private-attachments.ts';
import { attachmentFingerprint, encryptE2eeAttachment, decryptE2eeAttachment } from '../client/e2ee-attachments.ts';
import { verifyAttachmentFingerprint } from '../client/ember/lib/attachment-device-trust.ts';

const origin = 'https://ember.test';
function memoryStorage() {
  const objects = new Map();
  let counter = 0;
  const deleted = [];
  return {
    objects, deleted,
    async upload(blob, options) {
      assert.equal(options.public, true);
      assert.ok(blob.size < 5 * 1024 * 1024);
      const id = (++counter).toString(16).padStart(32, '0');
      objects.set(id, blob);
      return { id, url: `${origin}/__stattic/u/${id}?k=opaque`, size: blob.size };
    },
    async delete(id) { deleted.push(id); objects.delete(id); },
    async fetch(url) { return new Response(objects.get(new URL(url).pathname.split('/').at(-1))); },
  };
}

test('multiple chunks round-trip without storing plaintext, with size bounds', async () => {
  const store = memoryStorage();
  const source = new Uint8Array(CHUNK_SIZE + 123);
  for (let i = 0; i < source.length; i++) source[i] = i % 251;
  const manifest = await encryptAttachment(new File([source], 'file.bin'), store, { origin });
  assert.equal(manifest.chunks.length, 2);
  assert.notDeepEqual(new Uint8Array(await store.objects.values().next().value.arrayBuffer()).slice(0, 40), source.slice(0, 40));
  const result = await decryptAttachment(manifest, { origin, fetch: store.fetch });
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), source);
});

test('changed bytes and wrong keys fail authentication', async () => {
  const store = memoryStorage();
  const manifest = await encryptAttachment(new File(['private contents'], 'notes.txt'), store, { origin });
  const wrong = { ...manifest, key: '00'.repeat(32) };
  await assert.rejects(decryptAttachment(wrong, { origin, fetch: store.fetch }));
  const id = manifest.chunks[0].id;
  const bytes = new Uint8Array(await store.objects.get(id).arrayBuffer());
  bytes[0] ^= 1;
  store.objects.set(id, new Blob([bytes]));
  await assert.rejects(decryptAttachment(manifest, { origin, fetch: store.fetch }));
});

test('untrusted URLs and truncated chunks are rejected', async () => {
  const store = memoryStorage();
  const manifest = await encryptAttachment(new File(['private'], 'notes.txt'), store, { origin });
  const copy = structuredClone(manifest);
  copy.chunks[0].url = 'https://other.test/__stattic/u/' + copy.chunks[0].id;
  await assert.rejects(decryptAttachment(copy, { origin, fetch() { throw new Error('should not fetch'); } }), /address/);
  await assert.rejects(decryptAttachment(manifest, { origin, fetch: async () => new Response('short') }), /incomplete/);
});

test('failed/cancelled upload removes completed encrypted chunks', async () => {
  const store = memoryStorage();
  const controller = new AbortController();
  await assert.rejects(encryptAttachment(new File(['private'], 'notes.txt'), store, { origin, signal: controller.signal, progress() { controller.abort(); } }), /cancelled/);
  assert.equal(store.objects.size, 0);
  const failStore = memoryStorage();
  const original = failStore.upload;
  const fresh = new AbortController();
  failStore.upload = async (...args) => { const value = await original(...args); fresh.abort(); return value; };
  await assert.rejects(encryptAttachment(new File(['private'], 'notes.txt'), failStore, { origin, signal: fresh.signal }), /cancelled/);
  assert.equal(failStore.objects.size, 0);
  assert.equal(failStore.deleted.length, 1);
});

const context = { workspaceId: 'workspace', roomId: 'room', senderId: 'alice', fileId: 'files_first' };

async function device(userId) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  return {
    workspaceId: context.workspaceId,
    userId,
    deviceId: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
    publicKey: Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey)).toString('hex'),
    privateKey: pair.privateKey,
  };
}
function recipient(identity) {
  return { personId: identity.userId, recipientId: identity.deviceId, recipientPublicKey: identity.publicKey };
}
async function verify(viewer, peer) {
  const fingerprint = await attachmentFingerprint(peer.publicKey);
  await verifyAttachmentFingerprint(viewer.workspaceId, viewer.userId, peer.userId, peer.deviceId, fingerprint, fingerprint);
}

test('v2 shares ciphertext only with matching local devices and manually verified peers', async (t) => {
  const pins = new Map();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_key, save) => save() } });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => pins.get(key) ?? null, setItem: (key, value) => pins.set(key, value) },
  });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else delete globalThis.localStorage;
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else delete navigator.locks;
  });
  const [alice, bob, intruder] = await Promise.all([device('alice'), device('bob'), device('eve')]);
  const recipients = [recipient(alice), recipient(bob)];
  const store = memoryStorage();
  const file = new File([new Uint8Array(CHUNK_SIZE), 'end'], 'private.bin');
  const options = { origin, fetch: store.fetch };
  await assert.rejects(encryptE2eeAttachment(file, store, context, alice, recipients, options), /fingerprint/);
  assert.equal(store.objects.size, 0);
  await verify(alice, bob);
  await assert.rejects(verify(alice, { ...bob, publicKey: intruder.publicKey }), /changed/);
  const manifest = await encryptE2eeAttachment(file, store, context, alice, recipients, options);
  assert.equal(manifest.chunks.length, 2);
  assert.equal(manifest.version, 2);
  assert.equal(manifest.key, undefined);
  assert.equal(manifest.wraps[1].key.length, 96);
  assert.equal(alice.privateKey.extractable, false);
  assert.equal((await decryptE2eeAttachment(manifest, context, alice, options)).size, file.size);
  await assert.rejects(decryptE2eeAttachment(manifest, context, intruder, options), /not shared/);
  await assert.rejects(decryptE2eeAttachment(manifest, context, bob, options), /fingerprint/);
  await verify(bob, alice);
  const plain = await decryptE2eeAttachment(manifest, context, bob, options);
  assert.deepEqual(await plain.arrayBuffer(), await file.arrayBuffer());
  const rejectFetch = { origin, fetch() { assert.fail('an unauthenticated envelope must not fetch ciphertext'); } };
  for (const field of ['workspaceId', 'roomId', 'senderId', 'fileId']) {
    await assert.rejects(decryptE2eeAttachment(manifest, { ...context, [field]: 'another' }, bob, rejectFetch), (error) => error.code !== 'ERR_ASSERTION');
  }
  await assert.rejects(decryptE2eeAttachment(
    { ...manifest, fileId: 'files_second' }, { ...context, fileId: 'files_second' }, bob, rejectFetch,
  ), (error) => error.code !== 'ERR_ASSERTION');
  for (const [field, value] of [['name', 'substituted'], ['type', 'image/jpeg'], ['size', file.size + 1]]) {
    await assert.rejects(decryptE2eeAttachment({ ...manifest, [field]: value }, context, bob, rejectFetch), (error) => error.code !== 'ERR_ASSERTION');
  }
  const wrongWrap = structuredClone(manifest);
  wrongWrap.wraps[1].key = '00'.repeat(48);
  await assert.rejects(decryptE2eeAttachment(wrongWrap, context, bob, rejectFetch), (error) => error.code !== 'ERR_ASSERTION');
  const tampered = new Uint8Array(await store.objects.get(manifest.chunks[0].id).arrayBuffer());
  tampered[0] ^= 1;
  store.objects.set(manifest.chunks[0].id, new Blob([tampered]));
  await assert.rejects(decryptE2eeAttachment(manifest, context, bob, options));
});


test('picture thumbnails have their own authenticated ciphertext and cleanup', async () => {
  const store = memoryStorage();
  const alice = await device('alice');
  const image = new File(['original private bytes'], 'picture.png', {type:'image/png'});
  const thumbnail = new Blob(['private thumbnail bytes'], {type:'image/webp'});
  const picture = {width:1800, height:1000, thumbnail};
  const manifest = await encryptE2eeAttachment(image, store, context, alice, [recipient(alice)], {origin, picture});
  const part = manifest.picture.thumbnail.chunks[0];
  assert.notEqual(part.id, manifest.chunks[0].id);
  assert.notEqual(await store.objects.get(part.id).text(), await thumbnail.text());

  const fetched = [];
  const preview = await decryptE2eeAttachment(manifest, context, alice, {
    origin, thumbnail:true,
    fetch(url) { fetched.push(new URL(url).pathname.split('/').at(-1)); return store.fetch(url); },
  });
  assert.equal(preview.type, 'image/webp');
  assert.equal(await preview.text(), await thumbnail.text());
  assert.deepEqual(fetched, [part.id]);

  const tampered = structuredClone(manifest);
  tampered.picture.width += 1;
  await assert.rejects(decryptE2eeAttachment(tampered, context, alice, {origin, thumbnail:true, fetch:store.fetch}));
  assert.equal(await (await decryptE2eeAttachment(manifest, context, alice, {origin, fetch:store.fetch})).text(), await image.text());
  await discardAttachment(manifest, store);
  assert.equal(store.objects.size, 0);
});
