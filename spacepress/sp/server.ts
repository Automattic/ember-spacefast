import { query } from "spacepress";
import { get_current_user_id, get_userdata } from "php/wordpress";
import { actor, directory, personView } from "./access";
import { readTimeline, roomAfter, roomAround, thread } from "./messages";
import { roomSettings, sidebar } from "./rooms";
import { recent } from "./search";
import { accountView, canJoinByEmail, initialized, settings } from "./workspace";
import { assistantNotice } from "./service-settings";

export const emberBootstrap = query({ access: "authenticated" }, async () => {
  const id = get_current_user_id();
  const person = await personView(id);
  const wordpress = get_userdata(id);
  const ready = await initialized();
  return {
    setup: ready ? "complete" : "pending",
    nativeAuth: {
      signedIn: Boolean(id), member: ready && person.status !== "pending",
      canJoinByEmailDomain: wordpress ? canJoinByEmail(wordpress.user_email) : false,
      identityId: String(id), setupEligibility: person.administrator ? "eligible" : "owner_not_configured",
    },
    setupPlaceholders: { name: person.name, email: wordpress ? wordpress.user_email : "" },
    user: ready && person.status === "active" ? person : null,
    account: await accountView(),
  };
});

export const emberProfile = query({ access: "authenticated" }, async () => {
  const user = await actor();
  const wordpress = get_userdata(user.wpId);
  return { user: { ...user, emailAddress: wordpress ? wordpress.user_email : "" }, memberful: null };
});

export const emberSettings = query({ access: "authenticated" }, async () => {
  await actor();
  return await settings();
});

export const emberRecentSearches = query({ access: "authenticated" }, async () => {
  await actor();
  return await recent();
});

export const emberDirectory = query({ access: "authenticated" }, async () => {
  await actor();
  return await directory();
});

export const emberSidebar = query({ access: "authenticated" }, async () => {
  await actor();
  return await sidebar();
});

export const emberRoom = query({ access: "authenticated" }, async ({ id, cursor }: { id?: number; cursor?: number }) => {
  await actor();
  return await readTimeline(id ?? 0, cursor);
});

export const emberRoomAfter = query({ access: "authenticated" }, async ({ id, cursor }: { id?: number; cursor?: number }) => {
  await actor();
  return await roomAfter(id ?? 0, cursor ?? 0);
});

export const emberRoomAround = query({ access: "authenticated" }, async ({ id, cursor }: { id?: number; cursor?: number }) => {
  await actor();
  return await roomAround(id ?? 0, cursor);
});

export const emberThread = query({ access: "authenticated" }, async ({ id, cursor }: { id?: number; cursor?: number }) => {
  await actor();
  return await thread(id ?? 0, cursor);
});

export const emberRoomSettings = query({ access: "authenticated" }, async ({ id }: { id?: number }) => {
  await actor();
  return await roomSettings(id ?? 0);
});

export const emberAssistantNotice = query({ access: "authenticated" }, async ({ id }: { id?: number }) => {
  await actor();
  return await assistantNotice(id ?? 0);
});
