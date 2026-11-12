import { getVerifiedAttachmentFingerprint } from "./ember/lib/attachment-device-trust.ts";
import {
  attachmentHex, attachmentUnhex, decryptAttachmentChunks, decryptAttachmentThumbnail, encryptAttachmentWithPicture, validateAttachmentSize,
  type AttachmentDownloadOptions, type AttachmentManifest, type AttachmentStorage, type AttachmentUploadOptions,
} from "./private-attachments.ts";

export type AttachmentIdentity = {
  workspaceId: string;
  userId: string;
  deviceId: string;
  publicKey: string;
  privateKey: CryptoKey;
};
export type AttachmentContext = {
  workspaceId: string;
  roomId: string;
  senderId: string;
  fileId: string;
};
export type AttachmentRecipient = {
  personId: string;
  recipientId: string;
  recipientPublicKey: string;
};
type AttachmentWrap = Omit<AttachmentRecipient, "personId"> & { iv: string; key: string };
export type E2eeAttachmentManifest = Omit<AttachmentManifest, "version" | "key"> & {
  version: 2;
  fileId: string;
  senderDeviceId: string;
  senderPublicKey: string;
  wraps: AttachmentWrap[];
};

const curve = { name: "ECDH", namedCurve: "P-256" };
const keyDerivationSalt = new TextEncoder().encode("ember-attachment-v2");
const encode = (values: unknown[]) => new TextEncoder().encode(JSON.stringify(values));
const devicePattern = /^[a-f0-9]{32}$/;

function openIdentityDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("ember-attachment-identity", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("active");
      request.result.createObjectStore("devices");
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function withIdentityDatabase<T>(
  mode: IDBTransactionMode,
  read: (active: IDBObjectStore, devices: IDBObjectStore, finish: (value: T) => void) => void,
): Promise<T> {
  const db = await openIdentityDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(["active", "devices"], mode);
      let result: T;
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error ?? new Error("The attachment device could not be saved."));
      read(transaction.objectStore("active"), transaction.objectStore("devices"), (value) => { result = value; });
    });
  } finally {
    db.close();
  }
}

export async function findAttachmentIdentity(workspaceId: string, userId: string, deviceId?: string): Promise<AttachmentIdentity | null> {
  return withIdentityDatabase("readonly", (active, devices, finish) => {
    function readDevice(id: string) {
      const request = devices.get([workspaceId, userId, id]);
      request.onsuccess = () => finish(request.result ?? null);
    }
    if (deviceId !== undefined) {
      readDevice(deviceId);
      return;
    }
    const request = active.get([workspaceId, userId]);
    request.onsuccess = () => request.result ? readDevice(request.result) : finish(null);
  });
}

export async function listAttachmentIdentities(workspaceId: string, userId: string): Promise<AttachmentIdentity[]> {
  return withIdentityDatabase("readonly", (_active, devices, finish) => {
    const range = IDBKeyRange.bound([workspaceId, userId], [workspaceId, userId, []], false, true);
    const request = devices.getAll(range);
    request.onsuccess = () => finish(request.result);
  });
}

export async function getAttachmentIdentity(workspaceId: string, userId: string): Promise<AttachmentIdentity> {
  const existing = await findAttachmentIdentity(workspaceId, userId);
  if (existing) return existing;
  const { publicKey, privateKey } = await crypto.subtle.generateKey(curve, false, ["deriveBits"]);
  const identity = {
    workspaceId,
    userId,
    deviceId: attachmentHex(crypto.getRandomValues(new Uint8Array(16))),
    publicKey: attachmentHex(new Uint8Array(await crypto.subtle.exportKey("raw", publicKey))),
    privateKey,
  };
  return withIdentityDatabase("readwrite", (active, devices, finish) => {
    const scope = [workspaceId, userId];
    const request = active.get(scope);
    request.onsuccess = () => {
      if (request.result) {
        const saved = devices.get([...scope, request.result]);
        saved.onsuccess = () => {
          if (saved.result) finish(saved.result);
          else request.transaction?.abort();
        };
      } else {
        devices.add(identity, [...scope, identity.deviceId]);
        active.add(identity.deviceId, scope);
        finish(identity);
      }
    };
  });
}

export async function retireAttachmentIdentity(workspaceId: string, userId: string, deviceId: string): Promise<void> {
  return withIdentityDatabase("readwrite", (active, _devices, finish) => {
    const scope = [workspaceId, userId];
    const request = active.get(scope);
    request.onsuccess = () => {
      if (request.result === deviceId) active.delete(scope);
      finish(undefined);
    };
  });
}

function publicKeyBytes(publicKey: string) {
  const bytes = attachmentUnhex(publicKey, 65);
  if (bytes[0] !== 4) throw new Error("Invalid attachment device key.");
  return bytes;
}

