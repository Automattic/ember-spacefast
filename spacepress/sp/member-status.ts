import { memberships, profiles } from "spacepress:db";

export async function workspaceMemberStatus(personId: number, role: string, recorded?: string) {
  if (recorded) return recorded;
  if (role === "administrator") return "active";
  const [prior] = await memberships.system.list({ where: { personId }, limit: 1 });
  return prior ? "active" : "pending";
}

export async function preserveWorkspaceMembership(personId: number) {
  const [profile] = await profiles.system.list({ where: { personId }, limit: 1 });
  if (!profile) await profiles.system.create({ personId, status: "active" });
}
