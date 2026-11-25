import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { job, type RouteRequest } from "spacepress";
import { home_url } from "php/wordpress";
import { memberships, messages, rooms, serviceActors, serviceDeliveries } from "spacepress:db";
import { membership, numericId, personView } from "./access";
import { signWebhook } from "./assistant-signature.js";
import { indexMessage } from "./search-index";
import { consumeRate } from "./records";
import { serviceOffset, type ServiceActor } from "./service-identity";
import { assistantReady, assistantsEnabled, outgoingReady } from "./service-settings";
import { publicAddress } from "./unfurl";
import { plainSlack, slackAddress, slackMarkup, slackRichText, slackTextHtml, type SlackText } from "./slack-format";

async function canReceive(actorId: number, roomId: number, authorId: number, mentioned: string[], body: string) {
  const service = await serviceActors.system.get(actorId);
  const room = await rooms.system.get(roomId);
  if (!service || !room || !service.enabled || room.archived || authorId > serviceOffset) return false;
  const person = await personView(authorId);
  if (person.status !== "active") return false;
  if (room.closed && !await membership(room.id, authorId)) return false;
  if (service.kind === "assistant") {
    if (!await assistantsEnabled()) return false;
  } else if (!service.outgoingUrl || !outgoingReady()) return false;
  const serviceId = serviceOffset + service.id;
  if (service.kind === "bot") {
    if (!await membership(roomId, serviceId) || !await membership(roomId, authorId)) return false;
  }
  if (room.directKey) {
    if (!service.directMessages || !await membership(room.id, serviceId)) return false;
    return await memberships.system.count({ where: { roomId: room.id } }) === 2;
  }
  const allowed = JSON.parse(service.roomIds) as string[];
  if (!allowed.includes(String(room.id))) return false;
  if (mentioned.includes(String(serviceId))) return true;
  const leading = body.toLowerCase().match(/^@([a-z][a-z0-9-]{0,31})(?=\s|[:,!?]|$)/)?.[1];
  return service.kind === "assistant" && leading === service.handle;
}

function deliveryKey(id: number, version: string) {
  return createHmac("sha256", process.env.EMBER_BOT_SIGNING_KEY ?? "").update("ember-bot-reply-v1:" + id + ":" + version).digest("hex");
}

async function isCurrent(id: number) {
  const delivery = await serviceDeliveries.system.get(id);
  if (!delivery) return false;
  const source = await messages.system.get(delivery.messageId);
  const service = await serviceActors.system.get(delivery.actorId);
  if (!source || !service) return false;
  const elapsed = Date.now() - new Date(delivery.createdAt).getTime();
  const changed = source.editedAt !== delivery.sourceUpdatedAt && (source.editedAt !== "" || source.createdAt !== delivery.sourceUpdatedAt);
  const maxAge = service.kind === "assistant" ? 1500000 : 2700000;
  if (source.removed || changed || service.version !== delivery.actorVersion || elapsed > maxAge) return false;
  const ids = source.markup.split('<action-text-attachment sgid="').slice(1, 101).map(value => value.split('"')[0] ?? "");
  if (source.parentId) {
    const parent = await messages.system.get(source.parentId);
    if (!parent || parent.removed || parent.roomId !== source.roomId) return false;
  }
  return await canReceive(service.id, source.roomId, source.authorId, ids, source.body);
}

async function reply(id: number, body: string) {
  const delivery = await serviceDeliveries.system.get(id);
  const text = body.trim();
  if (!delivery || !text || text.length > 4000) return false;
  if (!await isCurrent(id)) return false;
  const source = await messages.system.get(delivery.messageId);
  if (!source) return false;
  const room = await rooms.system.get(source.roomId);
  if (!room) return false;
  const replyHash = createHash("sha256").update(text).digest("hex");
  if (delivery.status === "replied") return delivery.replyHash === replyHash;
  const parentId = source.parentId || (room.directKey ? 0 : source.id);
  const roomId = room.id;
  const authorId = serviceOffset + delivery.actorId;
  const clientId = "service-" + id;
  const [record] = await messages.system.list({ where: { roomId, authorId, clientId }, limit: 1 });
  if (!record) {
    const saved = await messages.system.create({ roomId, authorId, clientId, body: text, parentId, inRoom: !parentId, searchIndexed: true });
    await indexMessage(saved.id, roomId, text);
  }
  await serviceDeliveries.system.update(id, { status: "replied", replyHash });
  return true;
}

