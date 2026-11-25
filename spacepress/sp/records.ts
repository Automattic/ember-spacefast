import { HttpError } from "spacepress";
import { auditEvents, rateCounters } from "spacepress:db";

export async function consumeRate(key: string, limit: number, period: number, cost: number = 1) {
  const window = Math.floor(Date.now() / period);
  const [row] = await rateCounters.system.list({ where: { key }, limit: 1 });
  const count = (row?.window === window ? row?.count ?? 0 : 0) + cost;
  if (count > limit) throw new HttpError(429, "rate_limit", "Too many requests. Please try again later.");
  if (row) await rateCounters.system.update(row.id, { window, count });
  else await rateCounters.system.create({ key, window, count });
}

export async function audit(actorId: number, action: string, subjectId: number, details: string = "") {
  await auditEvents.system.create({ actorId, action, subjectId, details });
}
