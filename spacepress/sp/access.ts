import { HttpError, type InferSelectModel } from "spacepress";
import { get_current_user_id, get_userdata } from "php/wordpress";
import { memberships, people, profiles, rooms, serviceActors, workspaces } from "spacepress:db";
import { rooms as roomSchema } from "./schema";
import { serviceIdentity, serviceOffset } from "./service-identity";

export type Room = InferSelectModel<typeof roomSchema>;

export function numericId(value: string) {
  const id = Number(value);
  return Number.isInteger(id) && id <= 9007199254740991 && id > 0 ? id : 0;
}

export type Person = {
  id: string; name: string; administrator: boolean; role: string; status: string;
  bio: string; avatarUrl: string | null; timeZone: string; agent?: boolean;
};

export async function personView(id: number): Promise<Person> {
  if (id > serviceOffset) {
    const service = await serviceIdentity(id);
    const enabled = service?.enabled && (service?.kind !== "assistant" || Boolean((await account())?.assistantsEnabled));
    return {
      id: String(id), name: service?.name ?? "Former member", administrator: false, role: "bot",
      status: enabled ? "active" : "deactivated", bio: "", avatarUrl: null,
      timeZone: "", agent: service?.kind === "assistant",
    };
  }
  const [profile] = await profiles.system.list({ where: { personId: id }, limit: 1 });
  const user = get_userdata(id);
  const role = profile?.role || (user && user.roles.includes("administrator") ? "administrator" : "member");
  let status = "deactivated";
  if (user) {
    status = profile?.status ?? "active";
    if (!profile && role !== "administrator") {
      const workspace = await account();
      const registered = user.user_registered.replace(" ", "T") + ".000Z";
      if (workspace && registered >= workspace.createdAt) status = "pending";
    }
  }
  return {
    id: String(id),
    name: profile?.name || (user ? user.display_name : "Former member"),
    administrator: role === "administrator",
    role,
    status,
    bio: profile?.bio ?? "",
    avatarUrl: profile?.avatar || null,
    timeZone: profile?.timeZone ?? "",
  };
}

export async function actor() {
  const id = get_current_user_id();
  if (!id) throw new HttpError(401, "sign_in_required", "Sign in to Ember.");
  const user = await personView(id);
  if (user.status !== "active") throw new HttpError(403, "membership_required", "Active workspace membership required.");
  return { ...user, wpId: id };
}

export async function admin() {
  const user = await actor();
  if (!user.administrator) throw new HttpError(403, "administrator_required", "Administrator access required.");
  return user;
}

export async function account() {
  const [record] = await workspaces.system.list({ where: { singleton: 1 }, limit: 1 });
  return record;
}

export async function membership(roomId: number, personId: number) {
  const [record] = await memberships.system.list({ where: { roomId, personId }, limit: 1 });
  return record;
}

export async function requireRoom(id: number) {
  const user = await actor();
  const room = await rooms.system.get(id);
  if (room && !room.archived) {
    if (!room.closed || await membership(id, user.wpId)) return room;
  }
  throw new HttpError(404, "room_unavailable", "Room unavailable.");
}

export async function ensureMember(roomId: number, personId: number, direct: boolean) {
  const record = await membership(roomId, personId);
  if (record) return record;
  return await memberships.system.create({ roomId, personId, involvement: direct ? "everything" : "mentions" });
}

export async function directory() {
  const users = await peopleInWordPress();
  const views: Person[] = [];
  for (const id of users) views.push(await personView(id));
  const services = await serviceActors.system.list({ limit: 100 });
  for (const service of services) views.push(await personView(serviceOffset + service.id));
  return { users: views };
}

async function peopleInWordPress() {
  const users = await people.system.list({ orderBy: { id: "asc" }, limit: 500 });
  return users.map(user => user.id);
}

export async function visibleRooms() {
  const user = await actor();
  const publicRooms = await rooms.system.list({ where: { archived: false, closed: false }, limit: 500 });
  const own = await memberships.system.list({ where: { personId: user.wpId }, limit: 500 });
  for (const record of own) {
    const room = await rooms.system.get(record.roomId);
    if (room && room.closed && !room.archived) publicRooms.push(room);
  }
  return publicRooms;
}

export type RoomView = {
  id: string; kind: string; name: string; icon: string | null; activeAt: string;
  members: { id: string; name: string }[];
};

export async function roomView(room: Room): Promise<RoomView> {
  const members: { id: string; name: string }[] = [];
  if (room.directKey) {
    const records = await memberships.system.list({ where: { roomId: room.id }, limit: 50 });
    for (const record of records) {
      const person = await personView(record.personId);
      members.push({ id: person.id, name: person.name });
    }
  }
  return {
    id: String(room.id), kind: room.directKey ? "direct" : room.closed ? "closed" : "open",
    members, name: room.name, icon: room.icon || null, activeAt: room.updatedAt,
  };
}