const responseIdPattern = /^resp_[A-Za-z0-9_-]{1,120}$/;

type AssistantResponse = {
  id: string; status: string; metadata?: { ember_job?: string };
  output?: { type: string; role?: string; content?: { type: string; text?: string }[] }[];
};

async function assistantProvider(id: string, body: string) {
  const response = await fetch("https://api.openai.com/v1/responses" + (id ? "/" + id : ""), {
    method: body ? "POST" : "GET", redirect: "error",
    headers: { Authorization: "Bearer " + (process.env.EMBER_OPENAI_API_KEY ?? ""), "Content-Type": "application/json" },
    body: body || undefined,
  });
  return response;
}

async function finishAssistant(id: number, raw: string) {
  if (raw.length > 64000) return;
  const result = JSON.parse(raw) as AssistantResponse;
  const delivery = await serviceDeliveries.system.get(id);
  if (!delivery) return;
  if (!["submitting", "awaiting"].includes(delivery.status)) return;
  if (!responseIdPattern.test(result.id) || result.metadata?.ember_job !== String(id) ||
      (delivery.responseId && delivery.responseId !== result.id)) return;
  if (!await isCurrent(id)) {
    await serviceDeliveries.system.update(id, { status: "canceled" });
    return;
  }
  if (result.status === "queued" || result.status === "in_progress") {
    if (delivery.status === "submitting") await serviceDeliveries.system.update(id, { responseId: result.id, status: "awaiting" });
    return;
  }
  const parts: string[] = [];
  if (result.status === "completed") {
    for (const item of result.output ?? []) {
      if (item.type !== "message" || item.role !== "assistant") continue;
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
      }
    }
  }
  if (await reply(id, parts.join("\n").trim().slice(0, 4000))) return;
  await serviceDeliveries.system.update(id, { responseId: result.id, status: "failed" });
}

export const recoverAssistant = job({ retries: 3 }, async ({ id }: { id: number }) => {
  const delivery = await serviceDeliveries.system.get(id);
  if (!delivery) return;
  const responseId = delivery.responseId;
  if (delivery.status !== "awaiting" || !responseIdPattern.test(responseId)) return;
  if (!await isCurrent(id)) {
    await serviceDeliveries.system.update(id, { status: "canceled" });
    return;
  }
  const result = await assistantProvider(responseId, "");
  if (result.ok) await finishAssistant(id, await result.text());
  const latest = await serviceDeliveries.system.get(id);
  if (latest?.status !== "awaiting") return;
  if (result.status === 404) await serviceDeliveries.system.update(id, { status: "failed" });
  else throw new Error("Assistant response is pending.");
});

export async function assistantWebhook(request: RouteRequest) {
  if (!await assistantsEnabled()) return { status: 404 };
  if (request.body.length > 16000) return { status: 413 };
  const id = request.headers["webhook-id"] ?? "";
  const timestamp = request.headers["webhook-timestamp"] ?? "";
  const signatures = request.headers["webhook-signature"] ?? "";
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id) || !/^\d{1,12}$/.test(timestamp) ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !signatures || signatures.length > 512) return { status: 403 };
  try {
    const expected = await signWebhook(process.env.EMBER_OPENAI_WEBHOOK_SECRET ?? "", id + "." + timestamp + "." + request.body);
    let valid = false;
    for (const signature of signatures.split(" ")) {
      if (/^v1,[A-Za-z0-9+/]{43}=$/.test(signature) && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) valid = true;
    }
    if (!valid) return { status: 403 };
  } catch {
    return { status: 403 };
  }

  let responseId = "";
  try {
    const event = JSON.parse(request.body) as { type?: string; data?: { id?: string } };
    if (!["response.completed", "response.failed", "response.incomplete", "response.cancelled"].includes(event?.type ?? "")) return { status: 204 };
    responseId = event.data?.id ?? "";
  } catch {
    return { status: 400 };
  }
  if (typeof responseId !== "string" || !responseIdPattern.test(responseId)) return { status: 400 };
  const [known] = await serviceDeliveries.system.list({ where: { responseId }, limit: 1 });
  if (known && known.status !== "awaiting") return { status: 204 };
  try {
    const result = await assistantProvider(responseId, "");
    if (!result.ok) return { status: result.status === 404 ? 204 : 503 };
    const raw = await result.text();
    if (raw.length > 64000) return { status: 503 };
    const value = JSON.parse(raw) as AssistantResponse;
    const jobId = numericId(value.metadata?.ember_job ?? "");
    if (jobId && value.id === responseId && (!known || known.id === jobId)) await finishAssistant(jobId, raw);
  } catch {
    return { status: 503 };
  }
  return { status: 204 };
}

