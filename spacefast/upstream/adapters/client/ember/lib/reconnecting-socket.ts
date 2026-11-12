import { readNative, mutateNative, watchNative } from '../../native-transport';
import type { ClientFrame, Sidebar } from '../../protocol/index';
export const OFFLINE_AFTER_MS=5000;
export type SocketStatus='connecting'|'reconnecting';
export interface ReconnectingSocketOptions {url:()=>string;onMessage:(data:string)=>void;onSidebar?:(sidebar:Sidebar)=>void;onConnecting?:(status:SocketStatus)=>void;onOffline?:(offline:boolean)=>void;onClose:(code:number,opened:boolean)=>boolean;deploySpreadMs?:readonly[number,number];}
export interface ReconnectingSocket<Frame=ClientFrame>{send(frame:Frame):boolean;connected():void;retry():void;hold():void;close():void;}
export function openAhead(_url:string){return ()=>{};}
export const waitingAhead=(_url:string)=>false;
export function reconnectingSocket<Frame=ClientFrame>(options:ReconnectingSocketOptions):ReconnectingSocket<Frame>{
 const url=new URL(options.url()),roomId=decodeURIComponent(url.pathname.match(/\/rooms\/([^/]+)/)?.[1]??'');let closed=false,seq=0,prior:any=null;let typingIds=new Map<string,any>();const threadStops=new Map<string,()=>void>();const off:(()=>void)[]=[];
 const emit=(frame:any)=>{if(!closed)options.onMessage(JSON.stringify(frame));};
 const fail=(error:any,frame:any)=>emit({type:'error',message:error.message,failed:frame.type,clientMessageId:frame.clientMessageId});
 if(roomId&&url.searchParams.get('visible')!=='false')void mutateNative('markRead',roomId).catch(()=>{});
 if(roomId)off.push(watchNative('room',[roomId],value=>{const nextTyping=new Map<string,any>((value.typing??[]).map((t:any)=>[t.user.id,t]));for(const [id,t] of nextTyping)if(!typingIds.has(id))emit({type:'typing',...t});for(const [id,t] of typingIds)if(!nextTyping.has(id))emit({type:'typing',user:t.user,typing:false});typingIds=nextTyping;if(!prior){prior=value;seq=value.seq??0;emit(value);return;}for(const message of value.messages){const old=prior.messages.find((m:any)=>m.id===message.id);if(!old||JSON.stringify(old)!==JSON.stringify(message)){if(message.deleted)emit({type:'message.deleted',messageId:message.id,seq:++seq});else emit({type:old?'message.updated':'message.created',message,seq:++seq});}}prior=value;}));
 else {off.push(watchNative('bootstrap',[],v=>{if(v.user)emit({type:'welcome',you:v.user,account:v.account});}));off.push(watchNative('sidebar',[],v=>{if(!closed)options.onSidebar?.(v);}));}
 async function send(frame:any){switch(frame.type){
 case 'message.update':await mutateNative('editMessage',{roomId,messageId:frame.messageId,body:frame.body});break;
 case 'message.delete':await mutateNative('deleteMessage',frame.messageId);break;
 case 'boost.create':await mutateNative('react',{messageId:frame.messageId,content:frame.content});break;
 case 'boost.delete':await mutateNative('unreact',frame.boostId);break;
 case 'typing.start':case 'typing.stop':await mutateNative('typing',roomId,frame.type==='typing.start');break;
 case 'presence.visible':if(frame.visible)await mutateNative('markRead',roomId);break;
 case 'thread.open':{threadStops.get(frame.parentId)?.();const stop=watchNative('thread',[frame.parentId],v=>emit({type:'thread.opened',parentId:frame.parentId,...v}));threadStops.set(frame.parentId,stop);off.push(stop);break;}
 case 'thread.close':threadStops.get(frame.parentId)?.();threadStops.delete(frame.parentId);break;
 case 'thread.before':{const v=await readNative('thread',frame.parentId,frame.before);emit({type:'thread.history',parentId:frame.parentId,before:frame.before,...v});break;}
 case 'history.before':{const v=await readNative('room',roomId,frame.before);emit({...v,type:'history',before:frame.before});break;}
 case 'history.after':{const v=await readNative('roomAfter',roomId,frame.after);emit({...v,type:'history.after',after:frame.after});break;}
 case 'history.around':{const v=await readNative('roomAround',roomId,frame.messageId);emit({...v,type:'history.around'});break;}
 case 'message.check':{const ids=new Set(prior?.messages.map((m:any)=>m.clientMessageId));emit({type:'message.checked',stored:frame.clientMessageIds.filter((id:string)=>ids.has(id)),missing:frame.clientMessageIds.filter((id:string)=>!ids.has(id))});break;}
 case 'ping':emit({type:'pong'});break;
 }}
 const networkChanged = () => options.onOffline?.(!navigator.onLine);
 window.addEventListener('online', networkChanged);
 window.addEventListener('offline', networkChanged);
 off.push(() => window.removeEventListener('online', networkChanged), () => window.removeEventListener('offline', networkChanged));
 networkChanged();
 const stop = () => { closed = true; off.forEach(fn => fn()); };
 return {send(frame:Frame){if(closed || (frame as ClientFrame).type === 'message.create')return false;void send(frame).catch(error=>fail(error,frame));return true;},connected: networkChanged,retry(){},hold: stop,close: stop};
}
