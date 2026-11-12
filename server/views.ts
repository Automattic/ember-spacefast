import type { Reader } from './access';
import { emberRemixUrl } from './discovery';
import { assistantConfigured } from './assistants';
import { navigationIcons } from './account-navigation';
import { account, person, accessRoom, canJoinByEmailDomain, identityPerson, setupEligibility } from './access';
export const meView = (p: {id:string;name:string;role:string}) => ({id:p.id,name:p.name,administrator:p.role==='administrator'});
export async function accountView(ctx: Reader) {
 const a=await account(ctx);
 return {name:a?.name ?? 'Ember',tagline:a?.tagline ?? '',hideTranslationButtons:true,customStyles:'',restrictRoomCreation:a?.restrictRoomCreation ?? false,logo:a?.logo || null,customDomain:null,joinLink:a?.joinLink ?? true,openSignUp:a?.openSignUp ?? false,memberfulJoin:false,memberfulSignIn:false,emailDomainSignUp:false,emailDomains:[],navigationIcons:a?await navigationIcons(ctx,a.id):{},huddles:false,assistantConfigured:assistantConfigured(ctx)};
}
export async function bootstrap(ctx: Reader) {
 const a=await account(ctx);
 const p=ctx.auth.isSignedIn ? await identityPerson(ctx) : null;
 return {setup:a?'complete':'pending',setupAccess:'open',setupPlaceholders:{name:ctx.auth.displayName || '',email:ctx.auth.email || ''},guestSignIn:false,signInWithMemberful:false,turnstileSiteKey:null,passwordResetCodes:false,account:await accountView(ctx),remixUrl:emberRemixUrl(ctx.env.EMBER_REMIX_REPOSITORY),version:'spacefast-native-0.1.0',platform:{ios:false,android:false,desktop:true,windows:false,chrome:false,firefox:false,safari:false,edge:false,browser:'',operatingSystem:''},user:p?.status==='active'?meView(p):null,nativeAuth:{signedIn:ctx.auth.isSignedIn,member:Boolean(p),canJoinByEmailDomain:Boolean(a && !p && canJoinByEmailDomain(ctx)),provider:ctx.auth.provider,setupEligibility:setupEligibility(ctx,Boolean(a))}};
}
export async function roomView(ctx: Reader, room: NonNullable<Awaited<ReturnType<Reader['db']['rooms']['get']>>>) {
 if(room.kind==='direct') {
 const memberships=await ctx.db.members.withIndex('by_room',q=>q.eq('roomId',room.id)).take(50);
 const people=await Promise.all(memberships.map(m=>ctx.db.people.get(m.personId)));
 return {id:room.id,kind:'direct',members:people.filter(Boolean).map(p=>({id:p!.id,name:p!.name})),activeAt:room.updatedAt};
 }
 return {id:room.id,kind:room.private?'closed':'open',name:room.name,icon:room.icon || null};
}
type Membership = NonNullable<Awaited<ReturnType<Reader['db']['members']['get']>>>;

function favoritesView(memberships: Membership[], visibleIds: ReadonlySet<string>) {
 return {
  rooms: memberships.filter(m=>m.favorite && visibleIds.has(m.roomId)).sort((a,b)=>a.order.localeCompare(b.order)).map(m=>m.roomId),
  version: 0,
 };
}

export async function readFavorites(ctx: Reader, personId: string) {
 const memberships=await ctx.db.members.withIndex('by_person',q=>q.eq('personId',personId)).take(500);
 const starred=await Promise.all(memberships.filter(m=>m.favorite).map(m=>ctx.db.rooms.get(m.roomId)));
 return favoritesView(memberships,new Set(starred.flatMap(room=>room && !room.archived && room.kind!=='direct' ? [room.id] : [])));
}