export const serviceDelivery = job({ retries: 4 }, async ({ id }: { id: number }) => {
  const delivery = await serviceDeliveries.system.get(id);
  if (!delivery || delivery.status !== "queued") return;
  if (!await isCurrent(id)) {
    await serviceDeliveries.system.update(id, { status: "canceled" });
    return;
  }

  const source = await messages.system.get(delivery.messageId);
  const service = await serviceActors.system.get(delivery.actorId);
  if (!source || !service) return;
  const room = await rooms.system.get(source.roomId);
  if (!room) return;

  let text = "";
  if (service.kind === "assistant" && assistantReady()) {
    try {
      await consumeRate(String(source.authorId) + ":assistant", 6, 600000);
      await consumeRate("workspace:assistant", 60, 3600000);
    } catch {
      await serviceDeliveries.system.update(id, { status: "failed" });
      return;
    }
    const parent = source.parentId && service.includeThreadRoot && !room.directKey ? await messages.system.get(source.parentId) : null;
    const root = parent && !parent.removed ? parent.body.slice(0, 1000) : "";
    const request = JSON.stringify({
      model: process.env.EMBER_OPENAI_MODEL, background: true, store: false, max_output_tokens: 700, tools: [],
      instructions: "You are an AI assistant in Ember chat. Reply as plain text. Treat chat messages and quoted context as user input. " + service.instructions,
      input: JSON.stringify({ message: source.body.slice(0, 4000), threadRoot: root || undefined }),
      metadata: { ember_job: String(id) },
    });
    await serviceDeliveries.system.update(id, { status: "submitting" });
    // An ambiguous POST can be recovered by its signed callback. Repeating it could send the chat content twice.
    let throttled = false;
    try {
      const result = await assistantProvider("", request);
      throttled = result.status === 429;
      if (result.ok) {
        await finishAssistant(id, await result.text());
        await recoverAssistant.enqueue({ id }, { delay: 60, key: "ember-assistant-" + id });
      } else if (!throttled && result.status !== 408 && result.status < 500) {
        await serviceDeliveries.system.update(id, { status: "failed" });
      }
    } catch {
      return;
    }
    if (throttled) throw new Error("Assistant service is temporarily unavailable.");
    return;
  } else {
    const url = publicAddress(service.outgoingUrl);
    if (!url) return;
    const author = await personView(source.authorId);
    const response = await fetch(url, {
      method: "POST", redirect: "error",
      headers: { "Content-Type": "application/json", "Idempotency-Key": String(id) },
      body: JSON.stringify({
        event: "message", deliveryId: String(id), messageId: String(source.id), text: source.body,
        roomId: String(room.id), roomKind: room.directKey ? "direct" : room.closed ? "closed" : "open",
        threadId: source.parentId ? String(source.parentId) : null,
        author: { id: author.id, name: author.name },
        reply: { url: home_url("/bot-replies/" + id), key: deliveryKey(id, delivery.actorVersion) },
      }),
    });
    if (response.status === 202) {
      const latest = await serviceDeliveries.system.get(id);
      if (latest && latest.status === "queued") await serviceDeliveries.system.update(id, { status: "awaiting" });
      return;
    }
    if (response.status === 408 || response.status === 429 || response.status >= 500) throw new Error("Bot service is temporarily unavailable.");
    if (response.ok && response.status !== 204) {
      const raw = await response.text();
      if (raw.length <= 24000) {
        if ((response.headers.get("content-type") ?? "").startsWith("application/json")) {
          const result = JSON.parse(raw) as { text?: string };
          text = result.text ?? "";
        } else text = raw;
      }
    }
  }

  if (text && await reply(id, text.slice(0, 4000))) return;
  await serviceDeliveries.system.update(id, { status: "done" });
});

