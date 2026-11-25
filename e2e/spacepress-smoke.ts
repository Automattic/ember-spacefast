import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";

const [origin, credentialsFile, screenshots] = process.argv.slice(2);
if (!origin || !credentialsFile) {
  throw new Error("Usage: node e2e/spacepress-smoke.ts <site URL> <credentials JSON> [screenshot directory]");
}
const site = new URL(origin).origin;
type Login = {
  username: string; password: string; name: string;
};
const [creator, member, outsider] = JSON.parse(await readFile(credentialsFile, "utf8")) as Login[];
assert(creator && member && outsider, "Supply credentials for three different WordPress users.");

const browser = await chromium.launch();
async function signIn(user: Login, width: number, height: number) {
  const page = await browser.newPage({ viewport: { width, height } });
  const login = new URL("/wp-login.php", site);
  login.searchParams.set("redirect_to", site + "/");
  await page.goto(login.href);
  await page.locator("#user_login").fill(user.username);
  await page.locator("#user_pass").fill(user.password);
  await page.locator("#wp-submit").click();
  await page.waitForURL(site + "/");
  return page;
}

function composer(page: Page) {
  return page.getByRole("textbox", { name: "Write a message" });
}

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

try {
  const desktop = await signIn(creator, 1440, 900);
  await desktop.goto(site + "/rooms/closeds/new");
  await desktop.getByRole("textbox", { name: "Room name" }).fill("Ember on SpacePress");
  await desktop.getByRole("switch", { name: `Give ${member.name} access to this room` }).click();
  await desktop.getByRole("button", { name: "Save", exact: true }).click();
  await desktop.waitForURL(/\/rooms\/\d+$/);
  const room = new URL(desktop.url()).pathname;

  const mobile = await signIn(member, 390, 844);
  await mobile.goto(site + room);
  await composer(mobile).waitFor();
  const first = "The private room is live on WordPress.";
  const second = "Confirmed from my phone-sized browser. This longer message should wrap inside the chat without pushing the composer off screen.";
  await send(desktop, first);
  await mobile.getByText(first, { exact: true }).waitFor({ timeout: 8000 });
  await send(mobile, second);
  await desktop.getByText(second, { exact: true }).waitFor({ timeout: 8000 });
  await mobile.reload();
  await mobile.getByText(first, { exact: true }).waitFor();
  assert.equal(await mobile.locator("body").evaluate(body => body.scrollWidth > innerWidth), false);

  const denied = await signIn(outsider, 1440, 900);
  const access = await denied.evaluate(async roomId => {
    const nonce = await (await fetch("/wp-admin/admin-ajax.php?action=rest-nonce")).text();
    const headers = { "X-WP-Nonce": nonce, "Content-Type": "application/json" };
    const actions = "/wp-json/wp-abilities/v1/abilities/ember/";
    const input = new URLSearchParams({ input: JSON.stringify({ operation: "room", id: roomId }) });
    const history = await fetch(actions + "ember-read/run?" + input, { headers });
    const send = await fetch(actions + "send-message/run", {
      method: "POST", headers,
      body: JSON.stringify({ input: { roomId: String(roomId), clientMessageId: "outsider-test", body: "Outsider test" } }),
    });
    const raw = await fetch("/wp-json/spacepress/v1/messages", { headers });
    return { history: history.status, send: send.status, raw: raw.status };
  }, Number(room.split("/").pop()));
  assert.deepEqual(access, { history: 404, send: 404, raw: 403 });
  await denied.goto(site + room);
  await denied.waitForURL(site + "/");
  assert.equal(await denied.getByText(first, { exact: true }).count(), 0);

  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await desktop.screenshot({ path: join(screenshots, "ember-spacepress-desktop.png") });
    await mobile.screenshot({ path: join(screenshots, "ember-spacepress-mobile.png") });
  }
  console.log(`Verified delivery in both directions, reload, mobile layout, and private-room access for ${room}.`);
} finally {
  await browser.close();
}
