import { boolean, email, integer, ref, table, text, timestamp, userProjection } from "spacepress";

const internal = { read: false, create: false, update: false, delete: false };

export const people = userProjection({
  name: text(),
  email: email().unique().max(191),
}, { access: { read: false } });

export const rooms = table({
  name: text().min(1).max(80),
  icon: text().max(100).default(""),
  closed: boolean().default(false),
  owner: integer(),
}, { access: internal });

export const memberships = table({
  roomId: ref(rooms).onDelete("cascade"),
  personId: integer(),
}, { access: internal }).index(["roomId", "personId"], { unique: true })
  .index(["personId"]);

export const messages = table({
  roomId: ref(rooms).onDelete("cascade"),
  authorId: integer(),
  clientId: text().max(80),
  body: text({ multiline: true }),
  createdAt: timestamp().defaultNow(),
}, { access: internal }).index(["roomId", "id"])
  .index(["roomId", "authorId", "clientId"], { unique: true });