export async function sidebar(ctx: Reader) {
 const me=await person(ctx);
 const memberships=await ctx.db.members.withIndex('by_person',q=>q.eq('personId',me.id)).take(500);
 const all=await ctx.db.rooms.withIndex('by_creation').take(500);
 const visible=all.filter(r=>!r.archived && ((!r.private && r.kind!=='direct') || memberships.some(m=>m.roomId===r.id)));
 const rooms=await Promise.all(visible.map(async r=>{const m=memberships.find(m=>m.roomId===r.id);const latest=await ctx.db.messages.withIndex('by_room',q=>q.eq('roomId',r.id)).order('desc').first();return {...await roomView(ctx,r),unread:Boolean(latest && latest.creatorId!==me.id && (!m || latest.createdAt>m.lastReadAt)),involvement:m?.involvement || (r.kind==='direct'?'everything':'mentions')};}));
 const people=await ctx.db.people.withIndex('by_creation').take(100);
 return {rooms,favorites:favoritesView(memberships,new Set(visible.filter(r=>r.kind!=='direct').map(r=>r.id))),sharedOrder:visible.filter(r=>r.kind!=='direct').sort((a,b)=>a.order.localeCompare(b.order)).map(r=>r.id),invitation:null,suggestions:people.filter(p=>p.id!==me.id && p.status==='active' && p.role!=='bot').slice(0,20).map(p=>({id:p.id,name:p.name})),huddles:{}};
}
export async function messageView(ctx: Reader, m: NonNullable<Awaited<ReturnType<Reader['db']['messages']['get']>>>) {
 const p=await ctx.db.people.get(m.creatorId);
 const parent=m.parentId?await ctx.db.messages.get(m.parentId):null;
 const reactions=await ctx.db.reactions.withIndex('by_message',q=>q.eq('messageId',m.id)).take(500);
 const boosts=await Promise.all(reactions.map(async b=>{const p=await ctx.db.people.get(b.personId);return {id:b.id,messageId:m.id,content:b.content,booster:{id:b.personId,name:p?.name || 'Former member'},createdAt:b.createdAt};}));
 const replies=m.parentId?[]:await ctx.db.messages.withIndex('by_parent',q=>q.eq('parentId',m.id)).order('desc').take(500);
 const replyCount=m.parentId?0:await ctx.db.messages.withIndex('by_parent',q=>q.eq('parentId',m.id)).count();
 const repliers=await Promise.all([...new Set(replies.map(r=>r.creatorId))].slice(0,4).map(id=>ctx.db.people.get(id)));
 return {id:m.id,clientMessageId:m.clientId,roomId:m.roomId,creator:{id:m.creatorId,name:p?.name || 'Former member'},body:m.deleted?'':m.body,plainText:m.deleted?'':m.plainText,mentions:m.mentions?JSON.parse(m.mentions):[],createdAt:m.createdAt,updatedAt:m.updatedAt,editedAt:m.editedAt || null,boosts:m.deleted?[]:boosts,...(m.parentId?{parentId:m.parentId,alsoSent:m.inRoom,parentText:parent?.deleted?'':parent?.plainText.slice(0,150) || ''}:{}),...(m.attachment && !m.deleted?{attachment:JSON.parse(m.attachment)}:{}),...(m.cards && !m.deleted?{cards:JSON.parse(m.cards)}:{}),...(replies.length?{thread:{count:replyCount,latestAt:replies[0].createdAt,people:repliers.filter(Boolean).map(p=>({id:p!.id,name:p!.name}))}}:{}),...(m.deleted?{deleted:true}:{})};
}
export async function room(ctx: Reader, roomId:string, before='') {
 const {me}=await accessRoom(ctx,roomId);
 const anchor=before?await ctx.db.messages.get(before):null;const cursor=anchor?.roomId===roomId?anchor.sentAt:before;
 const raw=await ctx.db.messages.withIndex('by_timeline',q=>cursor?q.eq('roomId',roomId).eq('inRoom',true).lt('sentAt',cursor):q.eq('roomId',roomId).eq('inRoom',true)).order('desc').take(51);
 const rows=raw.slice(0,50).reverse();
 const present=await ctx.db.presence.withIndex('by_room',q=>q.eq('roomId',roomId)).take(100);
 const active=present.filter(p=>p.seenAt>new Date(Date.now()-60000).toISOString());
 const people=await Promise.all(active.map(p=>ctx.db.people.get(p.personId)));
 return {type:'welcome',you:meView(me),present:people.filter(Boolean).map(p=>({id:p!.id,name:p!.name})),seq:Date.now(),messages:await Promise.all(rows.map(m=>messageView(ctx,m))),hasMore:raw.length>50,hasNewer:false,around:null,typing:active.filter(p=>p.typingUntil>new Date().toISOString()).map(p=>({user:{id:p.personId,name:people.find(person=>person?.id===p.personId)?.name || ''},typing:true}))};
}
export async function thread(ctx: Reader, parentId:string, before='') {
 const parent=await ctx.db.messages.get(parentId);if(!parent)throw new Error('Message unavailable.');await accessRoom(ctx,parent.roomId);
 const anchor=before?await ctx.db.messages.get(before):null;const cursor=anchor?.parentId===parentId?anchor.sentAt:before;
 const replies=await ctx.db.messages.withIndex('by_parent_time',q=>cursor?q.eq('parentId',parentId).lt('sentAt',cursor):q.eq('parentId',parentId)).order('desc').take(101);
 return {parent:await messageView(ctx,parent),messages:await Promise.all(replies.slice(0,100).reverse().map(m=>messageView(ctx,m))),hasMore:replies.length>100,hasNewer:false,around:null};
}
export async function directory(ctx:Reader) {await person(ctx);const rows=await ctx.db.people.withIndex('by_creation').take(500);return {users:rows.map(p=>({id:p.id,name:p.name,bio:p.bio || null,role:p.role,status:p.status,avatarUrl:p.avatar,...(p.identityId.startsWith("assistant:")?{agent:true}:{})}))};}
export async function roomAfter(ctx:Reader,roomId:string,afterId:string) {
 await accessRoom(ctx,roomId);const anchor=await ctx.db.messages.get(afterId);if(!anchor||anchor.roomId!==roomId)throw new Error('Message unavailable.');
 const rows=await ctx.db.messages.withIndex('by_timeline',q=>q.eq('roomId',roomId).eq('inRoom',true).gt('sentAt',anchor.sentAt)).order('asc').take(51);
 return {messages:await Promise.all(rows.slice(0,50).map(m=>messageView(ctx,m))),hasNewer:rows.length>50};
}
export async function roomAround(ctx:Reader,roomId:string,messageId?:string) {
 if(!messageId)return room(ctx,roomId);await accessRoom(ctx,roomId);let anchor=await ctx.db.messages.get(messageId);if(!anchor||anchor.roomId!==roomId)throw new Error('Message unavailable.');if(!anchor.inRoom&&anchor.parentId)anchor=await ctx.db.messages.get(anchor.parentId);if(!anchor||anchor.roomId!==roomId)throw new Error('Message unavailable.');
 const before=await ctx.db.messages.withIndex('by_timeline',q=>q.eq('roomId',roomId).eq('inRoom',true).lt('sentAt',anchor!.sentAt)).order('desc').take(26);
 const after=await ctx.db.messages.withIndex('by_timeline',q=>q.eq('roomId',roomId).eq('inRoom',true).gt('sentAt',anchor!.sentAt)).order('asc').take(26);
 return {messages:await Promise.all([...before.slice(0,25).reverse(),anchor,...after.slice(0,25)].map(m=>messageView(ctx,m))),hasMore:before.length>25,hasNewer:after.length>25,around:anchor.id};
}