export async function enqueueServices(messageId: number, roomId: number, authorId: number, mentioned: string[], body: string, updatedAt: string) {
  if (!body || (!outgoingReady() && !assistantReady())) return;
  const services = await serviceActors.system.list({ where: { enabled: true }, limit: 120 });
  let bots = 0;
  let assistant = false;
  for (const service of services) {
    if (service.kind === "assistant" ? assistant : bots >= 3) continue;
    if (!await canReceive(service.id, roomId, authorId, mentioned, body)) continue;
    const delivery = await serviceDeliveries.system.create({
      actorId: service.id, messageId, actorVersion: service.version, sourceUpdatedAt: updatedAt,
    });
    await serviceDelivery.enqueue({ id: delivery.id }, { key: "ember-delivery-" + delivery.id });
    if (service.kind === "assistant") assistant = true;
    else bots++;
    if (assistant && bots >= 3) break;
  }
}

export async function botReply(request: RouteRequest) {
  const id = numericId(request.params.deliveryId ?? "");
  const delivery = await serviceDeliveries.system.get(id);
  if (!delivery) return { status: 404, body: "not_found" };
  const status = delivery.status;
  if (!outgoingReady() || !["queued", "awaiting", "replied"].includes(status) || request.body.length > 24000) {
    return { status: 404, body: "not_found" };
  }
  const signature = request.headers["x-ember-signature"] ?? "";
  const expected = "sha256=" + createHmac("sha256", deliveryKey(id, delivery.actorVersion)).update(request.body).digest("hex");
  if (!/^sha256=[0-9a-f]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return { status: 403, body: "invalid_signature" };
  }
  try {
    const result = JSON.parse(request.body) as { text?: string };
    const text = result.text ?? "";
    if (typeof text !== "string" || !text.trim() || text.length > 4000) return { status: 400, body: "invalid_payload" };
    if (!await isCurrent(id)) return { status: 403, body: "reply_unavailable" };
    if (status === "queued") return { status: 425, headers: { "Retry-After": "2" } };
    const posted = await reply(id, text);
    return posted
      ? { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: '{"ok":true}' }
      : { status: 409, body: "reply_unavailable" };
  } catch {
    return { status: 400, body: "invalid_payload" };
  }
}

type SlackBlock = {
  type?: string; text?: SlackText | string; fields?: SlackText[]; elements?: SlackText[];
  rows?: SlackText[][]; column_settings?: { align?: string; is_wrapped?: boolean }[];
  cards?: unknown[]; description?: SlackText; image?: SlackText; thumbnail_url?: string;
  image_url?: string; alt_text?: string; title?: SlackText;
};
type SlackAttachment = {
  title?: string; title_link?: string; pretext?: string; text?: string; fallback?: string; color?: string; blocks?: SlackBlock[];
  author_name?: string; author_link?: string; author_icon?: string; footer?: string; footer_icon?: string; ts?: number;
  image_url?: string; thumb_url?: string; fields?: { title?: string; value?: string; short?: boolean }[];
};
type SlackPayload = { text?: string; blocks?: SlackBlock[]; attachments?: SlackAttachment[] };
type CardPart = {
  kind: string; html?: string; text?: string; href?: string;
  fields?: { title?: string; html: string; short: boolean }[];
  items?: { html: string }[]; image?: { url: string; alt: string };
  title?: string; name?: string; icon?: string; at?: number;
  buttons?: { text: string; href: string; style?: string }[];
  rows?: string[][]; columns?: { align: string; wrap: boolean }[];
  tiles?: { title?: string; body?: string; hero?: { url: string; alt: string } }[];
};
type Card = { source: string; color?: string; pretext?: string; thumb?: { url: string; alt: string }; parts: CardPart[] };

