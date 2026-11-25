import { boolean, email, files, integer, ref, table, text, timestamp, userProjection } from "spacepress";
import { canUploadAttachment } from "./upload-access";

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
  directKey: text().max(900).default(""),
  archived: boolean().default(false),
  position: integer().default(0),
}, { access: internal }).index(["closed", "archived"]);

export const memberships = table({
  roomId: ref(rooms).onDelete("cascade"),
  personId: integer(),
  lastReadId: integer().default(0),
  involvement: text().max(20).default("mentions"),
  favorite: boolean().default(false),
  position: integer().default(0),
  seenAt: integer().default(0),
  typingUntil: integer().default(0),
}, { access: internal }).index(["roomId", "personId"], { unique: true })
  .index(["personId"]);

export const messages = table({
  roomId: ref(rooms).onDelete("cascade"),
  authorId: integer(),
  clientId: text().max(80),
  body: text({ multiline: true }),
  markup: text({ multiline: true }).default(""),
  parentId: integer().default(0),
  inRoom: boolean().default(true),
  removed: boolean().default(false),
  editedAt: text().max(24).default(""),
  attachmentId: integer().default(0),
  cards: text({ multiline: true }).default(""),
  searchIndexed: boolean().default(false),
  createdAt: timestamp().defaultNow(),
}, { access: internal }).index(["roomId", "id"])
  .index(["roomId", "authorId", "clientId"], { unique: true })
  .index(["roomId", "inRoom", "id"]).index(["parentId", "id"])
  .index(["authorId", "clientId"]).index(["searchIndexed", "id"]);

export const searchTokens = table({
  token: text().max(100),
  roomId: ref(rooms).onDelete("cascade"),
  messageId: ref(messages).onDelete("cascade"),
}, { access: internal }).index(["token", "messageId"]).index(["messageId"]);

export const rateCounters = table({
  key: text().max(100).unique(),
  window: integer(),
  count: integer(),
}, { access: internal });

export const auditEvents = table({
  actorId: integer(),
  action: text().max(40),
  subjectId: integer(),
  details: text().default(""),
}, { access: internal }).index(["subjectId"]);

export const linkPreviews = table({
  key: text().max(64).unique(),
  title: text().max(160),
  description: text().max(280),
  expiresAt: integer(),
}, { access: internal }).index(["expiresAt"]);

export const reactions = table({
  messageId: ref(messages).onDelete("cascade"),
  personId: integer(),
  content: text().max(100),
}, { access: internal }).index(["messageId", "personId", "content"], { unique: true });

export const profiles = table({
  personId: integer().unique(),
  name: text().max(80).default(""),
  bio: text({ multiline: true }).default(""),
  avatar: text().max(2000).default(""),
  timeZone: text().max(100).default(""),
  role: text().max(30).default(""),
  status: text().max(30).default("active"),
}, { access: internal });

export const workspaces = table({
  singleton: integer().unique(),
  name: text().max(80).default("Ember"),
  tagline: text().max(200).default(""),
  logo: text().default(""),
  restrictRoomCreation: boolean().default(false),
  openSignUp: boolean().default(false),
  joinLink: boolean().default(false),
  joinCode: text().max(80).default(""),
  navigationIcons: text().default("{}"),
  assistantsEnabled: boolean().default(false),
}, { access: internal });

export const recentSearches = table({
  personId: integer(),
  query: text(),
}, { access: internal }).index(["personId", "id"]);

export const attachmentChunks = files({
  accept: ["application/octet-stream", "text/plain"],
  maxBytes: 4194320,
  access: { create: canUploadAttachment, read: "owner", delete: "owner" },
});

export const attachments = table({
  roomId: ref(rooms).onDelete("cascade"),
  personId: integer(),
  name: text().max(255),
  type: text().max(200),
  size: integer(),
  status: text().max(20).default("uploading"),
  manifest: text({ multiline: true }).default(""),
}, { access: internal });

export const attachmentDevices = table({
  personId: integer(),
  deviceId: text().max(32).unique(),
  publicKey: text().max(130),
  active: boolean().default(true),
}, { access: internal }).index(["personId", "active"]);

export const invitations = table({
  email: text().max(254),
  tokenHash: text().max(64).unique(),
  expiresAt: timestamp(),
  accepted: boolean().default(false),
  domainVerification: boolean().default(false),
}, { access: internal }).index(["accepted", "id"]);

export const serviceActors = table({
  name: text().max(80),
  handle: text().max(32).default(""),
  kind: text().max(20),
  roomIds: text().default("[]"),
  enabled: boolean().default(false),
  secretHash: text().max(64).default(""),
  outgoingUrl: text().default(""),
  directMessages: boolean().default(false),
  instructions: text({ multiline: true }).default(""),
  includeThreadRoot: boolean().default(false),
  version: text().max(64).default(""),
}, { access: internal }).index(["kind", "handle"]);

export const serviceDeliveries = table({
  actorId: ref(serviceActors).onDelete("cascade"),
  messageId: ref(messages).onDelete("cascade"),
  actorVersion: text().max(64),
  sourceUpdatedAt: text().max(24),
  status: text().max(20).default("queued"),
  replyHash: text().max(64).default(""),
  responseId: text().max(126).default(""),
}, { access: internal }).index(["actorId", "messageId"], { unique: true }).index(["responseId"]);

export const pushSubscriptions = table({
  personId: integer(),
  endpoint: text(),
  endpointHash: text().max(64).unique(),
  publicKey: text().max(87),
}, { access: internal }).index(["personId", "id"]);