export async function attachmentFingerprint(publicKey: string): Promise<string> {
  const bytes = publicKeyBytes(publicKey);
  await crypto.subtle.importKey("raw", bytes, curve, false, []);
  return attachmentHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function requireTrustedDevice(identity: AttachmentIdentity, personId: string, deviceId: string, publicKey: string) {
  if (!devicePattern.test(deviceId)) throw new Error("Invalid attachment device.");
  if (personId === identity.userId && deviceId === identity.deviceId && publicKey === identity.publicKey) return;
  const pinned = getVerifiedAttachmentFingerprint(identity.workspaceId, identity.userId, personId, deviceId);
  if (!pinned || pinned !== await attachmentFingerprint(publicKey)) {
    throw new Error("Verify the attachment device’s fingerprint before sharing or opening this file.");
  }
}

type AttachmentMetadata = Pick<E2eeAttachmentManifest, "name" | "type" | "size" | "senderDeviceId" | "senderPublicKey">;
function attachmentContext(context: AttachmentContext, manifest: AttachmentMetadata): unknown[] {
  return [
    context.workspaceId, context.roomId, context.senderId, context.fileId,
    manifest.senderDeviceId, manifest.senderPublicKey, manifest.name, manifest.type, manifest.size,
  ];
}

function chunkContext(context: unknown[]) {
  return (index: number) => encode(["ember-attachment-v2:chunk", ...context, index]);
}

async function deriveWrapKey(privateKey: CryptoKey, publicKey: string, context: Uint8Array<ArrayBuffer>, usage: KeyUsage) {
  const peer = await crypto.subtle.importKey("raw", publicKeyBytes(publicKey), curve, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256));
  try {
    const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: keyDerivationSalt, info: context },
      material, { name: "AES-GCM", length: 256 }, false, [usage],
    );
  } finally {
    secret.fill(0);
  }
}

function wrapContext(context: unknown[], wrap: Pick<AttachmentWrap, "recipientId" | "recipientPublicKey">) {
  return encode(["ember-attachment-v2:wrap", ...context, wrap.recipientId, wrap.recipientPublicKey]);
}

export async function encryptE2eeAttachment(
  file: File, storage: AttachmentStorage, context: AttachmentContext, identity: AttachmentIdentity,
  recipients: AttachmentRecipient[], options: AttachmentUploadOptions = {},
): Promise<E2eeAttachmentManifest> {
  validateAttachmentSize(file.size);
  if (context.workspaceId !== identity.workspaceId || context.senderId !== identity.userId || !context.fileId) {
    throw new Error("The attachment device does not match this upload.");
  }
  if (new Set(recipients.map((recipient) => recipient.recipientId)).size !== recipients.length ||
      !recipients.some((recipient) => recipient.personId === identity.userId && recipient.recipientId === identity.deviceId && recipient.recipientPublicKey === identity.publicKey)) {
    throw new Error("The attachment device list is invalid.");
  }
  const metadata = {
    name: file.name.slice(0, 255),
    type: (file.type || "application/octet-stream").slice(0, 200),
    size: file.size,
    senderDeviceId: identity.deviceId,
    senderPublicKey: identity.publicKey,
  };
  const aad = attachmentContext(context, metadata);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const wraps: AttachmentWrap[] = [];
    for (const { personId, recipientId, recipientPublicKey } of recipients) {
      await requireTrustedDevice(identity, personId, recipientId, recipientPublicKey);
      const binding = wrapContext(aad, { recipientId, recipientPublicKey });
      const wrapKey = await deriveWrapKey(identity.privateKey, recipientPublicKey, binding, "encrypt");
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: binding }, wrapKey, rawKey);
      wraps.push({ recipientId, recipientPublicKey, iv: attachmentHex(iv), key: attachmentHex(new Uint8Array(wrapped)) });
    }
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const { chunks, picture } = await encryptAttachmentWithPicture(file, key, chunkContext(aad), aad, storage, options);
    return { version: 2, fileId: context.fileId, ...metadata, wraps, chunks, ...(picture && { picture }) };
  } finally {
    rawKey.fill(0);
  }
}

export async function decryptE2eeAttachment(
  manifest: E2eeAttachmentManifest, context: AttachmentContext, identity: AttachmentIdentity,
  options: AttachmentDownloadOptions = {},
): Promise<Blob> {
  if (manifest.version !== 2 || manifest.fileId !== context.fileId || context.workspaceId !== identity.workspaceId || !Array.isArray(manifest.wraps)) {
    throw new Error("Invalid end-to-end encrypted attachment.");
  }
  const wraps = manifest.wraps.filter((entry) => entry.recipientId === identity.deviceId);
  if (wraps.length !== 1 || wraps[0].recipientPublicKey !== identity.publicKey) {
    throw new Error("This attachment was not shared with this device.");
  }
  const [wrap] = wraps;
  await requireTrustedDevice(identity, context.senderId, manifest.senderDeviceId, manifest.senderPublicKey);
  const aad = attachmentContext(context, manifest);
  const binding = wrapContext(aad, wrap);
  const wrapKey = await deriveWrapKey(identity.privateKey, manifest.senderPublicKey, binding, "decrypt");
  const rawKey = new Uint8Array(await crypto.subtle.decrypt({
    name: "AES-GCM", iv: attachmentUnhex(wrap.iv, 12), additionalData: binding,
  }, wrapKey, attachmentUnhex(wrap.key, 48)));
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  } finally {
    rawKey.fill(0);
  }
  return options.thumbnail ? decryptAttachmentThumbnail(manifest, key, aad, options) : decryptAttachmentChunks(manifest, key, chunkContext(aad), options);
}
