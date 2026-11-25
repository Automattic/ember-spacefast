import { createHash } from "node:crypto";
import { HttpError, job, mutation, query } from "spacepress";
import { memberships, messages, pushSubscriptions, rooms } from "spacepress:db";
import { actor, membership, personView } from "./access";
import { vapidPublicKey, vapidToken } from "./vapid";

function pushOrigin(endpoint: string) {
  if (/^https:\/\/fcm\.googleapis\.com\/fcm\/send\/[a-zA-Z0-9_:-]{16,2048}$/.test(endpoint)) return "https://fcm.googleapis.com";
  if (/^https:\/\/updates\.push\.services\.mozilla\.com\/wpush\/v2\/[a-zA-Z0-9_-]{16,2048}$/.test(endpoint)) return "https://updates.push.services.mozilla.com";
  if (/^https:\/\/web\.push\.apple\.com\/[a-zA-Z0-9_-]{16,2048}$/.test(endpoint)) return "https://web.push.apple.com";
  return "";
}

function settings() {
  const privateKey = process.env.EMBER_PUSH_PRIVATE_KEY ?? "";
  const contact = process.env.EMBER_PUSH_CONTACT ?? "";
  if (!/^[A-Za-z0-9_-]{43}$/.test(privateKey) || !/^(?:mailto:|https:\/\/)[!-~]{3,500}$/.test(contact)) return null;
  const configured = process.env.EMBER_PUSH_PUBLIC_KEY ?? "";
  const publicKey = /^[A-Za-z0-9_-]{87}$/.test(configured) ? configured : vapidPublicKey(privateKey);
  return publicKey ? { privateKey, publicKey, contact } : null;
}

async function forEndpoint(endpoint: string) {
  const endpointHash = createHash("sha256").update(endpoint).digest("hex");
  const [existing] = await pushSubscriptions.system.list({ where: { endpointHash }, limit: 1 });
  return { endpointHash, existing };
}

export const pushSettings = query({ access: "authenticated" }, async (input: { endpoint: string; expectedPersonId: string }) => {
  const me = await actor();
  if (me.id !== input.expectedPersonId) throw new HttpError(403, "account_changed", "Your Ember account changed.");
  const config = settings();
  if (!pushOrigin(input.endpoint)) return { publicKey: config?.publicKey ?? null, enabled: false, needsRefresh: false };
  const { existing } = await forEndpoint(input.endpoint);
  const enabled = existing?.personId === me.wpId;
  return { publicKey: config?.publicKey ?? null, enabled, needsRefresh: Boolean(enabled && config && existing && config.publicKey !== existing.publicKey) };
});

export const savePush = mutation({ access: "authenticated", rateLimit: "12/hour" }, async (input: { endpoint: string; expectedPersonId: string; publicKey: string }) => {
  const me = await actor();
  const config = settings();
  if (me.id !== input.expectedPersonId || !config || input.publicKey !== config.publicKey || !pushOrigin(input.endpoint)) {
    throw new HttpError(422, "subscription_unavailable", "This browser’s push subscription is unavailable.");
  }
  const { endpointHash, existing } = await forEndpoint(input.endpoint);
  if (existing) {
    if (existing.personId !== me.wpId) throw new HttpError(409, "subscription_exists", "This browser belongs to a different Ember account.");
    if (existing.publicKey !== input.publicKey) throw new HttpError(409, "subscription_changed", "Refresh this browser’s push subscription.");
    return true;
  }
  const devices = await pushSubscriptions.system.list({ where: { personId: me.wpId }, orderBy: { id: "asc" }, limit: 4 });
  const oldest = devices[0];
  if (devices.length >= 4 && oldest) await pushSubscriptions.system.delete(oldest.id);
  await pushSubscriptions.system.create({ personId: me.wpId, endpoint: input.endpoint, endpointHash, publicKey: input.publicKey });
  return true;
});

export const removePush = mutation({ access: "authenticated" }, async (input: { endpoint: string; expectedPersonId: string }) => {
  const me = await actor();
  if (me.id !== input.expectedPersonId || !pushOrigin(input.endpoint)) return false;
  const { existing } = await forEndpoint(input.endpoint);
  if (!existing || existing.personId !== me.wpId) return false;
  await pushSubscriptions.system.delete(existing.id);
  return true;
});

export const roomPush = job({ retries: 4 }, async ({ subscriptionId, messageId }: { subscriptionId: number; messageId: number }) => {
  const subscription = await pushSubscriptions.system.get(subscriptionId);
  const message = await messages.system.get(messageId);
  if (!subscription || !message) return;
  const elapsed = Date.now() - new Date(message.createdAt).getTime();
  if (message.removed || message.authorId === subscription.personId || elapsed > 2700000) return;
  const config = settings();
  const origin = pushOrigin(subscription.endpoint);
  if (!config || config.publicKey !== subscription.publicKey || !origin) return;
  const room = await rooms.system.get(message.roomId);
  if (!room || room.archived) return;
  const recipient = await personView(subscription.personId);
  if (recipient.status !== "active") return;
  const member = await membership(message.roomId, subscription.personId);
  if ((room.closed && !member) || (member && member.lastReadId >= messageId)) return;
  const involvement = member?.involvement ?? "mentions";
  const mentioned = message.markup.includes('<action-text-attachment sgid="' + subscription.personId + '"');
  if (involvement !== "everything" && (involvement !== "mentions" || !mentioned)) return;
  const token = vapidToken(config.privateKey, origin, config.contact, Date.now());
  if (!token) return;
  const response = await fetch(subscription.endpoint, {
    method: "POST", redirect: "error",
    headers: { Authorization: "vapid t=" + token + ", k=" + config.publicKey, TTL: "300", Topic: "ember_activity" },
  });
  if (response.status === 404 || response.status === 410) await pushSubscriptions.system.delete(subscription.id);
  if (response.status === 429 || response.status >= 500) throw new Error("Push provider is temporarily unavailable.");
});

export async function enqueuePush(messageId: number, roomId: number, authorId: number, mentioned: string[]) {
  if (!process.env.EMBER_PUSH_PRIVATE_KEY || !process.env.EMBER_PUSH_CONTACT) return;
  const records = await memberships.system.list({ where: { roomId, involvement: "everything" }, limit: 100 });
  const recipients: number[] = records.map(record => record.personId);
  for (const id of mentioned) {
    const personId = Number(id);
    if (!recipients.includes(personId)) recipients.push(personId);
  }
  let count = 0;
  for (const personId of recipients) {
    if (personId === authorId) continue;
    const devices = await pushSubscriptions.system.list({ where: { personId }, limit: 4 });
    for (const device of devices) {
      await roomPush.enqueue({ subscriptionId: device.id, messageId }, { key: "ember-push-" + device.id + "-" + messageId });
      count++;
      if (count >= 24) return;
    }
  }
}
