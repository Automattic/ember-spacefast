import { HttpError, mutation, query, type InferSelectModel } from "spacepress";
import { esc_html, wp_strip_all_tags } from "php/wordpress";
import { attachments, memberships, messages, reactions } from "spacepress:db";
import { actor, ensureMember, numericId, personView, requireRoom, type Person } from "./access";
import { messages as messageSchema } from "./schema";
import { enqueueServices } from "./service-delivery";
import { enqueuePush } from "./push";
import { acceptAttachment, attachmentSummary, type Manifest } from "./attachments";
import { indexMessage } from "./search-index";
import { audit } from "./records";

export type Message = InferSelectModel<typeof messageSchema>;

const tags = ["p", "br", "div", "span", "a", "b", "strong", "i", "em", "s", "del", "strike", "u", "code", "pre", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "sub", "sup", "kbd", "table", "thead", "tbody", "tr", "th", "td"];

function safeTag(tag: string) {
  const match = tag.match(/^<(\/?)([a-z0-9-]+)/);
  const name = match?.[2] ?? "";
  if (name === "action-text-attachment" && match?.[1] !== "/") {
    const mention = tag.match(/ sgid="([1-9][0-9]*)"/)?.[1];
    if (mention && tag.includes(' content-type="application/vnd.campfire.mention"')) {
      return '<action-text-attachment sgid="' + mention + '" content-type="application/vnd.campfire.mention"></action-text-attachment>';
    }
    const preview = tag.match(/ content="([^"]{1,12000})"/)?.[1];
    if (preview && tag.includes(' content-type="application/vnd.actiontext.opengraph-embed"')) {
      return '<action-text-attachment content-type="application/vnd.actiontext.opengraph-embed" content="' +
        esc_html(preview) + '"></action-text-attachment>';
    }
  }
  if (!tags.includes(name)) return "";
  if (match?.[1] === "/") return "</" + name + ">";
  if (name === "a") {
    const url = tag.match(/ href="((?:https?:\/\/|mailto:)[^"<>\s]+)"/)?.[1];
    if (url) return '<a href="' + esc_html(url) + '">';
  }
  if (name === "code" || name === "pre") {
    const language = tag.match(/ data-language="([a-zA-Z0-9_+-]+)"/)?.[1];
    if (language) return "<" + name + ' data-language="' + language + '">';
  }
  return "<" + name + ">";
}

async function mentionsFor(markup: string) {
  const mentions: { id: string; name: string }[] = [];
  const ids: string[] = [];
  for (const token of markup.split('<action-text-attachment sgid="').slice(1, 101)) {
    const id = token.split('"')[0] ?? "";
    if (ids.includes(id)) continue;
    ids.push(id);
    const person = await personView(numericId(id));
    if (person.status === "active") mentions.push({ id, name: person.name });
  }
  return mentions;
}

function prepare(body: string, plainText?: string) {
  if (body.length > 100000 || (plainText?.length ?? 0) > 20000) throw new HttpError(422, "long_message", "Message too long.");
  const markup = plainText === undefined ? "" : body.replace(/<[^<>]*>|</g, tag => tag === "<" ? "&lt;" : safeTag(tag));
  const plain = (plainText ?? wp_strip_all_tags(body)).trim();
  if (!plain) throw new HttpError(422, "blank_message", "Write a message.");
  return { body: plain, markup };
}

type Boost = { id: string; messageId: string; content: string; booster: Person; createdAt: string };
export type MessageView = {
  id: string; roomId: string; clientMessageId: string; creator: Person;
  body: string; plainText: string; createdAt: string; updatedAt: string; editedAt: string | null;
  boosts: Boost[]; mentions: { id: string; name: string }[];
  parentId?: string; alsoSent?: boolean; parentText?: string; deleted?: boolean;
  thread?: { count: number; latestAt: string; people: Person[] };
  attachment?: unknown; cards?: unknown;
};

