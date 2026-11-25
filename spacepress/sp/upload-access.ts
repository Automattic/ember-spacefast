import type { AccessCtx } from "spacepress";
import { attachments, profiles } from "spacepress:db";
import { workspaceMemberStatus } from "./member-status";

export async function canUploadAttachment({ user }: AccessCtx) {
  if (!user) return false;
  const personId = user.id;
  const [profile] = await profiles.system.list({ where: { personId }, limit: 1 });
  const role = profile?.role || (user.role === "admin" ? "administrator" : "member");
  if (await workspaceMemberStatus(personId, role, profile?.status) !== "active") return false;
  const since = new Date(Date.now() - 3600000).toISOString();
  const [reservation] = await attachments.system.list({
    where: { personId, status: "uploading", createdAt: { gt: since } }, limit: 1,
  });
  return Boolean(reservation);
}
