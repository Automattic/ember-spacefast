import { HttpError, mutation } from "spacepress";
import { memberships, messages, rooms } from "spacepress:db";
import { account, actor, admin, directory, ensureMember, membership, numericId, personView, requireRoom, roomView, visibleRooms, type RoomView } from "./access";
import { serviceIdentity } from "./service-identity";
import { assistantsEnabled, outgoingReady } from "./service-settings";

export async function favorites() {
  const allowed = await visibleRooms();
  const personId = (await actor()).wpId;
  const records = await memberships.system.list({ where: { personId, favorite: true }, orderBy: { position: "asc", id: "asc" }, limit: 500 });
  return {
    rooms: records.filter(record => allowed.some(room => room.id === record.roomId && !room.directKey)).map(record => String(record.roomId)),
    version: 0,
  };
}

export async function sidebar() {
  const user = await actor();
  const visible = await visibleRooms();
  const views: (RoomView & { unread: boolean; unreadSince?: string; involvement: string })[] = [];
  const sharedOrder: string[] = [];
  visible.sort((a, b) => a.position - b.position || a.id - b.id);
  for (const room of visible) {
    const member = await membership(room.id, user.wpId);
    const [latest] = await messages.system.list({ where: { roomId: room.id, removed: false }, orderBy: { id: "desc" }, limit: 1 });
    const lastReadId = member?.lastReadId ?? 0;
    const read = lastReadId ? await messages.system.get(lastReadId) : null;
    if (!room.directKey) sharedOrder.push(String(room.id));
    const activeAt = latest?.createdAt ?? room.updatedAt;
    const unread = Boolean(latest && latest.authorId !== user.wpId && latest.id > lastReadId);
    views.push({ ...(await roomView(room)), activeAt, unread, unreadSince: read?.createdAt, involvement: member?.involvement ?? "mentions" });
  }
  const people = await directory();
  return { rooms: views, favorites: await favorites(), sharedOrder, suggestions: people.users.filter(person => person.id !== user.id && person.status === "active").slice(0, 20), huddles: {}, invitation: null };
}

