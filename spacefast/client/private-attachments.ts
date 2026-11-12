/** Private attachments are encrypted before native object storage sees bytes.
 * The server must keep this manifest behind the room's membership checks.
 * This protects storage URLs; it does not retract files a recipient downloaded.
 */
export const ATTACHMENT_LIMIT = 250 * 1024 * 1024;
export const CHUNK_SIZE = 4 * 1024 * 1024;

export type EncryptedChunk = { id: string; url: string; iv: string; size: number };
export type AttachmentPicture = { width: number; height: number; thumbnail: Blob | null };
type AttachmentThumbnail = { type: string; size: number; chunks: EncryptedChunk[] };
export type AttachmentManifest = {
  version: 1;
  name: string;
  type: string;
  size: number;
  key: string;
  chunks: EncryptedChunk[];
  picture?: { width: number; height: number; thumbnail?: AttachmentThumbnail };
};
export type AttachmentStorage = {
  upload(file: Blob, options: { public: boolean }): Promise<{ id: string; url: string; size: number }>;
  delete(id: string): Promise<void>;
};
export const attachmentHex = (bytes: Uint8Array) => Array.from(bytes, (n) => n.toString(16).padStart(2, "0")).join("");
export function attachmentUnhex(value: string, length: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || value.length !== length * 2 || !/^[a-f0-9]+$/.test(value)) throw new Error("Invalid attachment encryption data");
  return Uint8Array.from(value.match(/../g)!, (pair) => parseInt(pair, 16));
}
const aad = (index: number, size: number) => new TextEncoder().encode(`ember-attachment-v1:${index}:${size}`);
function cancelled(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException("Upload cancelled", "AbortError"); }

export type AttachmentUploadOptions = { signal?: AbortSignal; origin?: string; progress?: (loaded: number, total: number) => void; picture?: AttachmentPicture | null };
export type AttachmentDownloadOptions = AttachmentUploadOptions & { fetch?: typeof fetch; thumbnail?: boolean };
type ChunkContext = (index: number, size: number) => Uint8Array<ArrayBuffer>;

export function validateAttachmentSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 1 || size > ATTACHMENT_LIMIT) throw new Error("Choose a file between 1 byte and 250 MB");
}

export async function encryptAttachment(file: File, storage: AttachmentStorage, options: AttachmentUploadOptions = {}): Promise<AttachmentManifest> {
  validateAttachmentSize(file.size);
  if (!globalThis.crypto?.subtle) throw new Error("Private file sharing requires a secure connection");
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  try {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const { chunks, picture } = await encryptAttachmentWithPicture(file, key, aad, [], storage, options);
    return { version: 1, name: file.name.slice(0, 255), type: file.type || "application/octet-stream", size: file.size, key: attachmentHex(rawKey), chunks, ...(picture && { picture }) };
  } finally {
    rawKey.fill(0);
  }
}

export async function encryptAttachmentChunks(
  file: Blob, key: CryptoKey, chunkContext: ChunkContext, storage: AttachmentStorage, options: AttachmentUploadOptions,
): Promise<EncryptedChunk[]> {
  const chunks: EncryptedChunk[] = [];
  try {
    for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
      cancelled(options.signal);
      const bytes = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: chunkContext(chunks.length, file.size) }, key, bytes);
      // Only ciphertext is shareable: private native objects are uploader-only,
      // whereas another room member must be able to fetch these encrypted bytes.
      const object = await storage.upload(new Blob([encrypted], { type: "application/octet-stream" }), { public: true });
      chunks.push({ id: object.id, url: object.url, iv: attachmentHex(iv), size: bytes.byteLength });
      const origin = options.origin ?? location.origin;
      const address = new URL(object.url, origin);
      if (address.origin !== origin || address.pathname !== `/__stattic/u/${object.id}` || !/^[a-f0-9]{32}$/.test(object.id)) throw new Error("Invalid attachment storage address");
      chunks[chunks.length - 1].url = address.pathname + address.search;
      cancelled(options.signal);
      options.progress?.(Math.min(offset + CHUNK_SIZE, file.size), file.size);
      cancelled(options.signal);
    }
    return chunks;
  } catch (error) {
    // Best effort cleanup; preserve the original failure and never claim success.
    await Promise.allSettled(chunks.map((chunk) => storage.delete(chunk.id)));
    throw error;
  }
}

function thumbnailContext(context: unknown[], picture: NonNullable<AttachmentManifest["picture"]>, thumbnail: Pick<AttachmentThumbnail, "type" | "size">) {
  return (index: number) => new TextEncoder().encode(JSON.stringify([
    "ember-attachment:thumbnail", ...context, picture.width, picture.height, thumbnail.type, thumbnail.size, index,
  ]));
}

