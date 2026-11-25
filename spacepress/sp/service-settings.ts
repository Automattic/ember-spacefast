import { createHash, randomBytes } from "node:crypto";
import { HttpError, mutation, query } from "spacepress";
import { memberships, serviceActors, workspaces } from "spacepress:db";
import { account, actor, admin, ensureMember, membership, numericId, requireRoom } from "./access";
import { serviceOffset, type ServiceActor } from "./service-identity";
import { publicAddress } from "./unfurl";

function serviceVersion() {
  return randomBytes(24).toString("hex");
}

export function outgoingReady() {
  return (process.env.EMBER_BOT_SIGNING_KEY ?? "").length >= 32;
}

export function assistantReady() {
  return Boolean(process.env.EMBER_OPENAI_API_KEY && process.env.EMBER_OPENAI_MODEL &&
    /^whsec_[A-Za-z0-9+/]{24,128}={0,2}$/.test(process.env.EMBER_OPENAI_WEBHOOK_SECRET ?? ""));
}

export async function assistantsEnabled() {
  const workspace = await account();
  return Boolean(workspace?.assistantsEnabled && assistantReady());
}

function botView(bot: ServiceActor) {
  return {
    id: String(bot.id), personId: String(serviceOffset + bot.id), name: bot.name, enabled: bot.enabled,
    roomIds: JSON.parse(bot.roomIds) as string[], outgoingReady: outgoingReady(), outgoingUrl: bot.outgoingUrl,
    directMessages: bot.directMessages,
  };
}

export const botList = query({ access: "authenticated" }, async () => {
  await admin();
  const rows = await serviceActors.system.list({ where: { kind: "bot" }, limit: 100 });
  return rows.map(bot => botView(bot));
});

async function validRooms(ids: string[], limit: number) {
  if (ids.length > limit) throw new HttpError(422, "too_many_rooms", "Choose fewer rooms.");
  const result: string[] = [];
  for (const id of ids) {
    const room = await requireRoom(numericId(id));
    if (room.directKey) throw new HttpError(422, "invalid_room", "Choose workspace rooms.");
    if (!result.includes(id)) result.push(id);
  }
  return result;
}

function callback(url: string) {
  if (url && !publicAddress(url)) throw new HttpError(422, "invalid_webhook", "Enter a public HTTPS webhook URL.");
  return url;
}

function webhookHash(secret: string) {
  if (!/^[a-zA-Z0-9_-]{32,200}$/.test(secret)) throw new HttpError(422, "invalid_key", "Choose a secure webhook key.");
  return createHash("sha256").update(secret).digest("hex");
}

async function syncBotRooms(personId: number, previous: string[], wanted: string[]) {
  for (const id of previous) {
    if (wanted.includes(id)) continue;
    const member = await membership(numericId(id), personId);
    if (member) await memberships.system.delete(member.id);
  }
  for (const id of wanted) {
    const member = await ensureMember(numericId(id), personId, false);
    if (member.involvement !== "nothing") await memberships.system.update(member.id, { involvement: "nothing" });
  }
}

export const createBot = mutation({ access: "authenticated", rateLimit: "20/day" }, async (input: {
  name: string; roomIds: string[]; secret: string; outgoingUrl?: string; directMessages?: boolean;
}) => {
  await admin();
  const ids = await validRooms(input.roomIds, 100);
  const name = input.name.trim();
  if (!name || name.length > 80 || !ids.length) throw new HttpError(422, "invalid_webhook", "Choose a name and at least one room.");
  const outgoingUrl = callback(input.outgoingUrl?.trim() ?? "");
  const bot = await serviceActors.system.create({
    kind: "bot", name, roomIds: JSON.stringify(ids), enabled: true, secretHash: webhookHash(input.secret),
    outgoingUrl, directMessages: Boolean(outgoingUrl && input.directMessages), version: serviceVersion(),
  });
  await syncBotRooms(serviceOffset + bot.id, [], ids);
  return botView(bot);
});

export const updateBot = mutation({ access: "authenticated" }, async (input: {
  id: string; name?: string; roomIds?: string[]; secret?: string; outgoingUrl?: string; directMessages?: boolean; enabled?: boolean;
}) => {
  await admin();
  const bot = await serviceActors.system.get(numericId(input.id));
  if (!bot || bot.kind !== "bot") throw new HttpError(404, "webhook_unavailable", "Webhook unavailable.");
  const oldRooms = JSON.parse(bot.roomIds) as string[];
  const ids = input.roomIds ? await validRooms(input.roomIds, 100) : oldRooms;
  const name = input.name?.trim() ?? bot.name;
  if (!name || name.length > 80 || !ids.length) throw new HttpError(422, "invalid_webhook", "Choose a name and at least one room.");
  const outgoingUrl = callback(input.outgoingUrl?.trim() ?? bot.outgoingUrl);
  await serviceActors.system.update(bot.id, {
    name, roomIds: JSON.stringify(ids), enabled: input.enabled ?? bot.enabled,
    secretHash: input.secret ? webhookHash(input.secret) : bot.secretHash,
    outgoingUrl, directMessages: Boolean(outgoingUrl && (input.directMessages ?? bot.directMessages)), version: serviceVersion(),
  });
  await syncBotRooms(serviceOffset + bot.id, oldRooms, ids);
  return true;
});

