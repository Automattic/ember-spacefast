import { HttpError, mutation, query } from "spacepress";
import { memberships, messages, people, rooms } from "spacepress:db";
import { current_user_can, esc_html, get_current_user_id, get_userdata } from "php/wordpress";

function personView(id: number) {
  const user = get_userdata(id);
  return { id: String(id), name: user ? user.display_name : "Former member" };
}

function roomView(id: number, name: string, icon: string, closed: boolean) {
  return { id: String(id), name, icon: icon || null, kind: closed ? "closed" : "open" };
}

async function requireRoom(id: number) {
  const room = await rooms.system.get(id);
  if (room && !room.closed) return room;
  if (room) {
    const members = await memberships.system.list({ where: { roomId: id, personId: get_current_user_id() }, limit: 1 });
    if (members.length) return room;
  }
  throw new HttpError(404, "room_unavailable", "Room unavailable.");
}

function messageView(id: number, roomId: number, authorId: number, clientId: string, body: string, createdAt: string) {
  return {
    id: String(id),
    roomId: String(roomId),
    clientMessageId: clientId,
    creator: personView(authorId),
    body: "<p>" + esc_html(body).replaceAll("\n", "<br>") + "</p>",
    plainText: body,
    createdAt: createdAt,
    updatedAt: createdAt,
    editedAt: null,
    boosts: [],
    mentions: [],
  };
}

export const emberRead = query({ access: "authenticated" }, async ({ operation, id, cursor }: {
  operation: string; id?: number; cursor?: number;
}) => {
  const userId = get_current_user_id();
  const me = { ...personView(userId), administrator: current_user_can("manage_options") };
  if (operation === "bootstrap") {
    return {
      setup: "complete",
      nativeAuth: { signedIn: true, member: true, canJoinByEmailDomain: false },
      user: me,
      account: { name: "Ember", tagline: "", hideTranslationButtons: true, emailDomains: [], navigationIcons: {}, huddles: false, customDomain: null, logo: null, customStyles: "", restrictRoomCreation: false },
    };
  }
  if (operation === "directory") {
    const users = await people.system.list({ orderBy: { id: "asc" }, limit: 200 });
    return { users: users.map(user => ({ ...personView(user.id), status: "active", role: "member" })) };
  }
  if (operation === "profile") {
    const user = get_userdata(userId);
    return { user: { ...me, emailAddress: user ? user.user_email : "", bio: "", timeZone: "" }, memberful: null };
  }
  if (operation === "sidebar") {
    const open = await rooms.system.list({ where: { closed: false }, limit: 200 });
    const own = await memberships.system.list({ where: { personId: userId }, limit: 200 });
    const visible = open.map(room => roomView(room.id, room.name, room.icon, room.closed));
    for (const member of own) {
      const room = await rooms.system.get(member.roomId);
      if (room && room.closed) visible.push(roomView(room.id, room.name, room.icon, room.closed));
    }
    const views = visible.map(room => ({ ...room, unread: false, involvement: "mentions" }));
    return { rooms: views, favorites: { rooms: [], version: 0 }, sharedOrder: views.map(room => room.id), suggestions: [], huddles: {}, invitation: null };
  }
  if (operation === "room" || operation === "roomAfter" || operation === "roomAround") {
    const room = await requireRoom(id ?? 0);
    const roomId = room.id;
    if (operation === "roomAfter") {
      const newer = await messages.system.list({ where: { roomId, id: { gt: cursor ?? 0 } }, orderBy: { id: "asc" }, limit: 51 });
      return { messages: newer.slice(0, 50).map(row => messageView(row.id, row.roomId, row.authorId, row.clientId, row.body, row.createdAt)), hasNewer: newer.length > 50 };
    }
    if (operation === "roomAround" && cursor) {
      const anchor = await messages.system.get(cursor);
      if (!anchor || anchor.roomId !== roomId) throw new HttpError(404, "message_unavailable", "Message unavailable.");
      const before = await messages.system.list({ where: { roomId, id: { lt: cursor } }, orderBy: { id: "desc" }, limit: 26 });
      const after = await messages.system.list({ where: { roomId, id: { gt: cursor } }, orderBy: { id: "asc" }, limit: 26 });
      const rows = [...before.slice(0, 25).reverse(), anchor, ...after.slice(0, 25)];
      return {
        messages: rows.map(row => messageView(row.id, row.roomId, row.authorId, row.clientId, row.body, row.createdAt)),
        hasMore: before.length > 25, hasNewer: after.length > 25, around: String(cursor),
      };
    }
    const rows = cursor && operation === "room"
      ? await messages.system.list({ where: { roomId, id: { lt: cursor } }, orderBy: { id: "desc" }, limit: 51 })
      : await messages.system.list({ where: { roomId }, orderBy: { id: "desc" }, limit: 51 });
    return { type: "welcome", you: me, present: [], typing: [], seq: 0, messages: rows.slice(0, 50).reverse().map(row => messageView(row.id, row.roomId, row.authorId, row.clientId, row.body, row.createdAt)), hasMore: rows.length > 50, hasNewer: false, around: null };
  }
  if (operation === "roomSettings") {
    const room = await requireRoom(id ?? 0);
    const members = await memberships.system.list({ where: { roomId: room.id }, limit: 101 });
    const memberIds = members.map(member => String(member.personId));
    const users = members.map(member => ({ ...personView(member.personId), status: "active", role: "member" }));
    return { room: roomView(room.id, room.name, room.icon, room.closed), users, memberIds, canEdit: false };
  }
  if (operation === "assistantNotice") return "";
  throw new HttpError(501, "unsupported", "This operation is not available in Ember on SpacePress.");
});

