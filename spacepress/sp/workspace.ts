import { HttpError, mutation } from "spacepress";
import { get_userdata } from "php/wordpress";
import { profiles, rooms, workspaces } from "spacepress:db";
import { account, actor, admin, ensureMember, numericId, personView } from "./access";
import { assistantReady } from "./service-settings";

export async function accountView() {
  const saved = await account();
  return {
    name: saved?.name ?? "Ember",
    tagline: saved?.tagline ?? "",
    hideTranslationButtons: true,
    emailDomains: signupDomains(),
    navigationIcons: JSON.parse(saved?.navigationIcons ?? "{}"),
    huddles: false,
    customDomain: null,
    logo: saved?.logo || null,
    customStyles: "",
    restrictRoomCreation: saved?.restrictRoomCreation ?? false,
    openSignUp: saved?.openSignUp ?? false,
    joinLink: saved?.joinLink ?? false,
    memberfulSignIn: false, memberfulJoin: false, emailDomainSignUp: signupDomains().length > 0,
    assistantConfigured: assistantReady(),
  };
}

function signupDomains() {
  return (process.env.EMBER_SIGNUP_EMAIL_DOMAINS ?? "").toLowerCase().split(",").map(entry => entry.trim())
    .filter(entry => /^(?:[a-z0-9-]+\.)+[a-z]{2,63}$/.test(entry));
}

export function canJoinByEmail(email: string) {
  const domain = email.trim().toLowerCase().split("@")[1] ?? "";
  return signupDomains().includes(domain);
}

export async function initialized() {
  return Boolean(await account()) || await rooms.system.count() > 0;
}

export const setup = mutation({ access: "authenticated" }, async (input: {
  name?: string; workspaceName?: string; joinCode?: string; invitationToken?: string;
}) => {
  const me = await admin();
  if (await initialized()) throw new HttpError(409, "workspace_exists", "This workspace is already set up.");
  const name = input.workspaceName?.trim() || "Ember";
  if (name.length > 80) throw new HttpError(422, "invalid_name", "Enter a shorter workspace name.");
  await workspaces.system.create({ singleton: 1, name });
  const room = await rooms.system.create({ name: "General", owner: me.wpId });
  await ensureMember(room.id, me.wpId, false);
  return me;
});

export async function settings() {
  const me = await admin();
  const workspace = await account();
  return {
    account: await accountView(),
    emailDomains: [], emailFrom: "", email: { configured: false }, joinCode: workspace?.joinCode ?? "", native: true,
    capabilities: { passwords: false, transfers: false, memberful: false, customDomain: "platform-managed", files: "encrypted-chunks" },
    ownerId: me.id,
  };
}

function navigationIcons(saved: string, changes: Record<string, string>) {
  const icons = JSON.parse(saved) as Record<string, string>;
  for (const [slot, icon] of Object.entries(changes)) {
    if (!["home", "dms", "activity", "search", "admin", "light", "dark", "system"].includes(slot) ||
      typeof icon !== "string" || (icon && !/^(?:iconoir:(?:solid|regular):)?[a-z0-9-]{1,100}$/.test(icon))) {
      throw new HttpError(422, "invalid_navigation_icon", "Choose a valid navigation icon.");
    }
    if (icon) icons[slot] = icon;
    else delete icons[slot];
  }
  return JSON.stringify(icons);
}

export const updateAccount = mutation({ access: "authenticated" }, async (input: {
  name?: string; tagline?: string; logo?: string; openSignUp?: boolean; restrictRoomCreation?: boolean;
  joinCode?: string; joinLink?: boolean; navigationIcons?: Record<string, string>;
}) => {
  await admin();
  const workspace = await account();
  const name = input.name?.trim() ?? workspace?.name ?? "Ember";
  if (!name || name.length > 80) throw new HttpError(422, "invalid_name", "Enter a workspace name.");
  const data = {
    name, tagline: input.tagline ?? workspace?.tagline ?? "",
    logo: input.logo ?? workspace?.logo ?? "", openSignUp: input.openSignUp ?? workspace?.openSignUp ?? false,
    restrictRoomCreation: input.restrictRoomCreation ?? workspace?.restrictRoomCreation ?? false,
    joinCode: input.joinCode ?? workspace?.joinCode ?? "",
    joinLink: input.joinLink ?? workspace?.joinLink ?? false,
    navigationIcons: input.navigationIcons
      ? navigationIcons(workspace?.navigationIcons ?? "{}", input.navigationIcons)
      : workspace?.navigationIcons ?? "{}",
  };
  if (workspace) await workspaces.system.update(workspace.id, data);
  else await workspaces.system.create({ singleton: 1, ...data });
  return await accountView();
});

export const profile = mutation({ access: "authenticated" }, async (input: { name?: string; bio?: string; timeZone?: string; avatar?: string }) => {
  const me = await actor();
  const [existing] = await profiles.system.list({ where: { personId: me.wpId }, limit: 1 });
  const name = input.name?.trim() ?? me.name;
  if (!name || name.length > 80) throw new HttpError(422, "invalid_name", "Enter your display name.");
  const avatar = input.avatar?.trim() ?? me.avatarUrl ?? "";
  if (avatar && (avatar.length > 2000 || !/^https?:\/\/[^\s]+$/i.test(avatar))) {
    throw new HttpError(422, "invalid_avatar", "Enter an image URL.");
  }
  const data = { name, bio: input.bio ?? me.bio, timeZone: input.timeZone ?? me.timeZone, avatar };
  if (data.bio.length > 2000) throw new HttpError(422, "invalid_bio", "Your profile is too long.");
  if (existing) await profiles.system.update(existing.id, data);
  else await profiles.system.create({ personId: me.wpId, ...data });
  return { user: await personView(me.wpId) };
});

export const updatePerson = mutation({ access: "authenticated" }, async (input: { personId: string; role?: string; status?: string }) => {
  const me = await admin();
  const id = numericId(input.personId);
  const user = get_userdata(id);
  if (!user) throw new HttpError(404, "person_unavailable", "Person unavailable.");
  const target = await personView(id);
  const role = input.role ?? target.role;
  const status = input.status ?? target.status;
  if (!["member", "administrator"].includes(role) || !["active", "deactivated", "banned"].includes(status)) {
    throw new HttpError(422, "invalid_role", "Invalid membership change.");
  }
  if ((me.wpId === id || user.roles.includes("administrator")) && (role !== "administrator" || status !== "active")) {
    throw new HttpError(403, "protected_administrator", "WordPress administrators must retain workspace access.");
  }
  const [existing] = await profiles.system.list({ where: { personId: id }, limit: 1 });
  if (existing) await profiles.system.update(existing.id, { role, status });
  else await profiles.system.create({ personId: id, role, status });
  return await personView(id);
});