function slackBlocks(blocks: SlackBlock[]) {
  const parts: CardPart[] = [];
  for (const block of blocks.slice(0, 50)) {
    const entry = block.text;
    const body = typeof entry === "string" ? entry : entry?.text ?? "";
    const html = typeof entry === "string" ? slackMarkup(entry) : slackTextHtml(entry);
    if (block.type === "header" && body) parts.push({ kind: "header", text: body.slice(0, 3000) });
    if (block.type === "divider") parts.push({ kind: "divider" });
    if (block.type === "section") {
      const fields = (block.fields ?? []).slice(0, 20).map(field => ({ html: slackTextHtml(field), short: true }));
      if (body || fields.length) parts.push({ kind: "section", html: body ? html : undefined, fields });
    }
    if (block.type === "context") {
      const items = (block.elements ?? []).slice(0, 10).map(item => ({ html: slackTextHtml(item) }));
      if (items.length) parts.push({ kind: "context", items });
    }
    if (block.type === "actions") {
      const buttons = (block.elements ?? []).filter(item => item.type === "button" && Boolean(slackAddress(item.url ?? "")))
        .map(item => {
          const button = item as unknown as { text?: SlackText; url?: string; style?: string };
          const style = button.style === "primary" || button.style === "danger" ? button.style : undefined;
          return { text: button.text?.text ?? "", href: slackAddress(button.url ?? ""), style };
        });
      if (buttons.length) parts.push({ kind: "buttons", buttons });
    }
    if (block.type === "rich_text" && block.elements) {
      parts.push({ kind: "text", html: slackRichText(block.elements ?? []) });
    }
    if (block.type === "markdown" && body) parts.push({ kind: "text", html });
    if (block.type === "table") {
      const rows = (block.rows ?? []).slice(0, 100).map(row => row.slice(0, 20).map(cell => plainSlack(cell.text ?? "")));
      const columns = (block.column_settings ?? []).slice(0, 20).map(column => ({
        align: column.align === "right" ? "right" : column.align === "center" ? "center" : "left", wrap: column.is_wrapped ?? false,
      }));
      if (rows.length) parts.push({ kind: "table", rows, columns });
    }
    if (block.type === "card" || block.type === "carousel") {
      const tiles: { title?: string; body?: string; hero?: { url: string; alt: string } }[] = [];
      const raw = (block.cards ?? []).slice(0, 30);
      if (block.type === "card") raw.push(block);
      for (const item of raw) {
        if (!item || typeof item !== "object") continue;
        const card = item as SlackBlock;
        const image = slackAddress(card.image?.image_url ?? "");
        tiles.push({ title: card.title?.text, body: slackTextHtml(card.description), hero: image ? { url: image, alt: card.image?.alt_text ?? "" } : undefined });
      }
      if (tiles.length) parts.push({ kind: "tiles", tiles });
    }
    const address = slackAddress(block.image_url ?? block.thumbnail_url ?? "");
    if ((block.type === "image" || block.type === "video") && address) parts.push({ kind: "image", image: { url: address, alt: block.alt_text ?? "" }, title: block.title?.text });
  }
  return parts;
}

