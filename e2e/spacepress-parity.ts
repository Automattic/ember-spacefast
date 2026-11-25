import assert from "node:assert/strict";
import { createECDH, createPublicKey, randomUUID, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium, type Page } from "@playwright/test";
import { vapidPublicKey, vapidToken } from "../spacepress/sp/vapid.ts";

const [origin, credentialsFile, administratorFile] = process.argv.slice(2);
if (!origin || !credentialsFile) throw new Error("Usage: node e2e/spacepress-parity.ts <site URL> <credentials JSON>");
const site = new URL(origin).origin;
type Login = { username: string; password: string; name: string };
const [first, second, third] = JSON.parse(await readFile(credentialsFile, "utf8")) as Login[];
assert(first && second && third, "Supply credentials for three WordPress users.");
const browser = await chromium.launch();
const abilityPath = "/wp-json/wp-abilities/v1/abilities/ember/";

async function signIn(user: Login) {
  const page = await browser.newPage();
  page.setDefaultTimeout(20_000);
  const login = new URL("/wp-login.php", site);
  login.searchParams.set("redirect_to", site + "/");
  await page.goto(login.href);
  await page.locator("#user_login").fill(user.username);
  await page.locator("#user_pass").fill(user.password);
  await page.locator("#wp-submit").click();
  await page.waitForURL(url => url.origin === site && (url.pathname === "/" || url.pathname.startsWith("/rooms/")), {
    waitUntil: "domcontentloaded",
  });
  const nonce = await page.evaluate(async () => (await fetch("/wp-admin/admin-ajax.php?action=rest-nonce")).text());
  return { page, nonce };
}

type Session = { page: Page; nonce: string };

async function call(session: Session, action: string, input: object = {}, get = false, expected = 200) {
  const url = new URL(abilityPath + action + "/run", site);
  const headers = { "X-WP-Nonce": session.nonce };
  if (get) url.searchParams.set("input", JSON.stringify(input));
  const result = get
    ? await session.page.request.get(url.href, { headers })
    : await session.page.request.post(url.href, { headers, data: { input } });
  const body = await result.text();
  assert.equal(result.status(), expected, `${action} returned ${result.status()}: ${body}`);
  return JSON.parse(body);
}

function send(session: Session, roomId: string, body: string, parentId?: string) {
  return call(session, "send-message", {
    roomId, body: "<p>" + body + "</p>", plainText: body, parentId, clientMessageId: randomUUID(),
  });
}

function verifyVapidSignature() {
  const pair = createECDH("prime256v1");
  const publicKeyBytes = pair.generateKeys();
  const raw = Buffer.alloc(32);
  pair.getPrivateKey().copy(raw, 32 - pair.getPrivateKey().length);
  const key = raw.toString("base64url");
  assert.equal(vapidPublicKey(key), publicKeyBytes.toString("base64url"));
  const [header, payload, signature] = vapidToken(key, "https://web.push.apple.com", "mailto:ember@example.org", Date.now()).split(".");
  assert(header && payload && signature);
  const publicKey = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: publicKeyBytes.subarray(1, 33).toString("base64url"), y: publicKeyBytes.subarray(33).toString("base64url") },
    format: "jwk",
  });
  assert(verify("sha256", Buffer.from(header + "." + payload), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
}

const enrolled: { session: Session; id: string }[] = [];

async function enroll(session: Session) {
  const before = await call(session, "attachment-device-list", {}, true);
  await session.page.goto(site + "/users/me/profile");
  await session.page.getByRole("button", { name: "Enroll this browser", exact: true }).click();
  await session.page.getByText("This browser is enrolled.", { exact: true }).waitFor();
  const after = await call(session, "attachment-device-list", {}, true);
  const added = after.devices.find((device: { deviceId: string }) =>
    !before.devices.some((old: { deviceId: string }) => old.deviceId === device.deviceId));
  assert(added, "The enrolled browser has a new device record.");
  enrolled.push({ session, id: added.deviceId });
  const code = session.page.locator("#attachment-devices code");
  await code.waitFor();
  return { id: String(added.deviceId), fingerprint: (await code.innerText()).trim() };
}

async function verifyProtectedFile(sender: Session, receiver: Session, roomId: string) {
  const senderDevice = await enroll(sender);
  const receiverDevice = await enroll(receiver);
  const settings = site + "/rooms/closeds/" + roomId + "/edit";
  for (const [session, device] of [[sender, receiverDevice], [receiver, senderDevice]] as const) {
    await session.page.goto(settings);
    const row = session.page.getByRole("listitem").filter({ hasText: device.id });
    await row.getByLabel("Full fingerprint", { exact: false }).fill(device.fingerprint);
    await row.getByRole("button", { name: "Verify device", exact: true }).click();
    await row.getByText("Device verified.", { exact: true }).waitFor();
  }
  const url = site + "/rooms/" + roomId;
  await sender.page.goto(url);
  await receiver.page.goto(url);
  const content = "Protected Ember attachment";
  const name = "spacepress-private.txt";
  await sender.page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(content) });
  await sender.page.getByRole("button", { name: "Send Message", exact: true }).click();
  await receiver.page.getByRole("button", { name: "Open encrypted attachment: " + name, exact: true }).click();
  const link = receiver.page.getByRole("link", { name: "Download " + name, exact: true });
  await link.waitFor();
  const decoded = await link.evaluate(async anchor => (await fetch((anchor as HTMLAnchorElement).href)).text());
  assert.equal(decoded, content);
}

