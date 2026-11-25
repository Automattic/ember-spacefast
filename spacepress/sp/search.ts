import { HttpError, mutation, query } from "spacepress";
import { messages, recentSearches, searchTokens } from "spacepress:db";
import { actor, numericId, visibleRooms } from "./access";
import { messageView, type MessageView } from "./messages";
import { words } from "./search-index";

function enabled(value?: boolean | string) {
  return value === true || value === "true" || value === "1";
}

export const emberSearch = query({ access: "authenticated" }, async (input: {
  q?: string; query?: string; roomId?: string; from?: string; cursor?: string; sort?: string;
  hasLink?: boolean | string; hasFile?: boolean | string; withMe?: boolean | string; inThread?: boolean | string;
}) => {
  const me = await actor();
  const value = (input.query || input.q || "").trim();
  if (value.length > 1000) throw new HttpError(422, "invalid_search", "Search is too long.");
  const tokens = words(value);
  const matches: MessageView[] = [];
  const visible = (await visibleRooms()).filter(room => !input.roomId || room.id === numericId(input.roomId));
  const ids = visible.map(room => room.id);
  if (!ids.length) return { messages: matches, cursor: null };
  const cursor = input.cursor ? numericId(input.cursor) : 0;
  const descending = input.sort !== "oldest";
  const token = tokens[0];
  const upper = cursor || 9007199254740991;
  const unindexed = token
    ? descending
      ? await messages.system.list({ where: { roomId: { in: ids }, removed: false, searchIndexed: false, id: { lt: upper } }, orderBy: { id: "desc" }, limit: 201 })
      : await messages.system.list({ where: { roomId: { in: ids }, removed: false, searchIndexed: false, id: { gt: cursor } }, orderBy: { id: "asc" }, limit: 201 })
    : descending
      ? await messages.system.list({ where: { roomId: { in: ids }, removed: false, id: { lt: upper } }, orderBy: { id: "desc" }, limit: 201 })
      : await messages.system.list({ where: { roomId: { in: ids }, removed: false, id: { gt: cursor } }, orderBy: { id: "asc" }, limit: 201 });
  const candidates = unindexed.map(row => row.id);
  if (token) {
    const hits = descending
      ? await searchTokens.system.list({ where: { token, roomId: { in: ids }, messageId: { lt: upper } }, orderBy: { messageId: "desc" }, limit: 201 })
      : await searchTokens.system.list({ where: { token, roomId: { in: ids }, messageId: { gt: cursor } }, orderBy: { messageId: "asc" }, limit: 201 });
    for (const hit of hits) candidates.push(hit.messageId);
    candidates.sort((a, b) => descending ? b - a : a - b);
  }
  const page = candidates.slice(0, 201);
  let last = 0;
  let scanned = 0;
  for (const id of page) {
    last = id;
    scanned++;
    const row = await messages.system.get(id);
    if (!row || row.removed) continue;
    if (input.from && row.authorId !== numericId(input.from)) continue;
    if (enabled(input.hasFile) && !row.attachmentId) continue;
    const body = words(row.body);
    if (!tokens.every(token => body.includes(token))) continue;
    if (enabled(input.hasLink) && !row.markup.includes("https://") && !row.markup.includes("http://") && !row.body.includes("https://") && !row.body.includes("http://")) continue;
    const parentId = row.parentId || row.id;
    if (enabled(input.inThread) && !row.parentId && !await messages.system.count({ where: { parentId, removed: false } })) continue;
    const view = await messageView(row);
    if (enabled(input.withMe) && !visible.some(room => room.id === row.roomId && Boolean(room.directKey)) && !view.mentions.some(person => person.id === me.id)) {
      const parent = await messages.system.get(parentId);
      const mine = await messages.system.count({ where: { parentId, authorId: me.wpId, removed: false } });
      if (!mine) {
        if (parent?.authorId !== me.wpId) continue;
        if (!await messages.system.count({ where: { parentId, removed: false } })) continue;
      }
    }
    matches.push(view);
    if (matches.length === 50) break;
  }
  return { messages: matches, cursor: (page.length === 201 || scanned < page.length) ? String(last) : null };
});

export async function recent() {
  const personId = (await actor()).wpId;
  return await recentSearches.system.list({ where: { personId }, orderBy: { id: "desc" }, limit: 20 });
}

export const rememberSearch = mutation({ access: "authenticated" }, async ({ query: value }: { query: string }) => {
  const personId = (await actor()).wpId;
  if (value.length > 1000) throw new HttpError(422, "invalid_search", "Search is too long.");
  const saved = await recent();
  for (const row of saved) {
    if (row.query === value) await recentSearches.system.delete(row.id);
  }
  await recentSearches.system.create({ personId, query: value });
  if (saved.length >= 20) {
    const last = saved[19];
    if (last && last.query !== value) await recentSearches.system.delete(last.id);
  }
  return true;
});

export const clearSearches = mutation({ access: "authenticated" }, async () => {
  const saved = await recent();
  for (const row of saved) await recentSearches.system.delete(row.id);
  return true;
});