async function persistSlack(request: RouteRequest, service: ServiceActor, roomId: number) {
  let payload: SlackPayload;
  try {
    const source = request.body.trimStart().startsWith("{")
      ? request.body
      : new URLSearchParams(request.body).get("payload") ?? "";
    payload = JSON.parse(source) as SlackPayload;
  } catch {
    return { status: 400, body: "invalid_payload" };
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { status: 400, body: "invalid_payload" };
  const attachments = payload.attachments ?? [];
  if (attachments.length > 100) return { status: 400, body: "too_many_attachments" };
  const cards: Card[] = [];
  const blocks = payload.blocks ?? [];
  if (Array.isArray(blocks)) {
    const parts = slackBlocks(blocks);
    if (parts.length) cards.push({ source: "blocks", parts });
  }
  for (const item of Array.isArray(attachments) ? attachments : []) {
    const parts: CardPart[] = [];
    if (item.author_name) parts.push({
      kind: "author", name: item.author_name, href: slackAddress(item.author_link ?? "") || undefined, icon: slackAddress(item.author_icon ?? "") || undefined,
    });
    if (item.title) parts.push({ kind: "title", text: item.title, href: slackAddress(item.title_link ?? "") || undefined });
    if (item.text || item.fallback) parts.push({ kind: "text", html: slackMarkup(item.text || item.fallback || "") });
    const nested = item.blocks ?? [];
    if (Array.isArray(nested)) {
      for (const part of slackBlocks(nested)) parts.push(part);
    }
    const image = slackAddress(item.image_url ?? "");
    const thumbnail = slackAddress(item.thumb_url ?? "");
    if (image) parts.push({ kind: "image", image: { url: image, alt: "" } });
    const fields = (item.fields ?? []).slice(0, 100).map(field => ({ title: field.title, html: slackMarkup(field.value ?? ""), short: field.short ?? false }));
    if (fields.length) parts.push({ kind: "fields", fields });
    const icon = slackAddress(item.footer_icon ?? "");
    if (item.footer || item.ts || icon) parts.push({ kind: "footer", text: item.footer, at: item.ts, icon: icon || undefined });
    if (parts.length || item.pretext) cards.push({
      source: "attachment", color: item.color, pretext: item.pretext ? slackMarkup(item.pretext) : undefined,
      thumb: thumbnail ? { url: thumbnail, alt: "" } : undefined, parts,
    });
  }
  const body = typeof payload.text === "string" ? payload.text.trim() : "";
  if (!body && !cards.length) return { status: 400, body: "no_text" };
  if (body.length > 20000) return { status: 400, body: "invalid_payload" };
  const requestId = request.headers["idempotency-key"] ?? "";
  if (requestId && !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) return { status: 400, body: "invalid_payload" };
  const clientId = "webhook-" + createHash("sha256").update(requestId || String(Date.now()) + request.body).digest("hex");
  const key = { roomId, authorId: serviceOffset + service.id, clientId };
  const [existing] = await messages.system.list({ where: key, limit: 1 });
  const serialized = JSON.stringify(cards);
  if (existing) {
    const same = existing.body === body && existing.cards === serialized;
    return { status: same ? 200 : 409, body: same ? "ok" : "idempotency_conflict" };
  }
  if (await messages.system.count({ where: { authorId: key.authorId, createdAt: { gte: new Date(Date.now() - 60000).toISOString() } } }) >= 60) {
    return { status: 429, body: "rate_limited", headers: { "Retry-After": "60" } };
  }
  const msg = await messages.system.create({ ...key, body, markup: body ? slackMarkup(body) : "", cards: serialized, searchIndexed: true });
  await indexMessage(msg.id, roomId, body);
  return { status: 200, body: "ok" };
}

export async function slackWebhook(request: RouteRequest) {
  const service = await serviceActors.system.get(numericId(request.params.botId ?? ""));
  const secret = request.params.secret ?? "";
  const supplied = createHash("sha256").update(secret).digest("hex");
  if (!service || !service.enabled || service.kind !== "bot" || !service.secretHash) return { status: 403, body: "invalid_token" };
  const valid = timingSafeEqual(Buffer.from(service.secretHash), Buffer.from(supplied));
  if (!valid) return { status: 403, body: "invalid_token" };
  const roomId = numericId(request.params.roomId ?? "");
  if (!(JSON.parse(service.roomIds) as string[]).includes(String(roomId))) return { status: 404, body: "channel_not_found" };
  const room = await rooms.system.get(roomId);
  if (!room || room.archived || !await membership(roomId, serviceOffset + service.id)) return { status: 404, body: "channel_not_found" };
  if (request.body.length > 200000) return { status: 413, body: "invalid_payload" };
  try {
    return await persistSlack(request, service, roomId);
  } catch {
    return { status: 400, body: "invalid_payload" };
  }
}
