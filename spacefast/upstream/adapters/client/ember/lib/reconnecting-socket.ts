import { readNative, mutateNative, watchNative } from '../../native-transport';
import { readAction } from '../../native-sdk';
import type { ClientFrame, Message, Sidebar, User } from '../../protocol/index';
type RoomSnapshot = { messages: Message[]; hasMore: boolean; present?: User[]; typing?: { user: User; typing: boolean }[]; seq?: number; observedAt?: string };
type HistoryPage = { messages: Message[]; hasMore: boolean; hasNewer: boolean; around: string | null };
type ThreadSnapshot = { parent: Message; messages: Message[]; hasMore: boolean; observedAt: string };
type ThreadWatch = { stop: () => void; rememberHistory?: (messages: Message[]) => void };
export const OFFLINE_AFTER_MS=5000;
export type SocketStatus='connecting'|'reconnecting';
export interface ReconnectingSocketOptions {url:()=>string;onMessage:(data:string)=>void;onSidebar?:(sidebar:Sidebar)=>void;onConnecting?:(status:SocketStatus)=>void;onOffline?:(offline:boolean)=>void;onClose:(code:number,opened:boolean)=>boolean;deploySpreadMs?:readonly[number,number];}
export interface ReconnectingSocket<Frame=ClientFrame>{send(frame:Frame):boolean;connected():void;retry():void;hold():void;close():void;}
export function openAhead(_url:string){return ()=>{};}
export const waitingAhead=(_url:string)=>false;
export function reconnectingSocket<Frame=ClientFrame>(options:ReconnectingSocketOptions):ReconnectingSocket<Frame>{
 const url=new URL(options.url()),roomId=decodeURIComponent(url.pathname.match(/\/rooms\/([^/]+)/)?.[1]??'');let closed=false,seq=0,prior:RoomSnapshot|undefined;let typingIds=new Map<string,{user:User;typing:boolean}>();const threads=new Map<string,ThreadWatch>();const off:(()=>void)[]=[];
 const failedReads = new Set<string>();
 const networkChanged = () => options.onOffline?.(!navigator.onLine || failedReads.size > 0);
 const watchHealth = (key: string) => (failed: boolean) => {
  if (failed) failedReads.add(key);
  else failedReads.delete(key);
  if (!closed) networkChanged();
 };
 const emit=(frame:any)=>{if(!closed)options.onMessage(JSON.stringify(frame));};
 const fail=(error:any,frame:any)=>emit({type:'error',message:error.message,failed:frame.type,clientMessageId:frame.clientMessageId,clientMessageIds:frame.clientMessageIds});
 const markCatchUp = watchHealth('catch-up');
 let pendingRoom: RoomSnapshot | undefined;
 let catchUp: number | undefined;
 let readingGap = false;
 let lastDelivered: string | undefined;
 let oldestRoomMessage = Infinity;
 let roomVisible = url.searchParams.get('visible') !== 'false';
 const openingMessage = url.searchParams.get('around');
 const rememberRoomHistory = (messages: Message[]) => {
  if (messages.length > 0) oldestRoomMessage = Math.min(oldestRoomMessage, Number(messages[0]!.id));
 };
 const deliverMessage = (message: Message, updated: boolean) => {
  if (message.deleted) emit({type:'message.deleted', messageId:message.id, seq:++seq});
  else emit({type:updated ? 'message.updated' : 'message.created', message, seq:++seq});
 };
 async function refreshHistory(operation: 'roomChanges' | 'threadChanges', id: string, oldest: number, before: number, since: string, until: string, stopped: () => boolean) {
  let after = oldest - 1;
  while (after + 1 < before && since < until && !stopped()) {
   const changes = await readNative(operation, id, after, before, since, until) as {messages: Message[]; hasNewer: boolean};
   if (stopped()) return;
   for (const message of changes.messages) deliverMessage(message, true);
   if (!changes.hasNewer) break;
   after = Number(changes.messages.at(-1)!.id);
  }
 }
 const applyRoom = (value: RoomSnapshot, opening?: HistoryPage) => {
  const nextTyping = new Map((value.typing ?? []).map(entry => [entry.user.id, entry]));
  for (const [id, typing] of nextTyping) if (!typingIds.has(id)) emit({type:'typing', ...typing});
  for (const [id, typing] of typingIds) if (!nextTyping.has(id)) emit({type:'typing', user:typing.user, typing:false});
  typingIds = nextTyping;
  if (!prior) {
   seq = value.seq ?? 0;
   if (opening) rememberRoomHistory(opening.messages);
   emit({...value, ...opening});
  } else {
   if (readAction && prior.present && value.present) {
    const present = new Set(value.present.map(user => user.id));
    const previous = new Set(prior.present.map(user => user.id));
    for (const user of prior.present) if (!present.has(user.id)) emit({type:'presence.left', userId:user.id});
    for (const user of value.present) if (!previous.has(user.id)) emit({type:'presence.joined', user});
   }
   for (const message of value.messages) {
    const old = prior.messages.find(item => item.id === message.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(message)) deliverMessage(message, Boolean(old));
   }
  }
  prior = value;
  rememberRoomHistory(value.messages);
  lastDelivered = value.messages.at(-1)?.id ?? lastDelivered ?? '0';
 };
 const receiveRoom = (value: RoomSnapshot) => {
  pendingRoom = value;
  if (readingGap || catchUp !== undefined) return;
  void drainRoom();
 };
 async function drainRoom() {
  readingGap = true;
  let value: RoomSnapshot | undefined;
  try {
   while (!closed && pendingRoom) {
    value = pendingRoom;
    pendingRoom = undefined;
    const first = Number(value.messages[0]?.id);
    let opening: HistoryPage | undefined;
    if (!prior && readAction && openingMessage) {
     try {
      opening = await readNative('roomAround', roomId, openingMessage);
     } catch (error) {
      if ((error as {status?: number}).status !== 404) throw error;
     }
    }
    if (readAction && prior?.observedAt && value.observedAt) {
     const before = Math.min(first, Number(lastDelivered ?? 0) + 1);
     await refreshHistory('roomChanges', roomId, oldestRoomMessage, before, prior.observedAt, value.observedAt, () => closed);
    }
    while (readAction && lastDelivered && (lastDelivered !== '0' || value.hasMore) && Number(lastDelivered) < first && !closed) {
     const page = await readNative('roomAfter', roomId, lastDelivered) as {messages: Message[]; hasNewer: boolean};
     if (closed) return;
     const gap = page.messages.filter(message => Number(message.id) < first);
     if (gap.length === 0) break;
     rememberRoomHistory(gap);
     for (const message of gap) {
      deliverMessage(message, false);
      lastDelivered = message.id;
     }
     if (gap.length !== page.messages.length || !page.hasNewer) break;
    }
    if (closed) return;
    applyRoom(value, opening);
    if (failedReads.has('catch-up')) markCatchUp(false);
   }
  } catch {
   if (closed) return;
   pendingRoom ??= value;
   markCatchUp(true);
   catchUp = window.setTimeout(() => {
    catchUp = undefined;
    void drainRoom();
   }, 2000);
  } finally {
   readingGap = false;
  }
 }
 function watchThread(parentId: string): ThreadWatch {
  const opened = (value: ThreadSnapshot) => emit({type:'thread.opened', parentId, ...value});
  const health = watchHealth('thread:'+parentId);
  if (!readAction) {
   const unsubscribe = watchNative('thread',[parentId],opened,health);
   return {stop() { unsubscribe(); health(false); }};
  }
  const gapKey = 'thread-catch-up:'+parentId;
  const gapHealth = watchHealth(gapKey);
  let stopped = false;
  let previous: ThreadSnapshot | undefined;
  let pending: ThreadSnapshot | undefined;
  let reading = false;
  let retry: number | undefined;
  let oldest = Infinity;
  const rememberHistory = (messages: Message[]) => {
   if (messages.length > 0) oldest = Math.min(oldest, Number(messages[0]!.id));
  };

  async function drain() {
   reading = true;
   let value: ThreadSnapshot | undefined;
   try {
    while (!stopped && pending) {
     value = pending;
     pending = undefined;
     if (!previous) {
      rememberHistory(value.messages);
      opened(value);
     } else {
      const last = Number(previous.messages.at(-1)?.id ?? 0);
      const missed: Message[][] = [];
      let page = value;
      // A full snapshot can start after the last reply we saw. Page back until it overlaps.
      while (page.hasMore && Number(page.messages[0]?.id) > last) {
       page = await readNative('thread', parentId, page.messages[0]!.id);
       if (stopped) return;
       missed.push(page.messages.filter(message => Number(message.id) > last));
      }
      // The latest snapshot covers newer replies. Only fetch edits to older replies already shown.
      const before = Math.min(Number(value.messages[0]?.id), last + 1);
      await refreshHistory('threadChanges', parentId, oldest, before, previous.observedAt, value.observedAt, () => stopped);
      if (stopped) return;
      for (const messages of missed.reverse()) {
       rememberHistory(messages);
       for (const message of messages) deliverMessage(message, false);
      }
      rememberHistory(value.messages);
      const known = new Map(previous.messages.map(message => [message.id, message]));
      for (const message of value.messages) {
       const old = known.get(message.id);
       if (old ? JSON.stringify(old) !== JSON.stringify(message) : Number(message.id) > last) {
        deliverMessage(message, Boolean(old));
       }
      }
      if (JSON.stringify(previous.parent) !== JSON.stringify(value.parent)) {
       emit({type:'message.updated', message:value.parent, seq:++seq});
      }
     }
     previous = value;
     if (failedReads.has(gapKey)) gapHealth(false);
    }
   } catch {
    if (stopped) return;
    pending ??= value;
    gapHealth(true);
    retry = window.setTimeout(() => {
     retry = undefined;
     void drain();
    }, 2000);
   } finally {
    reading = false;
   }
  }

  const unsubscribe = watchNative('thread', [parentId], (value: ThreadSnapshot) => {
   pending = value;
   if (!reading && retry === undefined) void drain();
  }, health);
  return {
   rememberHistory,
   stop() {
    stopped = true;
    window.clearTimeout(retry);
    unsubscribe();
    failedReads.delete(gapKey);
    health(false);
   },
  };
 }
 const visitRoom = () => mutateNative(readAction ? 'roomPresence' : 'markRead', roomId);
 if(roomId&&roomVisible)void visitRoom().catch(()=>{});
 if(roomId&&readAction) {
  const heartbeat = window.setInterval(() => {
   if (roomVisible && !document.hidden) void mutateNative('roomPresence', roomId).catch(()=>{});
  }, 25000);
  off.push(() => window.clearInterval(heartbeat));
 }
 if(roomId)off.push(watchNative('room',[roomId],receiveRoom,watchHealth('room')));
 else {off.push(watchNative('bootstrap',[],v=>{if(v.user)emit({type:'welcome',you:v.user,account:v.account});}));off.push(watchNative('sidebar',[],v=>{if(!closed)options.onSidebar?.(v);}));}
 async function send(frame:any){switch(frame.type){
 case 'message.update':await mutateNative('editMessage',{roomId,messageId:frame.messageId,body:frame.body});break;
 case 'message.delete':await mutateNative('deleteMessage',frame.messageId);break;
 case 'boost.create':await mutateNative('react',{messageId:frame.messageId,content:frame.content});break;
 case 'boost.delete':await mutateNative('unreact',frame.boostId);break;
 case 'typing.start':case 'typing.stop':await mutateNative('typing',roomId,frame.type==='typing.start');break;
 case 'presence.visible':roomVisible=frame.visible;if(frame.visible)await visitRoom();break;
 case 'thread.open':{
  if(!threads.has(frame.parentId)) threads.set(frame.parentId,watchThread(frame.parentId));
  break;
 }
 case 'thread.close':threads.get(frame.parentId)?.stop();threads.delete(frame.parentId);break;
 case 'thread.before':{
  const watcher=threads.get(frame.parentId);
  const v=await readNative('thread',frame.parentId,frame.before);
  if (watcher !== threads.get(frame.parentId)) break;
  watcher?.rememberHistory?.(v.messages);
  emit({type:'thread.history',parentId:frame.parentId,before:frame.before,...v});
  break;
 }
 case 'history.before':{const v=await readNative('room',roomId,frame.before);rememberRoomHistory(v.messages);emit({...v,type:'history',before:frame.before});break;}
 case 'history.after':{const v=await readNative('roomAfter',roomId,frame.after);emit({...v,type:'history.after',after:frame.after});break;}
 case 'history.around':{const v=await readNative('roomAround',roomId,frame.messageId);rememberRoomHistory(v.messages);emit({...v,type:'history.around'});break;}
 case 'message.check':{
  if (readAction) {
   const result = await readNative('messageCheck', roomId, frame.clientMessageIds);
   emit({type:'message.checked', ...result});
  } else {
   const ids = new Set(prior?.messages.map(message => message.clientMessageId));
   emit({type:'message.checked',stored:frame.clientMessageIds.filter((id:string)=>ids.has(id)),missing:frame.clientMessageIds.filter((id:string)=>!ids.has(id))});
  }
  break;
 }
 case 'ping':emit({type:'pong'});break;
 }}
 window.addEventListener('online', networkChanged);
 window.addEventListener('offline', networkChanged);
 off.push(() => window.removeEventListener('online', networkChanged), () => window.removeEventListener('offline', networkChanged));
 networkChanged();
 const stop = () => {
  closed = true;
  window.clearTimeout(catchUp);
  threads.forEach(thread => thread.stop());
  threads.clear();
  off.forEach(fn => fn());
 };
 return {send(frame:Frame){if(closed || (frame as ClientFrame).type === 'message.create')return false;void send(frame).catch(error=>fail(error,frame));return true;},connected: networkChanged,retry(){},hold: stop,close: stop};
}
