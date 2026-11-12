import { linkPreview } from './link-preview';
import { capsule, query, mutation, endpoint, table, string, boolean, id } from '@spacefast/zero/server';
import type {Writer} from './access';
import * as router from './router';
import * as bots from './bots';
import { botReply, recoverBotDelivery } from './bot-delivery';
import { assistantWebhook, recoverAssistants } from './assistants';
import * as discovery from './discovery';
import { webAppManifest } from './install';
import { recoverPush } from './push';
export const schema = {
  linkPreviews: table({ key: string(), title: string(), description: string(), expiresAt: string() }).index('by_key', ['key']).index('by_expiry', ['expiresAt']),
  accounts: table({ name: string(), tagline: string(), ownerId: string(), joinCodeHash: string(), joinCode: string(), joinLink: boolean(), openSignUp: boolean(), restrictRoomCreation: boolean(), customStyles: string(), logo: string() }),
  accountNavigation: table({ accountId: id('accounts'), icons: string() }).index('by_account', ['accountId']),
  people: table({ identityId: string(), name: string(), email: string(), role: string(), status: string(), avatar: string(), bio: string(), timeZone: string() }).index('by_identity', ['identityId']),
  rooms: table({ name: string(), description: string(), kind: string(), private: boolean(), creatorId: id('people'), icon: string(), archived: boolean(), order: string() }),
  members: table({ roomId: id('rooms'), personId: id('people'), lastReadAt: string(), involvement: string(), favorite: boolean(), order: string() }).index('by_room', ['roomId']).index('by_person', ['personId']).index('by_room_person', ['roomId','personId']),
  messages: table({ roomId: id('rooms'), creatorId: id('people'), clientId: string(), sentAt: string(), body: string(), plainText: string(), mentions: string(), parentId: string(), inRoom: boolean(), deleted: boolean(), editedAt: string(), attachment: string(), cards: string() }).index('by_room', ['roomId']).index('by_room_time', ['roomId','sentAt']).index('by_timeline', ['roomId','inRoom','sentAt']).index('by_parent', ['parentId']).index('by_parent_time', ['parentId','sentAt']).index('by_parent_creator',['parentId','creatorId']).index('by_client', ['creatorId','clientId']),
  searchTokens: table({token:string(),messageId:id('messages'),roomId:id('rooms'),sentAt:string(),creatorId:id('people')}).index('by_token_time',['token','sentAt']).index('by_token_room_time',['token','roomId','sentAt']).index('by_message',['messageId']),
  reactions: table({ messageId: id('messages'), personId: id('people'), content: string() }).index('by_message', ['messageId']).index('by_person', ['personId']),
  presence: table({ roomId: id('rooms'), personId: id('people'), typingUntil: string(), seenAt: string() }).index('by_room', ['roomId']).index('by_person', ['personId']).index('by_room_person',['roomId','personId']),
  invitations: table({ email: string(), tokenHash: string(), invitedBy: id('people'), expiresAt: string(), acceptedBy: string() }).index('by_token', ['tokenHash']).index('by_email', ['email']),
  attachmentDevices: table({workspaceId: id('accounts'), personId: id('people'), deviceId: string(), publicKey: string(), active: boolean()})
    .index('by_workspace_device', ['workspaceId', 'deviceId'])
    .index('by_workspace_person_active', ['workspaceId', 'personId', 'active']),
  files: table({ roomId: id('rooms'), creatorId: id('people'), name: string(), type: string(), size: string(), parts: string(), key: string(), status: string() }).index('by_room', ['roomId']),
  bots: table({name:string(),personId:id('people'),roomIds:string(),secretHash:string(),enabled:boolean()}),
  botCallbacks: table({botId:id('bots'),personId:id('people'),url:string(),directMessages:boolean(),revision:string()}).index('by_bot',['botId']).index('by_person',['personId']),
  botDeliveries: table({botId:id('bots'),messageId:id('messages'),revision:string(),editedAt:string(),status:string(),attempts:string(),dueAt:string(),expiresAt:string(),replyHash:string()}).index('by_due',['status','dueAt']).index('by_message_due',['messageId','status','dueAt']).index('by_expiry',['expiresAt']),
  pushSubscriptions: table({
    personId: id('people'), endpoint: string(), endpointHash: string(), publicKey: string(),
  }).index('by_person', ['personId']).index('by_endpoint_hash', ['endpointHash']).index('by_public_key', ['publicKey']),
  pushDeliveries: table({
    subscriptionId: id('pushSubscriptions'), messageId: id('messages'),
    dueAt: string(), expiresAt: string(), attempts: string(),
  }).index('by_due', ['dueAt']).index('by_message_due', ['messageId', 'dueAt']).index('by_expiry', ['expiresAt']),
  assistantSettings: table({accountId:id('accounts'),enabled:boolean(),revision:string()}).index('by_account',['accountId']),
  assistantProfiles: table({personId:id('people'),name:string(),handle:string(),instructions:string(),roomIds:string(),includeThreadRoot:boolean(),directMessages:boolean(),enabled:boolean(),revision:string()}).index('by_handle',['handle']).index('by_person',['personId']),
  assistantJobs: table({profileId:id('assistantProfiles'),messageId:id('messages'),profileRevision:string(),workspaceRevision:string(),editedAt:string(),responseId:string(),status:string(),attempts:string(),dueAt:string(),expiresAt:string()}).index('by_message',['messageId','status']).index('by_response',['responseId']).index('by_due',['status','dueAt']).index('by_expiry',['expiresAt']),
  webhookCounters:table({key:string(),botId:id('bots'),window:string(),count:string()}).index('by_key',['key']).index('by_bot',['botId']),
  recentSearches: table({personId:id('people'),query:string()}).index('by_person',['personId']),
  rateLimits:table({key:string(),window:string(),count:string()}).index('by_key',['key']),
  audit: table({ actorId: string(), action: string(), subjectId: string(), details: string() }).index('by_subject', ['subjectId']),
};

