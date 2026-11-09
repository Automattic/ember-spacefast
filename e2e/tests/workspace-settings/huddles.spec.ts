import { APP_ID_UNKNOWN, APP_SECRET_UNKNOWN } from "@ember/protocol/huddles";
import type { APIRequestContext, Page } from "@playwright/test";
import { administratorSession, cookieHeader, expect, SAME_ORIGIN, signInAsAdministrator, test, useOwnAddress } from "../../fixtures";
import { AI_GATEWAY_ACCOUNT, SFU_APP } from "../../projects/workspace-settings";
import { startFakeSfu, type FakeSfu } from "./fake-sfu";

// Rooms and permissions' Huddles card and Set up huddles, on the second test server, which asks the
// Realtime SFU this spec fakes to start a session with the keys it's given. Each test leaves the
// workspace as a new one is: huddles off.

let sfu: FakeSfu;
test.beforeAll(async () => void (sfu = await startFakeSfu()));
test.afterAll(() => sfu.close());
test.afterEach(async ({ request }) => {
  const forgotten = await request.delete("/api/account/huddles", { headers: await asAdministrator(request) });
  expect(forgotten.status(), await forgotten.text()).toBe(200);
});

/** The administrator's session's headers, for the API. */
const asAdministrator = async (request: APIRequestContext) => ({ Cookie: cookieHeader(await administratorSession(request)), ...SAME_ORIGIN });

/** The Huddles card on the page. */
const huddlesCard = (page: Page) => page.getByRole("region", { name: "Huddles", exact: true });

/** Opens Rooms and permissions as the administrator, answering its Huddles card. */
async function openHuddles(page: Page) {
  await useOwnAddress(page);
  await page.goto("/account/edit#channel-settings");
  await signInAsAdministrator(page);
  return huddlesCard(page);
}

test.describe("Set up huddles", () => {
  test("the administrator gives Ember an SFU app's keys, which Cloudflare starts a session with, and Ember keeps them", async ({ page }) => {
    const huddles = await openHuddles(page);
    await expect(huddles).toContainText("Huddles let people in a room talk to each other.");
    const huddlesSwitch = huddles.getByRole("switch", { name: "Huddles" });
    await expect(huddlesSwitch).not.toBeChecked();
    await huddlesSwitch.click();

    const setup = page.getByRole("dialog");
    await expect(setup).toHaveAccessibleName("Set up huddles");
    // The dashboard opens at the account Ember is deployed to.
    await expect(setup.getByRole("link", { name: "Open Serverless SFU in the Cloudflare dashboard" })).toHaveAttribute(
      "href",
      `https://dash.cloudflare.com/${AI_GATEWAY_ACCOUNT.accountId}/realtime/sfu`,
    );
    const [appId, appSecret] = [setup.getByRole("textbox", { name: "App ID" }), setup.getByRole("textbox", { name: "App Secret" })];
    const save = setup.getByRole("button", { name: "Save" });

    // An app Cloudflare doesn't know comes back to its field, as does a secret that isn't the app's.
    await appId.fill("0".repeat(32));
    await appSecret.fill(SFU_APP.appSecret);
    await save.click();
    await expect(setup.getByRole("alert")).toHaveText(APP_ID_UNKNOWN);
    await expect(appId).toHaveAccessibleDescription(APP_ID_UNKNOWN);
    await appId.fill(SFU_APP.appId);
    await appSecret.fill("f".repeat(64));
    await save.click();
    await expect(setup.getByRole("alert")).toHaveText(APP_SECRET_UNKNOWN);
    await expect(appSecret).toHaveAccessibleDescription(APP_SECRET_UNKNOWN);

    await appSecret.fill(SFU_APP.appSecret);
    await save.click();
    await expect(setup).toHaveAccessibleName("Huddles are set up");
    expect(sfu.asked.at(-1)).toEqual({ method: "POST", path: `/v1/apps/${SFU_APP.appId}/sessions/new`, authorization: `Bearer ${SFU_APP.appSecret}` });
    await setup.getByRole("button", { name: "Done" }).click();
    await expect(setup).toBeHidden();
    await expect(huddles).toContainText(`Huddles run through the Realtime SFU app ${SFU_APP.appId} in your Cloudflare account.`);
    await expect(huddlesSwitch).toBeChecked();

    // Ember keeps the keys, and Change keys starts from the app's ID, asking for its secret again.
    await page.reload();
    await expect(huddlesCard(page).getByRole("switch", { name: "Huddles" })).toBeChecked();
    await huddlesCard(page).getByRole("button", { name: "Change keys" }).click();
    await expect(page.getByRole("dialog").getByRole("textbox", { name: "App ID" })).toHaveValue(SFU_APP.appId);
    await expect(page.getByRole("dialog").getByRole("textbox", { name: "App Secret" })).toHaveValue("");
    await expect(page.getByRole("dialog")).toContainText("Ember has an app's keys already.");
  });

  test("the administrator turns huddles off, once they're sure, which forgets the app's keys", async ({ page, request }) => {
    const saved = await request.put("/api/account/huddles", { data: SFU_APP, headers: await asAdministrator(request) });
    expect(saved.status(), await saved.text()).toBe(200);
    const huddles = await openHuddles(page);
    page.once("dialog", (dialog) => void dialog.accept());
    const huddlesSwitch = huddles.getByRole("switch", { name: "Huddles" });
    await expect(huddlesSwitch).toBeChecked();
    await huddlesSwitch.click();
    await expect(huddlesSwitch).not.toBeChecked();
    await expect(huddlesSwitch).toBeEnabled();
    await expect(huddles.getByRole("button", { name: "Change keys" })).toHaveCount(0);
    await page.reload();
    await expect(huddlesCard(page).getByRole("switch", { name: "Huddles" })).not.toBeChecked();
  });
});
