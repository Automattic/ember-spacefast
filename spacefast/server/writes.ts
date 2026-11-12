import { messageTimeKey } from './message-order';
import { directAssistantAllowed, enqueueAssistant, pendingAssistant } from './assistants';
import {consumeRate} from './rate';
import {protectedRoom} from './attachment-devices';
import { directBotAllowed, enqueueBotDeliveries } from './bot-delivery';
import { updateNavigationIcons } from './account-navigation';
import { enqueuePush, pendingPush, revokeMemberPush } from './push';
import { indexMessage, removeIndex, words } from './search';
import { sanitizeBody, userIdsIn } from './richtext';
import type { Writer } from './access';
import { accessRoom, account, administrator, audit, canJoinByEmailDomain, clean, person, identityPerson, setupEligibility, setupEligibilityMessage } from './access';
import { accountView, meView, messageView, readFavorites, roomView } from './views';

async function prepareMessage(ctx:Writer,value:unknown) {if(typeof value!=='string')throw new Error('Invalid message.');const ids=userIdsIn(value);const people=await Promise.all(ids.slice(0,100).map((id:string)=>ctx.db.people.get(id)));return sanitizeBody(value,id=>{const p=people.find(p=>p?.id===id);return p?.status==='active'?{id:p.id,name:p.name}:undefined;});}
async function member(ctx:Writer, roomId:string, personId:string) {const existing=await ctx.db.members.withIndex('by_room_person',q=>q.eq('roomId',roomId).eq('personId',personId)).first();return existing || ctx.db.members.insert({roomId,personId,lastReadAt:'',involvement:'mentions',favorite:false,order:''});}
export async function setup(ctx: Writer, input: {
  name?: string;
  communityName?: string;
  workspaceName?: string;
  tagline?: string;
  joinCode?: string;
}) {
  let stage = 'owner_check';
  try {
    const eligibility = setupEligibility(ctx, Boolean(await account(ctx)));
    if (eligibility !== 'eligible') {
      return {ok: false as const, errorCode: eligibility, message: setupEligibilityMessage[eligibility]};
    }
    const auth = ctx.auth.requireSignedIn();
    stage = 'validate_input';
    const name = clean(input.communityName || input.workspaceName || 'Ember', 80);
    if (!name) throw new Error('Community name required.');
    const ownerName = clean(input.name || auth.displayName, 80);
    const tagline = clean(input.tagline || '', 200);
    const joinCode = input.joinCode ? clean(input.joinCode, 200) : '';
    stage = 'hash_join_code';
    const joinCodeHash = joinCode ? await ctx.crypto.sha256(joinCode) : '';

    stage = 'insert_owner';
    const me = await ctx.db.people.insert({
      identityId: auth.userId, name: ownerName, email: auth.email || '',
      role: 'administrator', status: 'active', avatar: auth.picture || '', bio: '', timeZone: '',
    });
    stage = 'insert_workspace';
    await ctx.db.accounts.insert({
      name, tagline, ownerId: me.id, joinCodeHash, joinCode,
      joinLink: true, openSignUp: false, restrictRoomCreation: false, customStyles: '', logo: '',
    });
    stage = 'insert_room';
    const room = await ctx.db.rooms.insert({
      name: 'general', description: '', kind: 'open', private: false,
      creatorId: me.id, icon: '', archived: false, order: '0',
    });
    stage = 'insert_membership';
    await member(ctx, room.id, me.id);
    stage = 'record_audit';
    await audit(ctx, me.id, 'workspace.setup', me.id);
    stage = 'build_result';
    ctx.invalidate('bootstrap', 'sidebar', 'directory');
    return {user: meView(me), account: await accountView(ctx), room: await roomView(ctx, room)};
  } catch (error) {
    try {
      ctx.log.error('Ember workspace setup failed', {stage});
    } catch {
      // Keep the original transaction error even if runtime logging is unavailable.
    }
    throw error;
  }
}
export async function join(ctx: Writer, input: { name?: string; joinCode?: string; invitationToken?: string }) {
 const auth = ctx.auth.requireSignedIn();
 const workspace = await account(ctx);
 if (!workspace) throw new Error('Workspace not set up.');

 const existing = await identityPerson(ctx);
 if (existing) {
   if (existing.status !== 'active') return joinRefused('Your workspace access is inactive. Contact an administrator to restore access.');
   if (input.invitationToken) return joinRefused('This account already has workspace access.');
   return meView(existing);
 }

 let invitation = null;
 if (input.invitationToken !== undefined) {
   if (typeof input.invitationToken !== 'string' || !/^[a-zA-Z0-9_-]{32,200}$/.test(input.invitationToken)) {
     return joinRefused('This invitation is unavailable. Ask a workspace administrator for a new one.');
   }
   const hash = await ctx.crypto.sha256(input.invitationToken);
   invitation = await ctx.db.invitations.withIndex('by_token', q => q.eq('tokenHash', hash)).first();
   if (!invitation || invitation.acceptedBy) {
     return joinRefused('This invitation is unavailable. Ask a workspace administrator for a new one.');
   }
   if (invitation.expiresAt <= new Date().toISOString()) {
     return joinRefused('This invitation expired. Ask a workspace administrator for a new one.');
   }
   if (auth.emailVerified !== true || invitation.email.toLowerCase() !== auth.email?.toLowerCase()) {
     return joinRefused('Switch to the account with the verified email address that received the invitation.');
   }
 }

 if (!invitation && !workspace.openSignUp && !canJoinByEmailDomain(ctx)) {
   if (workspace.joinLink === false || !workspace.joinCodeHash || !input.joinCode ||
       !await ctx.crypto.timingSafeEqual(workspace.joinCodeHash, await ctx.crypto.sha256(clean(input.joinCode, 200)))) {
     return joinRefused('Enter a valid join code or ask a workspace administrator for an invitation.');
   }
 }

 const name = clean(input.name || auth.displayName, 80);
 if (!name) return joinRefused('Enter your name to join the workspace.');
 const member = await ctx.db.people.insert({
   identityId: auth.userId, name, email: auth.email || '', role: 'member', status: 'active',
   avatar: auth.picture || '', bio: '', timeZone: '',
 });
 if (invitation) await ctx.db.invitations.update(invitation.id, { acceptedBy: member.id });
 ctx.invalidate('bootstrap', 'directory', 'sidebar', 'invitations');
 return meView(member);
}

