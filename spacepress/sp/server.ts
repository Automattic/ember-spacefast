import { HttpError, query } from "spacepress";
import { get_current_user_id, get_userdata } from "php/wordpress";
import { actor, directory, personView } from "./access";
import { readTimeline, roomAfter, roomAround, thread } from "./messages";
import { roomSettings, sidebar } from "./rooms";
import { recent } from "./search";
import { accountView, canJoinByEmail, initialized, settings } from "./workspace";
import { assistantNotice } from "./service-settings";

export const emberRead = query({ access: "authenticated" }, async ({ operation, id, cursor }: {
  operation: string; id?: number; cursor?: number;
}) => {
  if (operation === "bootstrap") {
    const id = get_current_user_id();
    const person = await personView(id);
    const wordpress = get_userdata(id);
    const ready = await initialized();
    return {
      setup: ready ? "complete" : "pending",
      nativeAuth: {
        signedIn: Boolean(id), member: person.status !== "pending",
        canJoinByEmailDomain: wordpress ? canJoinByEmail(wordpress.user_email) : false,
        identityId: String(id), setupEligibility: person.administrator ? "eligible" : "owner_not_configured",
      },
      setupPlaceholders: { name: person.name, email: wordpress ? wordpress.user_email : "" },
      user: ready && person.status === "active" ? person : null,
      account: await accountView(),
    };
  }
  const user = await actor();
  if (operation === "profile") {
    const wordpress = get_userdata(user.wpId);
    return { user: { ...user, emailAddress: wordpress ? wordpress.user_email : "" }, memberful: null };
  }
  if (operation === "settings") return await settings();
  if (operation === "recentSearches") return await recent();
  if (operation === "directory") return await directory();
  if (operation === "sidebar") return await sidebar();
  if (operation === "room") return await readTimeline(id ?? 0, cursor);
  if (operation === "roomAfter") return await roomAfter(id ?? 0, cursor ?? 0);
  if (operation === "roomAround") return await roomAround(id ?? 0, cursor);
  if (operation === "thread") return await thread(id ?? 0, cursor);
  if (operation === "roomSettings") return await roomSettings(id ?? 0);
  if (operation === "assistantNotice") return await assistantNotice(id ?? 0);
  throw new HttpError(501, "unsupported", "This operation is not available in Ember on SpacePress.");
});
