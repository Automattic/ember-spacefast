import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError, mail, mutation, query } from "spacepress";
import { get_current_user_id, get_userdata, home_url } from "php/wordpress";
import { invitations, profiles } from "spacepress:db";
import { account, admin, numericId, personView } from "./access";
import { canJoinByEmail } from "./workspace";

export const invitationList = query({ access: "authenticated" }, async () => {
  await admin();
  const rows = await invitations.system.list({ where: { accepted: false }, orderBy: { id: "desc" }, limit: 100 });
  return { configured: true, invitations: rows.map(row => ({ id: String(row.id), email: row.email, expiresAt: row.expiresAt })) };
});

export const invite = mutation({ access: "authenticated", rateLimit: "20/hour" }, async ({ email, token }: { email: string; token: string }) => {
  const me = await admin();
  const recipient = email.trim().toLowerCase();
  if (recipient.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient) || !/^[a-zA-Z0-9_-]{32,200}$/.test(token)) {
    throw new HttpError(422, "invalid_invitation", "Invalid invitation.");
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const [existing] = await invitations.system.list({ where: { tokenHash }, limit: 1 });
  if (existing) {
    if (existing.email !== recipient || existing.accepted || new Date(existing.expiresAt).getTime() <= Date.now()) {
      throw new HttpError(409, "invalid_invitation", "This invitation is unavailable.");
    }
    return { id: String(existing.id), email: recipient, state: "queued" };
  }
  const saved = await invitations.system.create({ email: recipient, tokenHash, expiresAt: new Date(Date.now() + 604800000).toISOString() });
  const workspace = await account();
  const name = workspace?.name ?? "Ember";
  await mail.send({
    to: recipient, subject: "Join " + name,
    text: me.name + " invited you to " + name + ".\n\nSign in with this email to accept your invitation:\n" +
      home_url("/?invite=" + encodeURIComponent(token)) + "\n\nThe invitation expires in seven days.",
  });
  return { id: String(saved.id), email: recipient, state: "queued" };
});

export const revokeInvitation = mutation({ access: "authenticated" }, async ({ id }: { id: string }) => {
  await admin();
  const row = await invitations.system.get(numericId(id));
  if (!row || row.accepted) throw new HttpError(404, "invalid_invitation", "This invitation is unavailable.");
  await invitations.system.delete(row.id);
  return true;
});

export const join = mutation({ access: "authenticated", rateLimit: "12/hour" }, async (input: {
  name?: string; joinCode?: string; invitationToken?: string; workspaceName?: string;
}) => {
  const personId = get_current_user_id();
  const user = get_userdata(personId);
  if (!user) throw new HttpError(401, "sign_in_required", "Sign in with WordPress.");
  const [profile] = await profiles.system.list({ where: { personId }, limit: 1 });
  if (profile && profile.status !== "active" && profile.status !== "pending") throw new HttpError(403, "inactive_account", "This account is inactive.");
  const workspace = await account();
  if (input.invitationToken) {
    const tokenHash = createHash("sha256").update(input.invitationToken).digest("hex");
    const [invitation] = await invitations.system.list({ where: { tokenHash }, limit: 1 });
    if (!invitation) throw new HttpError(403, "invalid_invitation", "This invitation is unavailable for your WordPress email.");
    const expiresAt = new Date(invitation.expiresAt).getTime();
    if (invitation.accepted || expiresAt <= Date.now() || invitation.email !== user.user_email.toLowerCase()) {
      throw new HttpError(403, "invalid_invitation", "This invitation is unavailable for your WordPress email.");
    }
    await invitations.system.update(invitation.id, { accepted: true });
  } else if (workspace && !workspace.openSignUp && !canJoinByEmail(user.user_email)) {
    const code = input.joinCode ?? "";
    const expected = workspace?.joinCode ?? "";
    const suppliedHash = createHash("sha256").update(code).digest("hex");
    const expectedHash = createHash("sha256").update(expected).digest("hex");
    if (!workspace?.joinLink || !expected || !timingSafeEqual(Buffer.from(suppliedHash), Buffer.from(expectedHash))) {
      throw new HttpError(403, "invalid_join_code", "Enter a valid workspace join code.");
    }
  }
  const name = input.name?.trim() || user.display_name;
  if (profile) await profiles.system.update(profile.id, { name, status: "active" });
  else await profiles.system.create({ personId, name });
  return await personView(personId);
});
