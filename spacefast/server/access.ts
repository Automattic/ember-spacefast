import type { QueryServerContext, ServerContext, ReadDatabaseOf, WriteDatabaseOf } from '@spacefast/zero/server';
import type { schema } from './schema';
export type Reader = QueryServerContext<ReadDatabaseOf<{schema: typeof schema}>>;
export type Writer = ServerContext<WriteDatabaseOf<{schema: typeof schema}>>;
export function clean(value: unknown, max = 200): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('Invalid text.');
  return value.trim();
}
export type SetupEligibility =
  | 'sign_in_required'
  | 'owner_not_configured'
  | 'verified_email_required'
  | 'owner_account_required'
  | 'eligible'
  | 'already_initialized';

export function setupEligibility(ctx: Reader, initialized: boolean): SetupEligibility {
  if (initialized) return 'already_initialized';
  if (!ctx.auth.isSignedIn) return 'sign_in_required';
  const principal = ctx.env.EMBER_ADMIN_PRINCIPAL;
  if (principal !== undefined) {
    if (typeof principal !== 'string' || !/^account:[A-Za-z0-9_-]+$/.test(principal)) {
      return 'owner_not_configured';
    }
    return ctx.auth.userId === principal ? 'eligible' : 'owner_account_required';
  }
  const expected = ctx.env.EMBER_ADMIN_EMAIL?.trim().toLowerCase();
  if (!expected) return 'owner_not_configured';
  const viewerEmail = ctx.auth.email?.trim().toLowerCase();
  if (ctx.auth.emailVerified !== true || !viewerEmail) return 'verified_email_required';
  return viewerEmail === expected ? 'eligible' : 'owner_account_required';
}

export function canJoinByEmailDomain(ctx: Reader): boolean {
  const { email, emailVerified, isSignedIn } = ctx.auth;
  const configuredDomains = ctx.env.EMBER_SIGNUP_EMAIL_DOMAINS;
  if (!isSignedIn || emailVerified !== true || typeof email !== 'string' || !configuredDomains) return false;

  const match = /^[^\s@]+@([a-zA-Z0-9.-]+)$/.exec(email);
  if (!match || match[0] !== email) return false;
  const domain = match[1].toLowerCase();
  const validDomain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (domain.length > 253 || !validDomain.test(domain)) return false;

  return configuredDomains.split(',').some(entry => entry.trim().toLowerCase() === domain);
}

export const setupEligibilityMessage: Record<Exclude<SetupEligibility, 'eligible'>, string> = {
  sign_in_required: 'Sign in before setting up Ember.',
  owner_not_configured: 'The workspace owner needs to configure Ember before setup can start.',
  verified_email_required: 'Verify your sign-in email before creating the workspace.',
  owner_account_required: 'Sign in with the account designated to create this workspace.',
  already_initialized: 'This workspace has already been set up.',
};

export async function identityPerson(ctx:Reader) {const auth=ctx.auth.requireSignedIn();for(const identityId of [...new Set([auth.userId,...(auth.identityAliases || [])])].slice(0,20)){const p=await ctx.db.people.withIndex('by_identity',q=>q.eq('identityId',identityId)).first();if(p)return p;}return null;}
export async function person(ctx: Reader) {
  const auth = ctx.auth.requireSignedIn();
  const me = await identityPerson(ctx);
  if (!me || me.status !== 'active') throw new Error('Workspace membership required.');
  return me;
}
export async function administrator(ctx: Reader) {
  const me = await person(ctx);
  if (me.role !== 'administrator') throw new Error('Administrator access required.');
  return me;
}
export async function accessRoom(ctx: Reader, roomId: string, expectedCreatorId?: string) {
  const me = await person(ctx);
  if (expectedCreatorId !== undefined && expectedCreatorId !== me.id) throw new Error("Message sender changed.");
  const room = await ctx.db.rooms.get(clean(roomId));
  if (!room || room.archived) throw new Error('Room unavailable.');
  const member = await ctx.db.members.withIndex('by_room_person', q => q.eq('roomId', room.id).eq('personId', me.id)).first();
  if ((room.private || room.kind === 'direct') && !member) throw new Error('Room unavailable.');
  return { me, room, member };
}
export async function account(ctx: Reader) { return ctx.db.accounts.withIndex('by_creation').first(); }
export async function audit(ctx: Writer, actorId: string, action: string, subjectId: string, details = '') {
  await ctx.db.audit.insert({ actorId, action, subjectId, details });
}