export async function messageView(row: Message): Promise<MessageView> {
  const creator = await personView(row.authorId);
  const boosts: Boost[] = [];
  if (!row.removed) {
    const records = await reactions.system.list({ where: { messageId: row.id }, limit: 500 });
    for (const record of records) {
      boosts.push({ id: String(record.id), messageId: String(row.id), content: record.content, booster: await personView(record.personId), createdAt: record.createdAt });
    }
  }
  const parent = row.parentId ? await messages.system.get(row.parentId) : null;
  const replies = row.parentId ? [] : await messages.system.list({ where: { parentId: row.id, removed: false }, orderBy: { id: "desc" }, limit: 20 });
  const repliers: Person[] = [];
  const authors: number[] = [];
  for (const reply of replies) {
    if (!authors.includes(reply.authorId) && authors.length < 4) {
      authors.push(reply.authorId);
      repliers.push(await personView(reply.authorId));
    }
  }
  const latest = replies[0];
  const thread = latest ? { count: await messages.system.count({ where: { parentId: row.id, removed: false } }), latestAt: latest.createdAt, people: repliers } : null;
  return {
    id: String(row.id), roomId: String(row.roomId), clientMessageId: row.clientId, creator,
    body: row.removed ? "" : row.markup || "<p>" + esc_html(row.body).replaceAll("\n", "<br>") + "</p>",
    plainText: row.removed ? "" : row.body,
    createdAt: row.createdAt, updatedAt: row.updatedAt, editedAt: row.editedAt || null, boosts,
    mentions: row.removed ? [] : await mentionsFor(row.markup),
    parentId: row.parentId ? String(row.parentId) : undefined,
    alsoSent: row.parentId ? row.inRoom : undefined,
    parentText: parent ? parent.body.slice(0, 150) : undefined,
    thread: thread ?? undefined,
    deleted: row.removed ? true : undefined,
    attachment: row.removed ? undefined : await attachmentSummary(row.attachmentId),
    cards: row.cards && !row.removed ? JSON.parse(row.cards) : undefined,
  };
}

export async function views(rows: Message[]) {
  const result: MessageView[] = [];
  for (const row of rows) result.push(await messageView(row));
  return result;
}

export async function readTimeline(roomId: number, before?: number) {
  await requireRoom(roomId);
  const you = await actor();
  const rows = before
    ? await messages.system.list({ where: { roomId, inRoom: true, id: { lt: before } }, orderBy: { id: "desc" }, limit: 51 })
    : await messages.system.list({ where: { roomId, inRoom: true }, orderBy: { id: "desc" }, limit: 51 });
  const now = Date.now();
  const members = await memberships.system.list({ where: { roomId, seenAt: { gt: now - 60000 } }, limit: 500 });
  const present: Person[] = [];
  const typing: { user: Person; typing: boolean }[] = [];
  for (const member of members) {
    const user = await personView(member.personId);
    if (user.status === "active") {
      present.push(user);
      if (member.typingUntil > now) typing.push({ user, typing: true });
    }
  }
  return { type: "welcome", you, present, typing, seq: 0, messages: await views(rows.slice(0, 50).reverse()), hasMore: rows.length > 50, hasNewer: false, around: null };
}

export async function roomAfter(roomId: number, after: number) {
  await requireRoom(roomId);
  if (after !== 0 && (await messages.system.get(after))?.roomId !== roomId) {
    throw new HttpError(404, "message_unavailable", "Message unavailable.");
  }
  const rows = await messages.system.list({ where: { roomId, inRoom: true, id: { gt: after } }, orderBy: { id: "asc" }, limit: 51 });
  return { messages: await views(rows.slice(0, 50)), hasNewer: rows.length > 50 };
}

