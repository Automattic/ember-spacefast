import { useEffect, useState, useRef, useLayoutEffect } from 'react';
import { disableBrowserPush } from './ember/lib/native-push';
import { confirmOutbox } from './ember/lib/outbox';
import { useQuery, useMutation, signOut, useAuth } from './native-sdk';

type Watch = { key:string; name:string; args:any[]; value?:any; listeners:Set<(value:any)=>void> };
const watches = new Map<string,Watch>();
const changed = new Set<()=>void>();
let mutations: Record<string,(...args:any[])=>Promise<any>> = {};
export function watchNative(name:string,args:any[],listener:(v:any)=>void) {
 const key=JSON.stringify([name,args]); let item=watches.get(key);
 if(!item){item={key,name,args,listeners:new Set()};watches.set(key,item);changed.forEach(fn=>fn());}
 item.listeners.add(listener); if(item.value!==undefined)queueMicrotask(()=>{if(item.listeners.has(listener))listener(item.value);});
 return ()=>{item.listeners.delete(listener);if(!item.listeners.size && watches.get(key)===item){watches.delete(key);changed.forEach(fn=>fn());}};
}
export function readNative(name:string,...args:any[]):Promise<any>{return new Promise((resolve,reject)=>{let off=()=>{};const timeout=setTimeout(()=>{off();reject(new Error('The native service did not answer. Please try again.'));},20000);off=watchNative(name,args,value=>{clearTimeout(timeout);off();resolve(value)});});}
export async function mutateNative(name:string,...args:any[]) {
 const fn=mutations[name];
 if(!fn)throw new Error('Native connection is not ready.');
 const result=await fn(...args);
 if((name==='sendMessage' || name==='commitFile') && result?.id && result.pushDeliveryCount > 0) {
  void dispatchPushNotifications(result.id, result.pushDeliveryCount).catch(()=>{});
 }
 if(name==='sendMessage' && result?.id && result.assistantPending) void mutateNative('dispatchAssistant', result.id).catch(()=>{});
 if(name==='sendMessage' && result?.id && result.botDeliveryCount > 0) {
  // Delivery happens after commit and cannot delay or fail the original send.
  void dispatchBotReplies(result.id, result.botDeliveryCount).catch(()=>{});
 }
 return result;
}
async function dispatchPushNotifications(messageId:string, count:number) {
 for(let attempt=0;attempt<Math.min(count,6);attempt++) {
  if(!await mutateNative('dispatchPush',messageId))break;
 }
}
async function dispatchBotReplies(messageId:string, count:number) {
 for(let attempt=0;attempt<Math.min(count,3);attempt++) {
  if(!await mutateNative('dispatchBotDelivery',messageId))break;
 }
}
function Subscription({item}:{item:Watch}){const value=useQuery(item.name,...item.args);useEffect(()=>{if(value!==undefined){item.value=value;item.listeners.forEach(fn=>fn(value));}},[item,value]);return null;}
const names=['setup','join','createRoom','startDirect','sendMessage','dispatchPush','removePush','dispatchBotDelivery','dispatchAssistant','editMessage','deleteMessage','react','unreact','markRead','typing','profile','updateAccount','updateRoom','updateMembership','reserveFile','commitFile','updatePerson','leaveRoom','archiveRoom','favoriteOrder','sharedOrder','rememberSearch','clearSearches','cancelFile','registerAttachmentDevice','revokeAttachmentDevice'];
function Mutation({name}:{name:string}){mutations[name]=useMutation(name);return null;}
function NativeOutbox() {
 const auth = useAuth();
 const bootstrap = useQuery<{ user: { id: string } | null }>('bootstrap');
 const identity = auth.identity?.userId;
 const memberId = bootstrap?.user?.id;
 useLayoutEffect(() => {
  if (!identity || !memberId) return;
  return confirmOutbox(memberId, ({ message, accountId, roomId, clientMessageId }) =>
   mutateNative('sendMessage', {
    roomId, clientMessageId, body: message.body, parentId: message.parentId,
    alsoSent: message.alsoSent, expectedCreatorId: accountId,
   }),
  );
 }, [identity, memberId]);
 return null;
}
export function NativeTransport(){const auth=useAuth();const identity=String(auth.identity?.userId??'guest');const previous=useRef(identity);useEffect(()=>{if(previous.current!==identity){previous.current=identity;watches.forEach(item=>{item.value=undefined;});changed.forEach(fn=>fn());}},[identity]);const[,setVersion]=useState(0);useEffect(()=>{const fn=()=>setVersion(v=>v+1);changed.add(fn);return()=>{changed.delete(fn);};},[]);return <><NativeOutbox/>{names.map(name=><Mutation key={name} name={name}/>)}{Array.from(watches.values()).map(item=><Subscription key={identity+item.key} item={item}/>)}</>;}
export async function nativeRequest(path:string,init:RequestInit={}) {
 const url=new URL(path,location.origin), p=url.pathname, method=init.method??'GET';
 const body=typeof init.body==='string'?JSON.parse(init.body):init.body instanceof FormData?JSON.parse(String(init.body.get('user')??'{}')):{};
 const unsupported=()=>{throw Object.assign(new Error('This feature is not available in this native Spacefast version.'),{status:501});};
 if(p==='/api/bootstrap')return readNative('bootstrap');
 if(p==='/api/sidebar')return readNative('sidebar');
 if(/^\/api\/users\/[^/]+$/.test(p)&&p!=='/api/users/me'){const d=await readNative('directory');return {person:d.users.find((u:any)=>u.id===decodeURIComponent(p.split('/').pop()!))};}
 if(p==='/api/users')return readNative('directory');
 if(p==='/api/first_run/check')return unsupported();
 if(p==='/api/first_run')return mutateNative('setup',body);
 if(p.startsWith('/api/join')||p==='/api/session/guest'){
  const result=await mutateNative('join',body);
  if(result?.ok===false)throw Object.assign(new Error(result.message),{status:403});
  return {user:result};
 }
 if(p==='/api/users/me')return {user:(await readNative('bootstrap')).user};
 if(p==='/api/users/me/profile')return method==='GET'?readNative('profile'):mutateNative('profile',body);
 if(p==='/api/account/custom_styles')return unsupported();
 if(p==='/api/account/settings')return readNative('settings');
 if(p==='/api/account')return method==='GET'?readNative('settings'):{account:await mutateNative('updateAccount',body)};
 if(p==='/api/rooms/new'){
  const bootstrap=await readNative('bootstrap');
  if(!bootstrap.user)throw Object.assign(new Error('Sign in to create a room.'),{status:401});
  if(bootstrap.account.restrictRoomCreation&&!bootstrap.user.administrator)throw Object.assign(new Error('Only administrators can create rooms.'),{status:403});
  const directory=await readNative('directory');
  return {people:directory.users.filter((person:any)=>person.status==='active').sort((a:any,b:any)=>a.name.localeCompare(b.name))};
 }
 if(p==='/api/rooms'&&method==='POST')return {room:await mutateNative('createRoom',body)};
 if(p==='/api/directs')return {room:await mutateNative('startDirect',body.userIds)};
 const room=p.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
 if(room){const id=decodeURIComponent(room[1]),action=room[2];if(action==='settings'){const v=await readNative('roomSettings',id);return {...v,canAdminister:v.canEdit,people:v.users.map((p:any)=>({...p,member:v.memberIds.includes(p.id)}))};}if(!action&&method==='DELETE')return mutateNative('archiveRoom',id);if(action==='membership'&&method==='DELETE')return mutateNative('leaveRoom',id);if(!action&&method==='PATCH')return {room:await mutateNative('updateRoom',{roomId:id,...body})};if(['favorite','involvement'].includes(action??'')){return mutateNative('updateMembership',{roomId:id,...body});}}
 if(p==='/api/sidebar/order')return mutateNative('favoriteOrder',body.roomIds);
 if(p==='/api/account/room_order'){await mutateNative('sharedOrder',body.roomIds);return {sharedOrder:(await readNative('sidebar')).sharedOrder};}
 if(p==='/api/searches'){if(method==='DELETE')return mutateNative('clearSearches');const input=method==='GET'?Object.fromEntries(url.searchParams):body;if(method==='POST')await mutateNative('rememberSearch',{query:JSON.stringify(input)});const v=await readNative('search',{...input,roomId:input.in});const sidebar=await readNative('sidebar');return {search:input.q||input.in||input.from||input.withMe||input.hasLink||input.hasFile||input.inThread?input:null,matches:(v.messages??[]).map((message:any)=>({message,words:String(input.q??'').split(/\s+/)})),next:v.cursor,rooms:sidebar.rooms,recent:(await readNative('recentSearches')).map((r:any)=>{try{const saved=JSON.parse(r.query);return typeof saved.q==='string'?saved:{q:r.query};}catch{return {q:r.query};}})};}
 if(p==='/api/unfurl'&&method==='POST'){
  const response=await fetch('/link-preview',{
   method:'POST',
   headers:{'Content-Type':'application/json'},
   credentials:'same-origin',
   redirect:'error',
   body:JSON.stringify({url:body.url}),
   signal:init.signal,
  });
  return response.ok&&response.status!==204?response.json():null;
 }
 if(p==='/api/push/subscriptions')return {subscriptions:[]};
 if(p==='/api/session'&&method==='DELETE'){
  const expectedPersonId=(await readNative('bootstrap').catch(()=>null))?.user?.id;
  if(expectedPersonId)await disableBrowserPush(endpoint=>mutateNative('removePush',{endpoint,expectedPersonId})).catch(()=>{});
  await signOut({returnTo:location.href});
  return {};
 }
 return unsupported();
}