export const assistantList = query({ access: "authenticated" }, async () => {
  await admin();
  const rows = await serviceActors.system.list({ where: { kind: "assistant" }, limit: 20 });
  return {
    ready: assistantReady(), enabled: await assistantsEnabled(),
    profiles: rows.map(row => ({
      id: String(row.id), name: row.name, handle: row.handle, instructions: row.instructions,
      roomIds: JSON.parse(row.roomIds) as string[], includeThreadRoot: row.includeThreadRoot,
      directMessages: row.directMessages, enabled: row.enabled,
    })),
  };
});

export const setAssistants = mutation({ access: "authenticated" }, async ({ enabled }: { enabled: boolean }) => {
  await admin();
  if (enabled && !assistantReady()) throw new HttpError(422, "assistant_configuration", "Connect OpenAI before enabling assistants.");
  const workspace = await account();
  if (workspace) await workspaces.system.update(workspace.id, { assistantsEnabled: enabled });
  else await workspaces.system.create({ singleton: 1, assistantsEnabled: enabled });
  if (Boolean(workspace?.assistantsEnabled) !== enabled) {
    const profiles = await serviceActors.system.list({ where: { kind: "assistant" }, limit: 20 });
    for (const profile of profiles) await serviceActors.system.update(profile.id, { version: serviceVersion() });
  }
  if (enabled) {
    const [original] = await serviceActors.system.list({ where: { kind: "assistant", handle: "ember" }, limit: 1 });
    if (!original) await serviceActors.system.create({
      kind: "assistant", name: "Ember", handle: "ember", instructions: "Help people with questions and writing. Keep replies concise.",
    });
  }
  return true;
});

export const saveAssistant = mutation({ access: "authenticated" }, async (input: {
  id?: string; handle: string; name: string; instructions: string; roomIds: string[];
  enabled: boolean; includeThreadRoot: boolean; directMessages: boolean;
}) => {
  await admin();
  const previous = input.id ? await serviceActors.system.get(numericId(input.id)) : null;
  if (input.id && (!previous || previous.kind !== "assistant")) throw new HttpError(404, "assistant_unavailable", "Assistant unavailable.");
  const handle = input.handle.trim().toLowerCase();
  const name = input.name.trim();
  const instructions = input.instructions.trim();
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(handle) || !name || name.length > 60 || !instructions || instructions.length > 2000 ||
    (handle === "ember" && previous?.handle !== "ember") || (previous?.handle === "ember" && handle !== "ember")) {
    throw new HttpError(422, "invalid_assistant", "Choose a name, instructions and a valid assistant handle.");
  }
  const ids = await validRooms(input.roomIds, 40);
  if (input.enabled && !ids.length && !input.directMessages) throw new HttpError(422, "invalid_assistant", "Choose a room or allow direct messages.");
  const [duplicate] = await serviceActors.system.list({ where: { kind: "assistant", handle }, limit: 1 });
  if (duplicate && duplicate.id !== previous?.id) throw new HttpError(409, "handle_in_use", "That handle is already in use.");
  if (!previous && await serviceActors.system.count({ where: { kind: "assistant" } }) >= 20) throw new HttpError(422, "assistant_limit", "The workspace already has 20 assistants.");
  const data = {
    handle, name, instructions, roomIds: JSON.stringify(ids), enabled: input.enabled,
    directMessages: input.directMessages, includeThreadRoot: input.includeThreadRoot, version: serviceVersion(),
  };
  if (previous) await serviceActors.system.update(previous.id, data);
  else await serviceActors.system.create({ ...data, kind: "assistant" });
  return true;
});

export async function assistantNotice(id: number) {
  const me = await actor();
  const room = await requireRoom(id);
  if (!await assistantsEnabled()) return "";
  const rows = await serviceActors.system.list({ where: { kind: "assistant", enabled: true }, limit: 20 });
  if (room.directKey) {
    const people = room.directKey.split(",");
    if (people.length !== 2) return "";
    const recipient = people.find(person => person !== me.id);
    return rows.some(row => row.directMessages && String(serviceOffset + row.id) === recipient)
      ? "Messages sent to this AI assistant are shared with OpenAI." : "";
  }
  const present = rows.filter(row => (JSON.parse(row.roomIds) as string[]).includes(String(room.id)));
  if (!present.length) return "";
  return present.some(row => row.includeThreadRoot)
    ? "Mention an AI assistant to share your message with OpenAI. Some assistants also receive the original thread message."
    : "Mention an AI assistant to share your message with OpenAI.";
}
