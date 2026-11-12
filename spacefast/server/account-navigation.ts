import { ROOM_ICON_NAMES } from '../shared/room-icons';
import type { Reader, Writer } from './access';

const slots = ['home', 'dms', 'activity', 'search', 'admin', 'light', 'dark', 'system'];
const allowedIcons = new Set<string>(ROOM_ICON_NAMES);

function navigationRow(ctx: Reader, accountId: string) {
  return ctx.db.accountNavigation.withIndex('by_account', q => q.eq('accountId', accountId)).first();
}

export async function navigationIcons(ctx: Reader, accountId: string): Promise<Record<string, string>> {
  const row = await navigationRow(ctx, accountId);
  return row ? JSON.parse(row.icons) : {};
}

export async function updateNavigationIcons(ctx: Writer, accountId: string, changes: unknown) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('Invalid navigation icons.');
  const row = await navigationRow(ctx, accountId);
  const icons: Record<string, string> = row ? JSON.parse(row.icons) : {};

  for (const [slot, icon] of Object.entries(changes)) {
    if (!slots.includes(slot) || typeof icon !== 'string' || (icon !== '' && !allowedIcons.has(icon))) {
      throw new Error('Invalid navigation icon.');
    }
    if (icon === '') delete icons[slot];
    else icons[slot] = icon;
  }

  const saved = JSON.stringify(icons);
  if (row) await ctx.db.accountNavigation.update(row.id, { icons: saved });
  else await ctx.db.accountNavigation.insert({ accountId, icons: saved });
}