async function selectedPeople(values: string[], limit: number) {
  if (values.length > limit) throw new HttpError(422, "invalid_members", "Too many room members.");
  const ids: number[] = [];
  for (const value of values) {
    const id = numericId(value);
    if (!id || (await personView(id)).status !== "active") {
      throw new HttpError(422, "invalid_members", "Choose active people for this room.");
    }
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export const createRoom = mutation({ access: "authenticated", rateLimit: "20/hour" }, async ({ name, kind, memberIds, icon }: {
  name: string; kind: string; memberIds?: string[]; icon?: string;
}) => {
  const me = await actor();
  const workspace = await account();
  if (workspace?.restrictRoomCreation && !me.administrator) throw new HttpError(403, "room_creation", "Only administrators can create rooms.");
  const title = name.trim();
  if (!title || title.length > 80 || (kind !== "open" && kind !== "closed")) throw new HttpError(422, "invalid_room", "Invalid room details.");
  const ids = await selectedPeople([me.id, ...(memberIds ?? [])], 101);
  const room = await rooms.system.create({ name: title, icon: icon ?? "", owner: me.wpId, closed: kind === "closed" });
  for (const personId of ids) await ensureMember(room.id, personId, false);
  return await roomView(room);
});

export const startDirect = mutation({ access: "authenticated", rateLimit: "20/hour" }, async ({ userIds }: { userIds: string[] }) => {
  const me = await actor();
  const ids = await selectedPeople([...userIds, me.id], 50);
  if (!userIds.length) throw new HttpError(422, "invalid_members", "Choose a person to message.");
  for (const id of ids) {
    const service = await serviceIdentity(id);
    if (service && (ids.length !== 2 || !service.directMessages ||
        (service.kind === "assistant" ? !await assistantsEnabled() : !service.outgoingUrl || !outgoingReady()))) {
      throw new HttpError(422, "directs_unavailable", "Choose a person or a service that accepts one-to-one messages.");
    }
  }
  ids.sort((a, b) => a - b);
  const directKey = ids.join(",");
  const [existing] = await rooms.system.list({ where: { directKey, archived: false }, limit: 1 });
  if (existing) {
    const record = await membership(existing.id, me.wpId);
    if (record && record.involvement === "invisible") await memberships.system.update(record.id, { involvement: "everything" });
    return await roomView(existing);
  }
  const room = await rooms.system.create({ name: "Direct message", closed: true, owner: me.wpId, directKey });
  for (const personId of ids) await ensureMember(room.id, personId, true);
  return await roomView(room);
});

export async function roomSettings(id: number) {
  const me = await actor();
  const room = await requireRoom(id);
  const records = await memberships.system.list({ where: { roomId: id }, limit: 500 });
  const { users } = await directory();
  const active = users.filter(person => person.status === "active");
  const memberIds = room.closed ? records.map(record => String(record.personId)) : active.map(person => person.id);
  return { room: await roomView(room), users: active, memberIds, canEdit: !room.directKey && (me.administrator || room.owner === me.wpId) };
}

async function manageRoom(id: string) {
  const me = await actor();
  const room = await requireRoom(numericId(id));
  if (room.directKey || (!me.administrator && room.owner !== me.wpId)) {
    throw new HttpError(403, "manage_room", "Room management access required.");
  }
  return room;
}

export const updateRoom = mutation({ access: "authenticated" }, async (input: {
  roomId: string; name?: string; icon?: string; kind?: string; memberIds?: string[];
}) => {
  const room = await manageRoom(input.roomId);
  const name = input.name?.trim() ?? room.name;
  const kind = input.kind ?? (room.closed ? "closed" : "open");
  if (!name || name.length > 80 || (kind !== "closed" && kind !== "open")) throw new HttpError(422, "invalid_room", "Invalid room details.");
  if (kind === "closed" && (input.memberIds || !room.closed)) {
    const ids = await selectedPeople(input.memberIds ?? [], 100);
    let hasManager = ids.includes(room.owner);
    for (const id of ids) {
      if ((await personView(id)).administrator) hasManager = true;
      await ensureMember(room.id, id, false);
    }
    if (!hasManager) throw new HttpError(422, "room_manager_required", "Keep an active room manager in the room.");
    const records = await memberships.system.list({ where: { roomId: room.id }, limit: 500 });
    for (const record of records) {
      if (!ids.includes(record.personId) && (await personView(record.personId)).status === "active") {
        await memberships.system.delete(record.id);
      }
    }
  }
  const updated = await rooms.system.update(room.id, { name, icon: input.icon ?? room.icon, closed: kind === "closed" });
  return await roomView(updated);
});

export const archiveRoom = mutation({ access: "authenticated" }, async ({ id }: { id: string }) => {
  const room = await manageRoom(id);
  await rooms.system.update(room.id, { archived: true });
  return true;
});

export const leaveRoom = mutation({ access: "authenticated" }, async ({ id }: { id: string }) => {
  const me = await actor();
  const room = await requireRoom(numericId(id));
  if (room.directKey) throw new HttpError(422, "fixed_membership", "Direct message membership is fixed.");
  const record = await membership(room.id, me.wpId);
  if (record) await memberships.system.delete(record.id);
  return true;
});

export const updateMembership = mutation({ access: "authenticated" }, async (input: {
  roomId: string; favorite?: boolean; involvement?: string;
}) => {
  const me = await actor();
  const room = await requireRoom(numericId(input.roomId));
  const record = await ensureMember(room.id, me.wpId, Boolean(room.directKey));
  const involvement = input.involvement ?? record.involvement;
  if (!["mentions", "everything", "nothing", "invisible"].includes(involvement) || (room.directKey && input.favorite !== undefined)) {
    throw new HttpError(422, "invalid_membership", "Invalid room preferences.");
  }
  await memberships.system.update(record.id, { favorite: input.favorite ?? record.favorite, involvement });
  return { involvement, favorites: await favorites() };
});

export const favoriteOrder = mutation({ access: "authenticated" }, async ({ roomIds }: { roomIds: string[] }) => {
  const me = await actor();
  if (roomIds.length > 500) throw new HttpError(422, "invalid_order", "Too many rooms.");
  for (let position = 0; position < roomIds.length; position++) {
    const value = roomIds[position];
    if (!value) continue;
    const room = await requireRoom(numericId(value));
    const record = await membership(room.id, me.wpId);
    if (!record || !record.favorite) throw new HttpError(422, "invalid_order", "Only your starred rooms may be reordered.");
    await memberships.system.update(record.id, { position });
  }
  return { favorites: await favorites() };
});

export const sharedOrder = mutation({ access: "authenticated" }, async ({ roomIds }: { roomIds: string[] }) => {
  await admin();
  if (roomIds.length > 500) throw new HttpError(422, "invalid_order", "Too many rooms.");
  for (let position = 0; position < roomIds.length; position++) {
    const value = roomIds[position];
    if (!value) continue;
    const room = await requireRoom(numericId(value));
    if (room.directKey) throw new HttpError(422, "invalid_order", "Only shared rooms may be reordered.");
    await rooms.system.update(room.id, { position });
  }
  return true;
});

export const markRead = mutation({ access: "authenticated" }, async ({ id }: { id: string }) => {
  const me = await actor();
  const room = await requireRoom(numericId(id));
  const record = await ensureMember(room.id, me.wpId, Boolean(room.directKey));
  const [latest] = await messages.system.list({ where: { roomId: room.id, removed: false }, orderBy: { id: "desc" }, limit: 1 });
  await memberships.system.update(record.id, { lastReadId: latest?.id ?? 0, seenAt: Date.now() });
  return true;
});

export const typing = mutation({ access: "authenticated" }, async ({ id, on }: { id: string; on: boolean }) => {
  const me = await actor();
  const room = await requireRoom(numericId(id));
  const record = await ensureMember(room.id, me.wpId, Boolean(room.directKey));
  const now = Date.now();
  await memberships.system.update(record.id, { typingUntil: on ? now + 5000 : 0, seenAt: now });
  return true;
});
