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
async function signIn(user: Login, width: number, height: number, through?: string) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.setDefaultTimeout(20_000);
  const login = new URL("/wp-login.php", site);
  login.searchParams.set("redirect_to", site + "/");
  await page.goto(through ? site + through : login.href);
  if (through) {
    const link = page.getByRole("link", { name: "Sign in with WordPress" });
    const href = await link.getAttribute("href");
    assert(href);
    assert.equal(new URL(href).searchParams.get("redirect_to"), site + through);
    await link.click();
  }
  await page.locator("#user_login").fill(user.username);
  await page.locator("#user_pass").fill(user.password);
  await page.locator("#wp-submit").click();
  await page.waitForURL(url => url.origin === site && (through
    ? url.pathname.replace(/\/$/, "") === through
    : url.pathname === "/" || url.pathname.startsWith("/rooms/")), {
    waitUntil: "domcontentloaded",
  });
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

  const guest = await browser.newPage();
  const replyLink = room + "/threads/1/@2";
  await guest.goto(site + replyLink);
  const threadSignIn = await guest.getByRole("link", { name: "Sign in with WordPress" }).getAttribute("href");
  assert(threadSignIn);
  assert.equal(new URL(threadSignIn).searchParams.get("redirect_to"), site + replyLink);
  await guest.close();

  const mobile = await signIn(member, 390, 844, room);
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
  const deniedRead = denied.waitForResponse(
    response => response.url().includes("/ember-read/run") && response.status() === 404,
    { timeout: 15_000 },
  );
  // The loaded sidebar can redirect before the room query returns.
  const opened = denied.goto(site + room);
  await Promise.any([deniedRead, opened.then(() => denied.waitForURL(site + "/", { timeout: 15_000 }))]);
  assert.equal(await denied.getByText(first, { exact: true }).count(), 0);

  const roomRead = (url: URL) => {
    if (!url.pathname.endsWith("/ember-read/run")) return false;
    const input = JSON.parse(url.searchParams.get("input") ?? "{}");
    return input.operation === "room";
  };
  await mobile.route(roomRead, route => route.abort("connectionfailed"));
  await mobile.getByText("Offline", { exact: true }).waitFor({ state: "visible" });
  await mobile.unroute(roomRead);
  await mobile.getByText("Offline", { exact: true }).waitFor({ state: "hidden" });

  if (screenshots) {
    await mkdir(screenshots, { recursive: true });
    await desktop.screenshot({ path: join(screenshots, "ember-spacepress-desktop.png") });
    await mobile.screenshot({ path: join(screenshots, "ember-spacepress-mobile.png") });
  }

  const owner = await desktop.evaluate(async () => {
    const nonce = await (await fetch("/wp-admin/admin-ajax.php?action=rest-nonce")).text();
    const result = await fetch("/wp-json/wp-abilities/v1/abilities/ember/ember-read/run?input=" + encodeURIComponent('{"operation":"bootstrap"}'), {
      headers: { "X-WP-Nonce": nonce },
    });
    return { nonce, personId: (await result.json()).user.id };
  });
  const roomId = room.split("/").pop();
  await mobile.bringToFront();
  const update = await desktop.request.post(site + "/wp-json/wp-abilities/v1/abilities/ember/update-room/run", {
    headers: { "X-WP-Nonce": owner.nonce },
    data: { input: { roomId, kind: "closed", memberIds: [owner.personId] } },
  });
  assert.equal(update.status(), 200, await update.text());
  await mobile.waitForURL(url => url.origin === site && (
    url.pathname === "/" || url.pathname === "/rooms" ||
    (url.pathname.startsWith("/rooms/") && url.pathname.replace(/\/$/, "") !== room)
  ), { waitUntil: "domcontentloaded" });
  await mobile.getByText(first, { exact: true }).waitFor({ state: "hidden" });

  await desktop.bringToFront();
  await desktop.context().clearCookies();
  const signInAgain = desktop.getByRole("link", { name: "Sign in with WordPress" });
  await signInAgain.waitFor();
  const returnLink = await signInAgain.getAttribute("href");
  assert(returnLink);
  assert.equal(new URL(returnLink).searchParams.get("redirect_to"), site + room);
  await desktop.getByText(first, { exact: true }).waitFor({ state: "hidden" });
  console.log(`Verified room sign-in, chat, outage recovery, live access revocation, and session expiry for ${room}.`);
} finally {
  await browser.close();
}