export async function roomAround(roomId: number, cursor?: number) {
  if (!cursor) return await readTimeline(roomId);
  await requireRoom(roomId);
  const selected = await messages.system.get(cursor);
  const anchor = selected && selected.inRoom ? selected : await messages.system.get(selected?.parentId ?? 0);
  if (!anchor || anchor.roomId !== roomId) throw new HttpError(404, "message_unavailable", "Message unavailable.");
  const before = await messages.system.list({ where: { roomId, inRoom: true, id: { lt: anchor.id } }, orderBy: { id: "desc" }, limit: 26 });
  const after = await messages.system.list({ where: { roomId, inRoom: true, id: { gt: anchor.id } }, orderBy: { id: "asc" }, limit: 26 });
  return { messages: await views([...before.slice(0, 25).reverse(), anchor, ...after.slice(0, 25)]), hasMore: before.length > 25, hasNewer: after.length > 25, around: String(anchor.id) };
}

async function accessibleMessage(id: number) {
  const row = await messages.system.get(id);
  if (!row) throw new HttpError(404, "message_unavailable", "Message unavailable.");
  await requireRoom(row.roomId);
  return row;
}

async function threadParent(parentId: number) {
  const parent = await accessibleMessage(parentId);
  if (parent.parentId) throw new HttpError(404, "thread_unavailable", "Thread unavailable.");
  return parent;
}

export async function thread(parentId: number, before?: number) {
  const observedAt = new Date().toISOString();
  const parent = await threadParent(parentId);
  const rows = before
    ? await messages.system.list({ where: { parentId, id: { lt: before } }, orderBy: { id: "desc" }, limit: 101 })
    : await messages.system.list({ where: { parentId }, orderBy: { id: "desc" }, limit: 101 });
  return { parent: await messageView(parent), messages: await views(rows.slice(0, 100).reverse()), hasMore: rows.length > 100, hasNewer: false, around: null, observedAt };
}

export const threadChanges = query({ access: "authenticated" }, async ({ parentId, after, before, since, until }: {
  parentId: string; after: number; before: number; since: string; until: string;
}) => {
  const parent = await threadParent(numericId(parentId));
  const rows = await messages.system.list({
    where: { parentId: parent.id, id: { gt: after, lt: before }, updatedAt: { gte: since, lt: until } },
    orderBy: { id: "asc" }, limit: 51,
  });
  return { messages: await views(rows.slice(0, 50)), hasNewer: rows.length > 50 };
});

type MessageInput = {
  roomId: string; clientMessageId: string; body: string; plainText?: string; expectedCreatorId?: string;
  parentId?: string; alsoSent?: boolean; fileId?: string;
};

async function writeMessage(input: MessageInput, protectedUpload: boolean) {
  const user = await actor();
  const room = await requireRoom(numericId(input.roomId));
  if (input.expectedCreatorId && input.expectedCreatorId !== user.id) throw new HttpError(403, "sender_changed", "Message sender changed.");
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(input.clientMessageId)) throw new HttpError(422, "invalid_message", "Invalid message identifier.");
  const key = { roomId: room.id, authorId: user.wpId, clientId: input.clientMessageId };
  const [prior] = await messages.system.list({ where: { authorId: user.wpId, clientId: input.clientMessageId }, limit: 1 });
  if (prior) {
    if (prior.roomId !== room.id || (input.fileId && numericId(input.fileId) !== prior.attachmentId)) {
      throw new HttpError(409, "message_conflict", "Message identifier already used.");
    }
    return await messageView(prior);
  }
  let parentId = 0;
  if (input.parentId) {
    const parent = await messages.system.get(numericId(input.parentId));
    if (!parent || parent.roomId !== room.id || parent.parentId) throw new HttpError(404, "thread_unavailable", "Thread unavailable.");
    parentId = parent.id;
  }
  let attachmentId = 0;
  if (input.fileId) {
    const file = await attachments.system.get(numericId(input.fileId));
    if (!file || file.status !== "ready" || file.roomId !== room.id || file.personId !== user.wpId || room.closed !== protectedUpload) {
      throw new HttpError(404, "file_unavailable", "Attachment unavailable.");
    }
    attachmentId = file.id;
  }
  const prepared = attachmentId && !(input.plainText ?? input.body).trim()
    ? { body: "", markup: "" }
    : prepare(input.body, input.plainText);
  const row = await messages.system.create({ ...key, ...prepared, parentId, inRoom: !parentId || input.alsoSent === true, attachmentId, searchIndexed: true });
  await indexMessage(row.id, room.id, row.body);
  if (attachmentId) await attachments.system.update(attachmentId, { status: "attached" });
  await ensureMember(room.id, user.wpId, Boolean(room.directKey));
  const mentioned = (await mentionsFor(row.markup)).map(person => person.id);
  await enqueueServices(row.id, room.id, user.wpId, mentioned, row.body, row.editedAt);
  await enqueuePush(row.id, room.id, user.wpId, mentioned);
  return await messageView(row);
}

