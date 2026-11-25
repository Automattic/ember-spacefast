import { cron } from "spacepress";
import { messages, searchTokens } from "spacepress:db";

export function words(text: string) {
  const tokens = text.toLowerCase().split(/[\s.,!?;:()\[\]{}<>"'\/\\|@#$%^&*+=~`]+/);
  const unique: string[] = [];
  for (const word of tokens) {
    if (word && word.length <= 100 && !unique.includes(word)) unique.push(word);
  }
  return unique;
}

export async function indexMessage(messageId: number, roomId: number, body: string, replace: boolean = false) {
  if (replace) {
    for (let run = 0; run < 100; run++) {
      const prior = await searchTokens.system.list({ where: { messageId }, limit: 250 });
      for (const term of prior) await searchTokens.system.delete(term.id);
      if (prior.length < 250) break;
    }
  }
  for (const token of words(body)) await searchTokens.system.create({ token, roomId, messageId });
}

export const backfillSearch = cron("* * * * *", async () => {
  const rows = await messages.system.list({ where: { searchIndexed: false }, orderBy: { id: "asc" }, limit: 50 });
  for (const row of rows) {
    if (!row.removed) await indexMessage(row.id, row.roomId, row.body);
    await messages.system.update(row.id, { searchIndexed: true });
  }
});