function joinRefused(message: string) {
 return { ok: false as const, message };
}
export async function createRoom(ctx:Writer,input:{name:string;kind?:string;memberIds?:string[];icon?:string}) {
 if(!input || typeof input!=='object' || !['open','closed',undefined].includes(input.kind) || (input.memberIds!==undefined && (!Array.isArray(input.memberIds)||input.memberIds.length>100)))throw new Error('Invalid room details.');
 const me=await person(ctx);const a=await account(ctx);if(a?.restrictRoomCreation && me.role!=='administrator')throw new Error('Administrator access required.');
 await consumeRate(ctx,me.id,'rooms',20,3600000);const name=clean(input.name,80);if(!name)throw new Error('Room name required.');const isPrivate=input.kind==='closed';
 const room=await ctx.db.rooms.insert({name,description:'',kind:isPrivate?'closed':'open',private:isPrivate,creatorId:me.id,icon:clean(input.icon || '',100),archived:false,order:''});await member(ctx,room.id,me.id);
 for(const id of [...new Set(input.memberIds || [])].slice(0,100)){const p=await ctx.db.people.get(id);if(p?.status==='active')await member(ctx,room.id,p.id);}
 ctx.invalidate('sidebar');return roomView(ctx,room);
}
export async function startDirect(ctx:Writer,ids:string[]) {
 const me=await person(ctx);if(!Array.isArray(ids) || ids.length<1 || ids.length>49)throw new Error('Choose 1 to 49 people.');const wanted=[...new Set([...ids,me.id])].sort();
 for(const id of wanted){const p=await ctx.db.people.get(clean(id));if(!p || p.status!=='active' || (p.role==='bot' && (wanted.length!==2 || (!await directBotAllowed(ctx,p.id) && !await directAssistantAllowed(ctx,p.id)))))throw new Error('Choose an active person or a bot that accepts one-to-one direct messages.');}
 const my=await ctx.db.members.withIndex('by_person',q=>q.eq('personId',me.id)).take(500);
 for(const m of my){const r=await ctx.db.rooms.get(m.roomId);if(r?.kind==='direct'&&!r.archived){const members=await ctx.db.members.withIndex('by_room',q=>q.eq('roomId',r.id)).take(50);if(members.map(m=>m.personId).sort().join(',')===wanted.join(',')){
   if(m.involvement==='invisible'){await ctx.db.members.update(m.id,{involvement:'everything'});ctx.invalidate('sidebar');}
   return roomView(ctx,r);
 }}}
 const room=await ctx.db.rooms.insert({name:'',description:'',kind:'direct',private:true,creatorId:me.id,icon:'',archived:false,order:''});for(const id of wanted)await member(ctx,room.id,id);ctx.invalidate('sidebar');return roomView(ctx,room);
}
export interface MessageInput {roomId:string;clientMessageId:string;body:string;parentId?:string;alsoSent?:boolean;fileId?:string;expectedCreatorId?:string}
export function sendMessage(ctx: Writer, input: MessageInput) {
 return writeMessage(ctx, input, false);
}
export function sendCommittedAttachment(ctx: Writer, input: MessageInput & {fileId: string}) {
 return writeMessage(ctx, input, true);
}
async function writeMessage(ctx: Writer, input: MessageInput, committingFile: boolean) {
 const {me,room}=await accessRoom(ctx,input.roomId,input.expectedCreatorId);if(room.archived)throw new Error('Room archived.');
 const clientId=clean(input.clientMessageId,150);if(!clientId)throw new Error('Message identifier required.');const existing=await ctx.db.messages.withIndex('by_client',q=>q.eq('creatorId',me.id).eq('clientId',clientId)).first();if(existing){if(existing.roomId!==room.id || (committingFile && (!existing.attachment || JSON.parse(existing.attachment).id!==input.fileId)))throw new Error('Message identifier already used.');const queued=await ctx.db.botDeliveries.withIndex('by_message_due',q=>q.eq('messageId',existing.id).eq('status','queued').lte('dueAt',new Date().toISOString())).take(3);return {...await messageView(ctx,existing),botDeliveryCount:queued.length,pushDeliveryCount:await pendingPush(ctx,existing.id),assistantPending:await pendingAssistant(ctx,existing.id)};}
 await consumeRate(ctx,me.id,'messages',60,60000);
 const {body,plainText,mentions}=await prepareMessage(ctx,input.body);if(!plainText && !input.fileId)throw new Error('Write a message.');if(plainText.length>20000)throw new Error('Message too long.');await consumeRate(ctx,me.id,'indexed-words',12000,60000,Math.max(1,words(plainText).length));
 let parentId='';if(input.parentId){const p=await ctx.db.messages.get(clean(input.parentId));if(!p || p.roomId!==room.id || p.parentId)throw new Error('Thread unavailable.');parentId=p.id;}
 let attachment = '';
 if (input.fileId) {
  const file = await ctx.db.files.get(clean(input.fileId));
  if (!file || file.roomId !== room.id || file.creatorId !== me.id || file.status !== 'ready') throw new Error('File unavailable.');
  const manifest = JSON.parse(file.parts);
  const summary = {id: file.id, name: file.name, type: file.type, size: Number(file.size)};
  if (committingFile && manifest.version === 2) {
   const picture = manifest.picture && {width: manifest.picture.width, height: manifest.picture.height, thumbnail: Boolean(manifest.picture.thumbnail)};
   attachment = JSON.stringify({...summary, version: 2, workspaceId: manifest.workspaceId, roomId: room.id, senderId: me.id, ...(picture && {picture})});
  } else {
   if (protectedRoom(room) || manifest.version !== 1) throw new Error('Encrypted attachments must be posted with a message.');
   attachment = JSON.stringify({...summary, manifest});
  }
 }
 let m=await ctx.db.messages.insert({roomId:room.id,creatorId:me.id,clientId,sentAt:new Date().toISOString(),body,plainText,mentions:JSON.stringify(mentions),parentId,inRoom:!parentId || input.alsoSent===true,deleted:false,editedAt:'',attachment,cards:''});await ctx.db.messages.update(m.id,{sentAt:messageTimeKey(m.sentAt, m.id)});m=(await ctx.db.messages.get(m.id))!;await member(ctx,room.id,me.id);await indexMessage(ctx,m);const botDeliveryCount=await enqueueBotDeliveries(ctx,room,m,mentions);const pushDeliveryCount=await enqueuePush(ctx,room,m);const assistantPending=await enqueueAssistant(ctx,room,m,me.role);ctx.invalidate('room','thread','sidebar','search');return {...await messageView(ctx,m),botDeliveryCount,pushDeliveryCount,assistantPending};
}
export async function editMessage(ctx:Writer,input:{messageId:string;body:string}) {
 const m=await ctx.db.messages.get(clean(input.messageId));if(!m)throw new Error('Message unavailable.');const {me}=await accessRoom(ctx,m.roomId);if(m.creatorId!==me.id || m.deleted)throw new Error('You may only edit your messages.');const {body,plainText,mentions}=await prepareMessage(ctx,input.body);if(!plainText || plainText.length>20000)throw new Error('Invalid message.');await consumeRate(ctx,me.id,'edits',60,60000);await consumeRate(ctx,me.id,'indexed-words',12000,60000,Math.max(1,words(plainText).length));await ctx.db.messages.update(m.id,{body,plainText,mentions:JSON.stringify(mentions),editedAt:new Date().toISOString()});await indexMessage(ctx,{...m,plainText});ctx.invalidate('room','thread','search');return messageView(ctx,(await ctx.db.messages.get(m.id))!);
}
export async function deleteMessage(ctx:Writer,id:string) {
 const m=await ctx.db.messages.get(clean(id));if(!m)throw new Error('Message unavailable.');const {me}=await accessRoom(ctx,m.roomId);if(m.creatorId!==me.id && me.role!=='administrator')throw new Error('You may only delete your messages.');if(m.attachment){const attached=JSON.parse(m.attachment);const file=await ctx.db.files.get(attached.id);if(file?.roomId===m.roomId)await ctx.db.files.update(file.id,{status:'deleted',parts:'',key:''});}await removeIndex(ctx,m.id);await ctx.db.messages.update(m.id,{deleted:true,body:'',plainText:'',mentions:'[]',attachment:'',cards:''});const reactions=await ctx.db.reactions.withIndex('by_message',q=>q.eq('messageId',m.id)).take(500);for(const r of reactions)await ctx.db.reactions.delete(r.id);await audit(ctx,me.id,'message.delete',m.id);ctx.invalidate('room','thread','search','sidebar');return {messageId:m.id};
}
export async function react(ctx:Writer,input:{messageId:string;content:string}) {const m=await ctx.db.messages.get(clean(input.messageId));if(!m || m.deleted)throw new Error('Message unavailable.');const {me}=await accessRoom(ctx,m.roomId);const content=clean(input.content,100);if(!content)throw new Error('Reaction required.');await consumeRate(ctx,me.id,'reactions',120,60000);const all=await ctx.db.reactions.withIndex('by_message',q=>q.eq('messageId',m.id)).take(500);const existing=all.find(r=>r.personId===me.id && r.content===content);if(existing)return existing;ctx.invalidate('room','thread');return ctx.db.reactions.insert({messageId:m.id,personId:me.id,content});}
export async function unreact(ctx:Writer,id:string) {const r=await ctx.db.reactions.get(clean(id));if(!r)throw new Error('Reaction unavailable.');const me=await person(ctx);if(r.personId!==me.id)throw new Error('You may only remove your reactions.');const m=await ctx.db.messages.get(r.messageId);if(!m)throw new Error('Message unavailable.');await accessRoom(ctx,m.roomId);await ctx.db.reactions.delete(r.id);ctx.invalidate('room','thread');return {boostId:r.id};}
export async function markRead(ctx:Writer,roomId:string) {const {me}=await accessRoom(ctx,roomId);const m=await member(ctx,roomId,me.id);await ctx.db.members.update(m.id,{lastReadAt:new Date().toISOString()});const presence=await ctx.db.presence.withIndex('by_room_person',q=>q.eq('roomId',roomId).eq('personId',me.id)).first();if(presence)await ctx.db.presence.update(presence.id,{seenAt:new Date().toISOString()});else await ctx.db.presence.insert({roomId,personId:me.id,seenAt:new Date().toISOString(),typingUntil:''});ctx.invalidate('sidebar','room');return true;}
export async function typing(ctx:Writer,roomId:string,on:boolean) {const {me}=await accessRoom(ctx,roomId);const p=await ctx.db.presence.withIndex('by_room_person',q=>q.eq('roomId',roomId).eq('personId',me.id)).first();const fields={roomId,personId:me.id,typingUntil:on?new Date(Date.now()+5000).toISOString():'',seenAt:new Date().toISOString()};if(p)await ctx.db.presence.update(p.id,fields);else await ctx.db.presence.insert(fields);ctx.invalidate('room');return true;}
export async function profile(ctx:Writer,input:{name?:string;bio?:string;timeZone?:string;avatar?:string}) {const me=await person(ctx);const changes={name:input.name===undefined?me.name:clean(input.name,80),bio:input.bio===undefined?me.bio:clean(input.bio,2000),timeZone:input.timeZone===undefined?me.timeZone:clean(input.timeZone,100),avatar:input.avatar===undefined?me.avatar:clean(input.avatar,2000)};if(!changes.name)throw new Error('Name required.');await ctx.db.people.update(me.id,changes);ctx.invalidate('bootstrap','directory','room','thread','sidebar','profile');return {user:meView({...me,...changes})};}
export async function updateAccount(ctx: Writer, input: {
 name?: string; tagline?: string; openSignUp?: boolean; restrictRoomCreation?: boolean;
 customStyles?: string; joinCode?: string; logo?: string; joinLink?: boolean; navigationIcons?: unknown;
}) {
 const me = await administrator(ctx);
 const workspace = await account(ctx);
 if (!workspace) throw new Error('Workspace unavailable.');
 if (input.customStyles !== undefined) throw new Error('Custom CSS is unavailable in Ember.');
 const changes = {
   name: input.name === undefined ? workspace.name : clean(input.name, 80),
   tagline: input.tagline === undefined ? workspace.tagline : clean(input.tagline, 200),
   openSignUp: input.openSignUp === undefined ? workspace.openSignUp : input.openSignUp === true,
   restrictRoomCreation: input.restrictRoomCreation === undefined ? workspace.restrictRoomCreation : input.restrictRoomCreation === true,
   joinCodeHash: input.joinCode === undefined ? workspace.joinCodeHash : await ctx.crypto.sha256(clean(input.joinCode, 200)),
   joinCode: input.joinCode === undefined ? workspace.joinCode : clean(input.joinCode, 200),
   joinLink: input.joinLink === undefined ? workspace.joinLink : input.joinLink === true,
   logo: input.logo === undefined ? workspace.logo : clean(input.logo, 2000),
 };
 if (!changes.name) throw new Error('Name required.');
 if (input.navigationIcons !== undefined) await updateNavigationIcons(ctx, workspace.id, input.navigationIcons);
 await ctx.db.accounts.update(workspace.id, changes);
 await audit(ctx, me.id, 'account.update', workspace.id);
 ctx.invalidate('bootstrap', 'settings');
 return accountView(ctx);
}
export async function updateRoom(ctx:Writer,input:{roomId:string;name?:string;icon?:string;kind?:string;memberIds?:string[];archived?:boolean}) {
 const {me,room}=await accessRoom(ctx,input.roomId);
 if(me.role!=='administrator' && room.creatorId!==me.id)throw new Error('Room management access required.');
 if(room.kind==='direct')throw new Error('Direct message membership is fixed.');
 const kind=input.kind ?? room.kind;
 if(kind!=='closed' && kind!=='open')throw new Error('Invalid room access.');
 const name=input.name===undefined?room.name:clean(input.name,80);
 if(!name)throw new Error('Room name required.');
 if(kind==='closed' && (input.memberIds!==undefined || !room.private)){
  if(!Array.isArray(input.memberIds)||input.memberIds.length>100)throw new Error('Invalid members.');
  const wanted=new Set(input.memberIds);
  const old=await ctx.db.members.withIndex('by_room',q=>q.eq('roomId',room.id)).take(500);
  const people=await Promise.all([...wanted].map(id=>ctx.db.people.get(clean(id))));
  if(people.some(p=>!p || p.status!=='active'))throw new Error('Choose active people for this room.');
  if(!people.some(p=>p?.role==='administrator'||p?.id===room.creatorId))throw new Error('Keep at least one active room manager in the room.');
  for(const id of wanted)await member(ctx,room.id,id);
  for(const m of old){
   if(wanted.has(m.personId))continue;
   const existing=await ctx.db.people.get(m.personId);
   // Inactive people are omitted by the picker. Keep their existing access record.
   if(existing?.status==='active')await ctx.db.members.delete(m.id);
  }
 }
 await ctx.db.rooms.update(room.id,{name,icon:input.icon===undefined?room.icon:clean(input.icon,100),private:kind==='closed',kind,archived:input.archived===undefined?room.archived:input.archived===true});
 ctx.invalidate('room','sidebar','roomSettings');
 return roomView(ctx,(await ctx.db.rooms.get(room.id))!);
}
export async function updateMembership(ctx:Writer,input:{roomId:string;favorite?:boolean;involvement?:string;order?:string}) {
 const {me,room}=await accessRoom(ctx,input.roomId);
 const membership=await member(ctx,room.id,me.id);
 const involvement=input.involvement ?? membership.involvement;
 if(!['mentions','everything','nothing','invisible'].includes(involvement))throw new Error('Invalid notification setting.');
 if(input.favorite!==undefined && room.kind==='direct')throw new Error('Only shared rooms can be starred.');
 const favorite=input.favorite===undefined ? membership.favorite : input.favorite===true;
 const order=input.order===undefined
  ? favorite && !membership.favorite ? new Date().toISOString() : membership.order
  : clean(input.order,30);
 await ctx.db.members.update(membership.id,{favorite,involvement,order});
 ctx.invalidate('sidebar');
 return input.favorite===undefined ? {involvement} : {involvement,favorites:await readFavorites(ctx,me.id)};
}
export async function updatePerson(ctx:Writer,input:{personId:string;role?:string;status?:string}) {
 const me=await administrator(ctx);const target=await ctx.db.people.get(clean(input.personId));if(!target)throw new Error('Person unavailable.');if(target.role==='bot')throw new Error('Manage incoming webhooks in their own settings.');const a=await account(ctx);
 const role=input.role===undefined?target.role:clean(input.role,30);const status=input.status===undefined?target.status:clean(input.status,30);
 if(!['member','administrator'].includes(role)||!['active','deactivated','banned'].includes(status))throw new Error('Invalid membership change.');
 if(target.id===a?.ownerId && (role!=='administrator'||status!=='active'))throw new Error('Workspace owner must retain administrator access.');
 if(target.id===me.id && (role!=='administrator'||status!=='active'))throw new Error('You cannot remove your own administrator access.');
 await ctx.db.people.update(target.id,{role,status});if(status!=='active')await revokeMemberPush(ctx,target.id);await audit(ctx,me.id,'person.update',target.id,JSON.stringify({role,status}));ctx.invalidate('bootstrap','directory','sidebar','room','thread');return {id:target.id,name:target.name,role,status};
}
export async function leaveRoom(ctx:Writer,roomId:string) {const {me,room,member:membership}=await accessRoom(ctx,roomId);if(room.kind==='direct')throw new Error('Direct message membership is fixed.');if(membership)await ctx.db.members.delete(membership.id);ctx.invalidate('sidebar','room');return true;}
export async function archiveRoom(ctx:Writer,roomId:string) {return updateRoom(ctx,{roomId,archived:true});}