async function verifyOpenFile(sender: Session, receiver: Session) {
  const room = await call(sender, "create-room", { name: "SpacePress open attachment check", kind: "open" });
  await sender.page.goto(site + "/rooms/" + room.id);
  await receiver.page.goto(site + "/rooms/" + room.id);
  const content = "Ember file for an open room";
  const name = "spacepress-open.txt";
  await sender.page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(content) });
  await sender.page.getByRole("button", { name: "Send Message", exact: true }).click();
  const link = receiver.page.getByRole("link", { name: "Download " + name, exact: true });
  await link.waitFor();
  const decoded = await link.evaluate(async anchor => (await fetch((anchor as HTMLAnchorElement).href)).text());
  assert.equal(decoded, content);
}

try {
  verifyVapidSignature();
  const guest = await browser.newPage();
  const joinPath = "/join/ember-parity-check";
  await guest.goto(site + joinPath);
  const signInLink = await guest.getByRole("link", { name: "Sign in with WordPress" }).getAttribute("href");
  assert(signInLink);
  assert.equal(new URL(signInLink).searchParams.get("redirect_to"), site + joinPath);
  await guest.close();
  const maya = await signIn(first);
  const jules = await signIn(second);
  const outsider = await signIn(third);
  const unreserved = await outsider.page.request.post(site + "/wp-json/spacepress/v1/files/attachmentChunks", {
    headers: { "X-WP-Nonce": outsider.nonce },
    multipart: { file: { name: "unreserved.txt", mimeType: "text/plain", buffer: Buffer.from("No attachment reservation") } },
  });
  assert.equal(unreserved.status(), 403, await unreserved.text());
  const me = await call(maya, "ember-read", { operation: "bootstrap" }, true);
  const other = await call(jules, "ember-read", { operation: "bootstrap" }, true);
  const room = await call(maya, "create-room", { name: "SpacePress parity check", kind: "closed", memberIds: [other.user.id] });
  const marker = "parity" + randomUUID().replaceAll("-", "");
  const root = await send(maya, room.id, marker);
  const reply = await send(jules, room.id, "Reply inside the thread", root.id);
  const timeline = await call(jules, "ember-read", { operation: "room", id: Number(room.id) }, true);
  assert.equal(timeline.messages.length, 1);
  assert.equal(timeline.messages[0].thread.count, 1);
  const thread = await call(maya, "ember-read", { operation: "thread", id: Number(root.id) }, true);
  assert.equal(thread.messages[0].id, reply.id);
  assert.equal(thread.messages[0].parentId, root.id);

  const boost = await call(jules, "react", { messageId: root.id, content: "🌱" });
  const reacted = await call(jules, "ember-read", { operation: "thread", id: Number(root.id) }, true);
  assert.equal(reacted.parent.boosts[0].id, boost.id);
  await call(jules, "unreact", { id: boost.id });
  await call(jules, "edit-message", { messageId: root.id, body: "<p>Reader edit</p>", plainText: "Reader edit" }, false, 403);
  const edited = await call(maya, "edit-message", { messageId: root.id, body: "<p><strong>" + marker + "</strong></p>", plainText: marker });
  assert(edited.body.includes("<strong>") && edited.editedAt);

  const authorized = await call(jules, "ember-search", { q: marker }, true);
  assert(authorized.messages.some((message: { id: string }) => message.id === root.id));
  const secret = await call(outsider, "ember-search", { q: marker }, true);
  assert.equal(secret.messages.length, 0);
  await call(outsider, "ember-read", { operation: "thread", id: Number(root.id) }, true, 404);

  const dm = await call(maya, "start-direct", { userIds: [other.user.id] });
  const existing = await call(jules, "start-direct", { userIds: [me.user.id] });
  assert.equal(existing.id, dm.id);
  assert.equal(existing.kind, "direct");
  await send(maya, dm.id, "Private direct message");
  await call(maya, "send-message", {
    roomId: dm.id, body: "Duplicate across rooms", clientMessageId: root.clientMessageId,
  }, false, 409);
  await call(outsider, "ember-read", { operation: "room", id: Number(dm.id) }, true, 404);

  await verifyProtectedFile(maya, jules, room.id);
  await verifyOpenFile(maya, jules);
  await call(jules, "update-membership", { roomId: room.id, favorite: true, involvement: "everything" });
  const sidebar = await call(jules, "ember-read", { operation: "sidebar" }, true);
  assert(sidebar.favorites.rooms.includes(room.id));
  await call(maya, "update-room", { roomId: room.id, memberIds: [me.user.id], kind: "closed" });
  await call(jules, "ember-read", { operation: "room", id: Number(room.id) }, true, 404);
  await call(maya, "delete-message", { id: root.id });
  const deleted = await call(maya, "ember-read", { operation: "thread", id: Number(root.id) }, true);
  assert.equal(deleted.parent.deleted, true);
  assert.equal(deleted.parent.body, "");
  const removed = await call(maya, "ember-search", { q: marker }, true);
  assert.equal(removed.messages.length, 0);

  if (administratorFile) {
    const wordpress = await signIn(JSON.parse(await readFile(administratorFile, "utf8")) as Login);
    const open = await call(wordpress, "create-room", { name: "SpacePress webhook check", kind: "open" });
    const key = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const bot = await call(wordpress, "create-bot", { name: "Parity bot", roomIds: [open.id], secret: key });
    const webhook = site + "/webhooks/" + bot.id + "/" + open.id + "/";
    const denied = await outsider.page.request.post(webhook + "invalid-key/slack", { data: { text: "Unauthorised" } });
    assert.equal(denied.status(), 403);
    const request = {
      headers: { "Idempotency-Key": randomUUID() },
      data: { text: "*Slack webhook*", username: "Forged", blocks: [
        { type: "section", text: { type: "mrkdwn", text: "A Slack card" } },
        { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open" }, url: "https://example.org/", style: "primary" }] },
        { type: "rich_text", elements: [{ type: "rich_text_list", style: "ordered", elements: [
          { type: "rich_text_section", elements: [{ type: "text", text: "First" }] },
        ] }] },
      ] },
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const accepted = await outsider.page.request.post(webhook + key + "/slack", request);
      assert.equal(accepted.status(), 200);
      assert.equal(await accepted.text(), "ok");
    }
    const view = await call(wordpress, "ember-read", { operation: "room", id: Number(open.id) }, true);
    assert.equal(view.messages.length, 1);
    assert.equal(view.messages[0].creator.name, "Parity bot");
    assert(view.messages[0].body.includes("<strong>Slack webhook</strong>"));
    assert.equal(view.messages[0].cards[0].parts[0].kind, "section");
    assert.equal(view.messages[0].cards[0].parts[1].buttons[0].text, "Open");
    assert.equal(view.messages[0].cards[0].parts[1].buttons[0].style, "primary");
    assert.equal(view.messages[0].cards[0].parts[2].html, "<ol><li>First</li></ol>");
    await call(wordpress, "assistant-list", {}, true);
    await call(wordpress, "invitation-list", {}, true);
    console.log("Verified webhook authentication, Slack cards, idempotency, and integration settings.");
  }
  console.log("Verified SpacePress DMs, threads, formatted edits, reactions, private search, favorites, encrypted files, membership changes, and VAPID signatures.");
} finally {
  await Promise.allSettled(enrolled.map(device => call(device.session, "revoke-attachment-device", { id: device.id })));
  await browser.close();
}