export async function encryptAttachmentWithPicture(
  file: File, key: CryptoKey, chunkContext: ChunkContext, context: unknown[], storage: AttachmentStorage, options: AttachmentUploadOptions,
): Promise<Pick<AttachmentManifest, "chunks" | "picture">> {
  const chunks = await encryptAttachmentChunks(file, key, chunkContext, storage, options);
  if (!options.picture) return { chunks };
  const {width, height, thumbnail} = options.picture;
  const picture = {width, height};
  if (!thumbnail || thumbnail.size < 1 || thumbnail.size > CHUNK_SIZE) return { chunks, picture };
  const metadata = {type: thumbnail.type, size: thumbnail.size};
  try {
    const thumbnailChunks = await encryptAttachmentChunks(thumbnail, key, thumbnailContext(context, picture, metadata), storage, {
      origin: options.origin, signal: options.signal,
    });
    return { chunks, picture: { ...picture, thumbnail: { ...metadata, chunks: thumbnailChunks } } };
  } catch {
    if (options.signal?.aborted) {
      await discardAttachment({ chunks }, storage).catch(() => {});
      cancelled(options.signal);
    }
    return { chunks, picture };
  }
}

export async function decryptAttachmentThumbnail(
  manifest: Pick<AttachmentManifest, "picture">, key: CryptoKey, context: unknown[], options: AttachmentDownloadOptions,
): Promise<Blob> {
  const picture = manifest.picture;
  const thumbnail = picture?.thumbnail;
  if (!picture || !thumbnail || thumbnail.size > CHUNK_SIZE ||
      !["image/webp", "image/png", "image/jpeg"].includes(thumbnail.type)) {
    throw new Error("This picture preview is unavailable");
  }
  return decryptAttachmentChunks(thumbnail, key, thumbnailContext(context, picture, thumbnail), options);
}

export async function decryptAttachment(manifest: AttachmentManifest, options: AttachmentDownloadOptions = {}): Promise<Blob> {
  if (manifest.version !== 1) throw new Error("Invalid attachment manifest");
  const key = await crypto.subtle.importKey("raw", attachmentUnhex(manifest.key, 32), "AES-GCM", false, ["decrypt"]);
  return options.thumbnail ? decryptAttachmentThumbnail(manifest, key, [], options) : decryptAttachmentChunks(manifest, key, aad, options);
}

export async function decryptAttachmentChunks(
  manifest: Pick<AttachmentManifest, "size" | "type" | "chunks">, key: CryptoKey, chunkContext: ChunkContext, options: AttachmentDownloadOptions,
): Promise<Blob> {
  validateAttachmentSize(manifest.size);
  if (!Array.isArray(manifest.chunks) || manifest.chunks.length !== Math.ceil(manifest.size / CHUNK_SIZE)) throw new Error("Invalid attachment manifest");
  const origin = options.origin ?? location.origin;
  const parts: ArrayBuffer[] = [];
  let loaded = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    cancelled(options.signal);
    const url = new URL(chunk.url, origin);
    // Never send a native storage bearer key to another origin or arbitrary route.
    if (url.origin !== origin || !/^\/__stattic\/u\/[a-f0-9]{32}$/.test(url.pathname) || !/^[a-f0-9]{32}$/.test(chunk.id) || !url.pathname.endsWith(`/${chunk.id}`)) throw new Error("Invalid attachment storage address");
    const expected = Math.min(CHUNK_SIZE, manifest.size - index * CHUNK_SIZE);
    if (chunk.size !== expected) throw new Error("Invalid attachment chunk size");
    const response = await (options.fetch ?? fetch)(url.href, { signal: options.signal, credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("This file is unavailable");
    const encrypted = await response.arrayBuffer();
    if (encrypted.byteLength !== expected + 16) throw new Error("The attachment is incomplete");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: attachmentUnhex(chunk.iv, 12), additionalData: chunkContext(index, manifest.size) }, key, encrypted);
    parts.push(plain);
    loaded += plain.byteLength;
    options.progress?.(loaded, manifest.size);
  }
  return new Blob(parts, { type: manifest.type });
}

export async function discardAttachment(manifest: Pick<AttachmentManifest, "chunks" | "picture">, storage: AttachmentStorage): Promise<void> {
  const chunks = [...manifest.chunks, ...(manifest.picture?.thumbnail?.chunks ?? [])];
  const results = await Promise.allSettled(chunks.map((chunk) => storage.delete(chunk.id)));
  if (results.some((result) => result.status === "rejected")) throw new Error("Some encrypted upload parts could not be removed");
}