export default capsule({
 name:'Ember',favicon:'/favicon.svg',schema,
 endpoints:{
  pushRecovery:endpoint({method:'GET',path:'/push-delivery/recover',readOnly:false},(ctx,req)=>recoverPush(ctx as Writer,req)),
  assistantWebhook:endpoint({method:'POST',path:'/assistant/openai'},(ctx,req)=>assistantWebhook(router.withReadInvalidation(ctx as Writer),req)),
  assistantRecovery:endpoint({method:'GET',path:'/assistant/recover',readOnly:false},(ctx,req)=>recoverAssistants(router.withReadInvalidation(ctx as Writer),req)),
  botReply:endpoint({method:'POST',path:'/bot-replies/:deliveryId'},(ctx,req)=>botReply(router.withReadInvalidation(ctx as Writer),req)),
  botRecovery:endpoint({method:'GET',path:'/bot-delivery/recover',readOnly:false},(ctx,req)=>recoverBotDelivery(router.withReadInvalidation(ctx as Writer),req)),
  linkPreview:endpoint({method:'POST',path:'/link-preview'},(ctx,req)=>linkPreview(ctx as Writer,req)),manifest:endpoint({method:'GET',path:'/manifest.webmanifest'},webAppManifest),llms:endpoint({method:'GET',path:'/llms.txt'},discovery.llms),sitemap:endpoint({method:'GET',path:'/sitemap.xml'},discovery.sitemap),incomingSlack:endpoint({method:'POST',path:'/webhooks/:botId/:roomId/:secret/slack'},(ctx,req)=>bots.webhook(router.withReadInvalidation(ctx as Writer),req)),about:endpoint({method:'GET',path:'/about'},discovery.about),robots:endpoint({method:'GET',path:'/robots.txt'},discovery.robots),favicon:endpoint({method:'GET',path:'/favicon.svg'},discovery.favicon)},
 queries:{read:query(router.read)},
 mutations:{write:mutation(router.write)},
});