export const createRoom = mutation({ access: "authenticated" }, async ({ name, kind, memberIds, icon }: {
  name: string; kind: string; memberIds?: string[]; icon?: string;
}) => {
  const title = name.trim();
  if (!title || title.length > 80 || (kind !== "open" && kind !== "closed") || (memberIds?.length ?? 0) > 100) {
    throw new HttpError(422, "invalid_room", "Invalid room details.");
  }
  const owner = get_current_user_id();
  const room = await rooms.system.create({ name: title, icon: icon ?? "", owner, closed: kind === "closed" });
  if (room.closed) {
    await memberships.system.create({ roomId: room.id, personId: owner });
    const added: number[] = [owner];
    for (const value of memberIds ?? []) {
      const id = Number(value);
      if (Number.isInteger(id) && id > 0 && !added.includes(id) && get_userdata(id)) {
        await memberships.system.create({ roomId: room.id, personId: id });
        added.push(id);
      }
    }
  }
  return roomView(room.id, room.name, room.icon, room.closed);
});

export const sendMessage = mutation({ access: "authenticated" }, async (input: {
  roomId: string; clientMessageId: string; body: string; expectedCreatorId?: string;
}) => {
  const room = await requireRoom(Number(input.roomId));
  const authorId = get_current_user_id();
  if (input.expectedCreatorId && input.expectedCreatorId !== String(authorId)) {
    throw new HttpError(403, "sender_changed", "Message sender changed.");
  }
  if (!input.body || input.body.length > 32000 || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.clientMessageId)) {
    throw new HttpError(422, "invalid_message", "Invalid message.");
  }
  const plain = input.body.trim();
  if (!plain) throw new HttpError(422, "invalid_message", "Enter a message.");
  const key = { roomId: room.id, authorId, clientId: input.clientMessageId };
  const previous = await messages.system.list({ where: key, limit: 1 });
  const prior = previous[0];
  if (prior) {
    const row = prior;
    return messageView(row.id, row.roomId, row.authorId, row.clientId, row.body, row.createdAt);
  }
  const row = await messages.system.create({ ...key, body: plain });
  return messageView(row.id, row.roomId, row.authorId, row.clientId, row.body, row.createdAt);
});
