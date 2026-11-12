import type {Reader,Writer} from './access';
import * as views from './views';
import * as writes from './writes';
import * as queries from './queries';
import * as files from './files';
import * as attachmentDevices from './attachment-devices';
import * as bots from './bots';
import { dispatchBotDelivery } from './bot-delivery';
import { assistantNotice, assistants, setAssistants, saveAssistant, dispatchAssistant } from './assistants';
import * as community from './community';
import {search} from './search';
import { pushSettings, savePush, removePush, dispatchPush } from './push';

// Fixed registries; request data never contributes a handler or context property.
const READ_HANDLERS={pushSettings,bootstrap:views.bootstrap,sidebar:views.sidebar,room:views.room,roomAfter:views.roomAfter,roomAround:views.roomAround,thread:views.thread,directory:views.directory,profile:queries.profile,roomSettings:queries.roomSettings,settings:queries.settings,search,attachment:files.attachment,attachmentDevices:attachmentDevices.attachmentDevices,attachmentRecipients:attachmentDevices.attachmentRecipients,bots:bots.bots,assistants,assistantNotice,invitations:community.invitations,recentSearches:community.recentSearches};
const WRITE_HANDLERS={savePush,removePush,dispatchPush,setup:writes.setup,join:writes.join,createRoom:writes.createRoom,startDirect:writes.startDirect,sendMessage:writes.sendMessage,setAssistants,saveAssistant,dispatchAssistant,dispatchBotDelivery,editMessage:writes.editMessage,deleteMessage:writes.deleteMessage,react:writes.react,unreact:writes.unreact,markRead:writes.markRead,typing:writes.typing,profile:writes.profile,updateAccount:writes.updateAccount,updateRoom:writes.updateRoom,updateMembership:writes.updateMembership,registerAttachmentDevice:attachmentDevices.registerAttachmentDevice,revokeAttachmentDevice:attachmentDevices.revokeAttachmentDevice,reserveFile:files.reserveFile,commitFile:files.commitFile,cancelFile:files.cancelFile,updatePerson:writes.updatePerson,leaveRoom:writes.leaveRoom,archiveRoom:writes.archiveRoom,createBot:bots.createBot,updateBot:bots.updateBot,invite:community.invite,revokeInvitation:community.revokeInvitation,favoriteOrder:community.favoriteOrder,sharedOrder:community.sharedOrder,rememberSearch:community.rememberSearch,clearSearches:community.clearSearches};
const READ_ARITY:Record<string,[number,number]>={pushSettings:[2,2],bootstrap:[0,0],sidebar:[0,0],room:[1,2],roomAfter:[2,2],roomAround:[1,2],thread:[1,2],directory:[0,0],profile:[0,0],roomSettings:[1,1],settings:[0,0],search:[1,1],attachment:[1,2],attachmentDevices:[0,1],attachmentRecipients:[1,1],bots:[0,0],assistants:[0,0],assistantNotice:[1,1],invitations:[0,0],recentSearches:[0,0]};
const WRITE_ARITY:Record<string,[number,number]>={savePush:[1,1],removePush:[1,1],dispatchPush:[1,1],setup:[1,1],join:[1,1],createRoom:[1,1],startDirect:[1,1],sendMessage:[1,1],setAssistants:[1,1],saveAssistant:[1,1],dispatchAssistant:[1,1],dispatchBotDelivery:[1,1],editMessage:[1,1],deleteMessage:[1,1],react:[1,1],unreact:[1,1],markRead:[1,1],typing:[2,2],profile:[1,1],updateAccount:[1,1],updateRoom:[1,1],updateMembership:[1,1],registerAttachmentDevice:[1,1],revokeAttachmentDevice:[1,2],reserveFile:[1,1],commitFile:[1,1],cancelFile:[1,1],updatePerson:[1,1],leaveRoom:[1,1],archiveRoom:[1,1],createBot:[1,1],updateBot:[1,1],invite:[1,1],revokeInvitation:[1,1],favoriteOrder:[1,1],sharedOrder:[1,1],rememberSearch:[1,1],clearSearches:[0,0]};
const OBJECT_WRITES=['savePush','removePush','setup','join','createRoom','sendMessage','editMessage','react','profile','updateAccount','updateRoom','updateMembership','registerAttachmentDevice','reserveFile','commitFile','updatePerson','createBot','updateBot','setAssistants','saveAssistant','invite','rememberSearch'];
function validate(operation:unknown,args:unknown,registry:object,arity:Record<string,[number,number]>):asserts args is unknown[]{
 if(typeof operation!=='string'||operation.length>50||!Object.hasOwn(registry,operation)||!Object.hasOwn(arity,operation))throw new Error('Unknown operation.');
 if(!Array.isArray(args)||args.length>4||args.length<arity[operation][0]||args.length>arity[operation][1])throw new Error('Invalid operation arguments.');
 const json=JSON.stringify(args);if(json.length>1024*1024)throw new Error('Operation arguments too large.');
}
export function withReadInvalidation(ctx:Writer):Writer{return {...ctx,invalidate:()=>ctx.invalidate('read')};}
export async function read(ctx:Reader,operation:unknown,args:unknown){
 validate(operation,args,READ_HANDLERS,READ_ARITY);const name=operation as keyof typeof READ_HANDLERS;
 if(name==='search'&&(!args[0]||typeof args[0]!=='object'||Array.isArray(args[0])))throw new Error('Invalid operation arguments.');
 // Registry entries retain their original typed definitions. The boundary above validates
 // dispatch shape; every selected handler still performs its own input and access checks.
 const handler=READ_HANDLERS[name] as (context:Reader,...values:unknown[])=>unknown;return handler(ctx,...args);
}
export async function write(ctx:Writer,operation:unknown,args:unknown){
 validate(operation,args,WRITE_HANDLERS,WRITE_ARITY);const name=operation as keyof typeof WRITE_HANDLERS;
 if(OBJECT_WRITES.includes(name)&&(!args[0]||typeof args[0]!=='object'||Array.isArray(args[0])))throw new Error('Invalid operation arguments.');
 const handler=WRITE_HANDLERS[name] as (context:Writer,...values:unknown[])=>unknown;const result=await handler(withReadInvalidation(ctx),...args);ctx.invalidate('read');return result;
}