export const sendMessage = mutation({ access: "authenticated", rateLimit: "60/min" }, async (input: MessageInput) => {
  return await writeMessage(input, false);
});

export const commitFile = mutation({ access: "authenticated" }, async (input: {
  fileId: string; manifest: Manifest;
  message?: { clientMessageId: string; body: string; parentId?: string; alsoSent?: boolean; expectedCreatorId?: string };
}) => {
  const file = await acceptAttachment(input.fileId, input.manifest, Boolean(input.message));
  if (!input.message) return { id: input.fileId };
  return await writeMessage({ ...input.message, roomId: String(file.roomId), fileId: input.fileId }, true);
});

export const editMessage = mutation({ access: "authenticated", rateLimit: "60/min" }, async (input: {
  messageId: string; body: string; plainText?: string;
}) => {
  const user = await actor();
  const row = await accessibleMessage(numericId(input.messageId));
  if (row.authorId !== user.wpId || row.removed) throw new HttpError(403, "message_owner", "You may only edit your messages.");
  const updated = await messages.system.update(row.id, { ...prepare(input.body, input.plainText), editedAt: new Date().toISOString(), searchIndexed: true });
  await indexMessage(row.id, row.roomId, updated.body, true);
  return await messageView(updated);
});

export const deleteMessage = mutation({ access: "authenticated" }, async ({ id }: { id: string }) => {
  const user = await actor();
  const row = await accessibleMessage(numericId(id));
  if (row.authorId !== user.wpId && !user.administrator) throw new HttpError(403, "message_owner", "You may only delete your messages.");
  await messages.system.update(row.id, { removed: true, body: "", markup: "", cards: "", searchIndexed: true });
  await indexMessage(row.id, row.roomId, "", true);
  if (row.attachmentId) await attachments.system.update(row.attachmentId, { status: "deleted", manifest: "" });
  const records = await reactions.system.list({ where: { messageId: row.id }, limit: 500 });
  for (const record of records) await reactions.system.delete(record.id);
  await audit(user.wpId, "message.delete", row.id);
  return { messageId: id };
});

export const react = mutation({ access: "authenticated", rateLimit: "120/min" }, async ({ messageId, content }: { messageId: string; content: string }) => {
  const user = await actor();
  const row = await accessibleMessage(numericId(messageId));
  if (row.removed || !content.trim() || content.length > 100) throw new HttpError(422, "invalid_reaction", "Invalid reaction.");
  const key = { messageId: row.id, personId: user.wpId, content: content.trim() };
  const [previous] = await reactions.system.list({ where: key, limit: 1 });
  if (previous) return { id: String(previous.id) };
  const record = await reactions.system.create(key);
  return { id: String(record.id) };
});

export const unreact = mutation({ access: "authenticated" }, async ({ id }: { id: string }) => {
  const user = await actor();
  const record = await reactions.system.get(numericId(id));
  if (!record || record.personId !== user.wpId) throw new HttpError(404, "reaction_unavailable", "Reaction unavailable.");
  await accessibleMessage(record.messageId);
  await reactions.system.delete(record.id);
  return { boostId: id };
});
