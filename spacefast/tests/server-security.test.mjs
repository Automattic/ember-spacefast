import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createHash, createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const out = await mkdtemp(join(tmpdir(), 'ember-security-'));
async function load(name) {
 const outfile=join(out, `${name}.mjs`);
 await build({entryPoints:[fileURLToPath(new URL(`../server/${name}.ts`, import.meta.url))],outfile,bundle:true,platform:'node',format:'esm'});
 return import(pathToFileURL(outfile));
}
const [writes, views, access, searchModule, community, bots, files, entry, previews, botDelivery, push, attachmentDevices] = await Promise.all(['writes','views','access','search','community','bots','files','index','link-preview','bot-delivery','push','attachment-devices'].map(load));
process.on('exit',()=>{void rm(out,{recursive:true,force:true});});
const tables=Object.keys(entry.schema);
function fixture(identity='alice') {
 let serial=0; const rows=Object.fromEntries(tables.map(n=>[n,[]]));
 const stamp='2026-11-10T00:00:00.000Z';
 const db=Object.fromEntries(tables.map(n=>[n,{
  async get(id){return rows[n].find(r=>r.id===id)??null;},
  async insert(value){const r={...value,id:`${n}_${++serial}`,createdAt:stamp,updatedAt:stamp};rows[n].push(r);return r;},
  async update(id,patch){const r=rows[n].find(r=>r.id===id);if(r)Object.assign(r,patch);return r??null;},
  async delete(id){const i=rows[n].findIndex(r=>r.id===id);if(i<0)return false;rows[n].splice(i,1);return true;},
  withIndex(index,apply){let filters=[];const range={};for(const op of ['eq','gt','gte','lt','lte'])range[op]=(key,value)=>{filters.push(r=>op==='eq'?r[key]===value:op==='gt'?r[key]>value:op==='gte'?r[key]>=value:op==='lt'?r[key]<value:r[key]<=value);return range;};apply?.(range);let desc=false;const sortField=(index.includes('time')||index==='by_timeline')?'sentAt':'createdAt';const result=()=>rows[n].filter(r=>filters.every(f=>f(r))).slice().sort((a,b)=>desc?String(b[sortField]).localeCompare(String(a[sortField])):String(a[sortField]).localeCompare(String(b[sortField])));const q={order(d){desc=d==='desc';return q;},async collect(){return result();},async count(){return result().length;},async take(k){return result().slice(0,k);},async first(){return result()[0]??null;},async paginate({numItems}){return {page:result().slice(0,numItems),continueCursor:null,isDone:true};}};return q;}
 }]));
 const auth={userId:identity,displayName:identity,email:`${identity}@example.test`,emailVerified:true,isSignedIn:true,isAuthenticated:true,provider:'space-users',requireSignedIn(){if(!this.isSignedIn)throw Error('Sign in required.');return this;}};
 const mail=[];const ctx={db,auth,email:{async send(message){mail.push(message);return true;}},env:{EMBER_ADMIN_EMAIL:'alice@example.test',EMBER_PUBLIC_URL:'https://ember.example.test',EMBER_EMAIL_FROM:'owner@example.test'},invalidate(){},log:{info(){},warn(){},error(){}},crypto:{async sha256(v){return createHash('sha256').update(v).digest('hex');},async hmacSha256({key,data}){return createHmac('sha256',typeof key==='string'?ctx.env[key]:key.value).update(data).digest('hex');},async timingSafeEqual(a,b){return a===b;}}};
 const seed=(name,value)=>{const r={id:value.id??`${name}_${++serial}`,createdAt:stamp,updatedAt:stamp,...value};rows[name].push(r);return r;};
 for(const id of ['alice','bob','carol'])seed('people',{id,identityId:id,name:id,email:`${id}@example.test`,role:id==='alice'?'administrator':'member',status:'active',avatar:'',bio:'',timeZone:''});
 seed('accounts',{id:'account',name:'Ember',ownerId:'alice',joinCodeHash:'secret-hash',openSignUp:false,restrictRoomCreation:false,tagline:'',customStyles:'',logo:''});
 for(const [id,privateRoom,kind] of [['public',false,'open'],['private',true,'closed'],['dm',true,'direct']]){seed('rooms',{id,name:id,private:privateRoom,kind,creatorId:'alice',archived:false,order:''});for(const personId of ['alice','bob'])seed('members',{roomId:id,personId,lastReadAt:'',favorite:false,involvement:'mentions',order:''});}
 return {ctx,rows,seed,mail,as(id){ctx.auth.userId=id;ctx.auth.displayName=id;ctx.auth.email=`${id}@example.test`;return ctx;}};
}
const send=(f,roomId='private',extra={})=>writes.sendMessage(f.ctx,{roomId,clientMessageId:'retry-1',body:'hello',...extra});

test('guest and nonmember cannot read workspace or write messages',async()=>{const f=fixture();f.ctx.auth.isSignedIn=false;f.ctx.auth.isAuthenticated=false;for(const call of [()=>views.sidebar(f.ctx),()=>send(f),()=>access.administrator(f.ctx)])await assert.rejects(call);f.ctx.auth.isSignedIn=true;f.as('outsider');await assert.rejects(()=>views.sidebar(f.ctx));});
test('private room and DM never appear to outsider; reads and writes deny',async()=>{const f=fixture('carol');const sidebar=await views.sidebar(f.ctx);assert.deepEqual(sidebar.rooms.map(r=>r.id),['public']);for(const id of ['private','dm']){await assert.rejects(()=>views.room(f.ctx,id));await assert.rejects(()=>send(f,id));}await views.room(f.ctx,'public');});
test('removed room member and banned workspace person lose reads and writes',async()=>{const f=fixture('bob');for(const m of [...f.rows.members])if(m.personId==='bob'&&m.roomId==='private')await f.ctx.db.members.delete(m.id);await assert.rejects(()=>views.room(f.ctx,'private'));await assert.rejects(()=>send(f));f.rows.people.find(p=>p.id==='bob').status='banned';await assert.rejects(()=>views.room(f.ctx,'public'));await assert.rejects(()=>send(f,'public'));});
test('message author owns editing; member cannot delete someone else; admin can moderate',async()=>{const f=fixture('bob');const m=await send(f);f.as('carol');await assert.rejects(()=>writes.editMessage(f.ctx,{messageId:m.id,body:'stolen'}));await assert.rejects(()=>writes.deleteMessage(f.ctx,m.id));f.as('alice');await assert.rejects(()=>writes.editMessage(f.ctx,{messageId:m.id,body:'admin edit'}));await writes.deleteMessage(f.ctx,m.id);assert.equal(f.rows.messages[0].deleted,true);assert.equal(f.rows.messages[0].body,'');});
test('retries are idempotent per author and cannot reuse id across rooms',async()=>{const f=fixture('bob');const a=await send(f);const b=await send(f);assert.equal(a.id,b.id);assert.equal(f.rows.messages.length,1);await assert.rejects(()=>send(f,'public'));f.as('alice');await send(f);assert.equal(f.rows.messages.length,2);});
test('queued messages cannot write under a different signed-in member',async()=>{
 const f=fixture('bob');
 const queued={expectedCreatorId:'alice'};
 await assert.rejects(()=>send(f,'public',queued),/Message sender changed/);
 assert.equal(f.rows.messages.length,0);
 f.as('alice');
 const message=await send(f,'public',queued);
 assert.equal(message.creator.id,'alice');
 assert.equal((await send(f,'public',queued)).id,message.id);
 assert.equal(f.rows.messages.length,1);
});
test('profile payload cannot escalate role or identity, members cannot change workspace policy',async()=>{const f=fixture('bob');await writes.profile(f.ctx,{name:'Bob',role:'administrator',identityId:'alice',status:'active'});const bob=f.rows.people.find(p=>p.id==='bob');assert.equal(bob.role,'member');assert.equal(bob.identityId,'bob');await assert.rejects(()=>writes.updateAccount(f.ctx,{openSignUp:true}));await assert.rejects(()=>writes.updateRoom(f.ctx,{roomId:'private',memberIds:['carol']}));});
test('input validation rejects empty/oversized message, foreign thread and stolen attachment',async()=>{const f=fixture('bob');for(const body of ['', ' '.repeat(4), 'x'.repeat(20001), '<p></p>'])await assert.rejects(()=>send(f,'private',{body}));const parent=f.seed('messages',{id:'foreign',roomId:'dm',creatorId:'alice',parentId:'',body:'hidden',plainText:'hidden'});await assert.rejects(()=>send(f,'private',{parentId:parent.id}));f.seed('files',{id:'file',roomId:'private',creatorId:'alice',status:'ready',parts:'[]'});await assert.rejects(()=>send(f,'private',{fileId:'file'}));assert.equal(f.rows.messages.length,1);});
test('bootstrap exposes no join credential, private rooms, or people email directory',async()=>{const f=fixture('outsider');const result=await views.bootstrap(f.ctx);const text=JSON.stringify(result);assert.equal(result.user,null);assert.ok(!text.includes('secret-hash'));assert.ok(!text.includes('bob@example.test'));assert.ok(!text.includes('private'));});
test('bootstrap and setup agree for a different verified account without disclosing the owner', async () => {
 const f = fixture('bob');
 f.rows.accounts.splice(0);
 f.rows.people.splice(0);
 const before = await views.bootstrap(f.ctx);
 assert.equal(before.nativeAuth.setupEligibility, 'owner_account_required');
 assert.ok(!JSON.stringify(before).includes(f.ctx.env.EMBER_ADMIN_EMAIL));
 const result = await writes.setup(f.ctx, {name:'Hijacker', communityName:'Taken'});
 assert.equal(result.ok, false);
 assert.equal(result.errorCode, before.nativeAuth.setupEligibility);
 assert.ok(!JSON.stringify(result).includes(f.ctx.env.EMBER_ADMIN_EMAIL));
 assert.equal(f.rows.accounts.length, 0);
 assert.equal(f.rows.people.length, 0);
});

test('setup requires a configured verified owner and allows one initialization', async () => {
 const f = fixture('alice');
 f.rows.accounts.splice(0);
 f.rows.people.splice(0);
 const input = {name:'Alice', communityName:'Ember'};
 const expected = f.ctx.env.EMBER_ADMIN_EMAIL;
 delete f.ctx.env.EMBER_ADMIN_EMAIL;
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.setupEligibility, 'owner_not_configured');
 assert.equal((await writes.setup(f.ctx, input)).errorCode, 'owner_not_configured');
 f.ctx.env.EMBER_ADMIN_EMAIL = expected;
 f.ctx.auth.emailVerified = false;
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.setupEligibility, 'verified_email_required');
 assert.equal((await writes.setup(f.ctx, input)).errorCode, 'verified_email_required');
 assert.equal(f.rows.people.length, 0);
 f.ctx.auth.emailVerified = true;
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.setupEligibility, 'eligible');
 const result = await writes.setup(f.ctx, input);
 assert.equal(result.user.administrator, true);
 assert.equal(f.rows.accounts.length, 1);
 assert.equal((await writes.setup(f.ctx, input)).errorCode, 'already_initialized');
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.setupEligibility, 'already_initialized');
});
test('pinned native owner can initialize without an email claim', async () => {
 const f = fixture('alice');
 f.rows.accounts.splice(0);
 f.rows.people.splice(0);
 f.ctx.env.EMBER_ADMIN_PRINCIPAL = 'account:alice';
 f.ctx.auth.userId = 'account:alice';
 delete f.ctx.auth.email;
 delete f.ctx.auth.emailVerified;
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.setupEligibility, 'eligible');
 const result = await writes.setup(f.ctx, {name:'Alice', communityName:'Ember'});
 assert.equal(result.user.administrator, true);
 assert.equal(f.rows.people[0].identityId, 'account:alice');
 assert.equal(f.rows.accounts.length, 1);
});

test('configured owner pin rejects other identities and malformed pins even with verified email', async () => {
 const f = fixture('alice');
 f.rows.accounts.splice(0);
 f.rows.people.splice(0);
 f.ctx.auth.userId = 'account:other';
 f.ctx.auth.identityAliases = ['account:alice'];
 f.ctx.env.EMBER_ADMIN_PRINCIPAL = 'account:alice';
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.setupEligibility, 'owner_account_required');
 assert.equal((await writes.setup(f.ctx, {name:'Alice'})).errorCode, 'owner_account_required');
 f.ctx.env.EMBER_ADMIN_PRINCIPAL = 'alice';
 assert.equal((await writes.setup(f.ctx, {name:'Alice'})).errorCode, 'owner_not_configured');
 assert.equal(f.rows.people.length, 0);
 assert.equal(f.rows.accounts.length, 0);
});

test('a guest cannot initialize even with the pinned principal string', async () => {
 const f = fixture('alice');
 f.rows.accounts.splice(0);
 f.rows.people.splice(0);
 f.ctx.env.EMBER_ADMIN_PRINCIPAL = 'account:alice';
 f.ctx.auth.userId = 'account:alice';
 f.ctx.auth.isSignedIn = false;
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.setupEligibility, 'sign_in_required');
 assert.equal((await writes.setup(f.ctx, {name:'Alice'})).errorCode, 'sign_in_required');
 assert.equal(f.rows.people.length, 0);
 assert.equal(f.rows.accounts.length, 0);
});

test('author can edit and deleted content cannot be edited again',async()=>{const f=fixture('bob');const m=await send(f);const edited=await writes.editMessage(f.ctx,{messageId:m.id,body:'changed'});assert.equal(edited.plainText,'changed');await writes.deleteMessage(f.ctx,m.id);await assert.rejects(()=>writes.editMessage(f.ctx,{messageId:m.id,body:'resurrect'}));});
test('direct room membership is immutable and outsider cannot read its thread',async()=>{const f=fixture('bob');const m=await send(f,'dm');await assert.rejects(()=>writes.updateRoom(f.ctx,{roomId:'dm',memberIds:['carol']}));f.as('carol');await assert.rejects(()=>views.thread(f.ctx,m.id));});

async function seedSearch(f,id,roomId,text,sentAt){const m=f.seed('messages',{id,roomId,creatorId:'alice',clientId:id,body:text,plainText:text,parentId:'',inRoom:true,deleted:false,attachment:'',cards:'',editedAt:'',sentAt});await searchModule.indexMessage(f.ctx,m);return m;}
test('indexed search finds an old hit beyond 500 newer unrelated messages and hides private hits',async()=>{const f=fixture('carol');await seedSearch(f,'old-hit','public','needle', '2020-01-01T00:00:00.000Z');for(let i=0;i<510;i++)f.seed('messages',{id:`noise${i}`,roomId:'public',plainText:'noise',sentAt:`2026-01-01T00:00:00.${String(i).padStart(3,'0')}Z`});await seedSearch(f,'secret-hit','private','needle','2026-01-01T00:00:00.000Z');const result=await searchModule.search(f.ctx,{q:'needle'});assert.deepEqual(result.messages.map(m=>m.id),['old-hit']);});
test('indexed newest cursor includes all equal-time matches without repetition',async()=>{const f=fixture('carol');for(let i=0;i<60;i++)await seedSearch(f,`hit${String(i).padStart(2,'0')}`,'public','needle','2026-01-01T00:00:00.000Z');const first=await searchModule.search(f.ctx,{q:'needle'});assert.equal(first.messages.length,50);const second=await searchModule.search(f.ctx,{q:'needle',cursor:first.cursor});assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,60);});
test('indexed oldest cursor moves forward and filters author and room',async()=>{const f=fixture('carol');for(let i=0;i<60;i++)await seedSearch(f,`old${i}`,'public','needle',`2026-01-01T00:00:${String(i).padStart(2,'0')}.000Z`);const first=await searchModule.search(f.ctx,{q:'needle',sort:'oldest',roomId:'public',from:'alice'});const second=await searchModule.search(f.ctx,{q:'needle',sort:'oldest',roomId:'public',from:'alice',cursor:first.cursor});assert.equal(new Set([...first.messages,...second.messages].map(m=>m.id)).size,60);});
test('editing replaces search terms and deleting removes the indexed hit',async()=>{const f=fixture('bob');const m=await send(f,'public',{body:'firstword'});assert.equal((await searchModule.search(f.ctx,{q:'firstword'})).messages.length,1);await writes.editMessage(f.ctx,{messageId:m.id,body:'replacement'});assert.equal((await searchModule.search(f.ctx,{q:'firstword'})).messages.length,0);assert.equal((await searchModule.search(f.ctx,{q:'replacement'})).messages.length,1);await writes.deleteMessage(f.ctx,m.id);assert.equal((await searchModule.search(f.ctx,{q:'replacement'})).messages.length,0);});
test('search excludes private token metadata before reading candidates',async()=>{const f=fixture('carol');await seedSearch(f,'public-old','public','needle','2020-01-01T00:00:00.000Z');for(let i=0;i<205;i++)await seedSearch(f,`private${i}`,'private','needle',`2026-01-01T00:00:00.${String(i).padStart(3,'0')}Z`);const result=await searchModule.search(f.ctx,{q:'needle'});assert.deepEqual(result.messages.map(m=>m.id),['public-old']);assert.equal(result.hasMore,false);assert.equal(result.cursor,null);});

const secret='secure_webhook_secret_12345678901234567890';
const webhookRequest=(botId,roomId='public',key=secret,id='delivery1',body=JSON.stringify({text:'hello webhook'}))=>({params:{botId,roomId,secret:key},headers:{get(name){return name==='Idempotency-Key'?id:null;}},async text(){return body;}});
test('community administration denies member and guest without sending email',async()=>{const f=fixture('bob');for(const call of [()=>community.invite(f.ctx,{email:'new@example.test',token:secret}),()=>community.invitations(f.ctx),()=>community.sharedOrder(f.ctx,['public']),()=>bots.createBot(f.ctx,{name:'Bot',roomIds:['public'],secret})])await assert.rejects(call);f.ctx.auth.isSignedIn=false;await assert.rejects(()=>community.favoriteOrder(f.ctx,['public']));assert.equal(f.mail.length,0);});
test('invitation queues one native mail and stores only hashed token, retry does not resend',async()=>{const f=fixture();const first=await community.invite(f.ctx,{email:'new@example.test',token:secret});const retry=await community.invite(f.ctx,{email:'new@example.test',token:secret});assert.equal(first.id,retry.id);assert.equal(f.mail.length,1);assert.equal(f.rows.invitations.length,1);assert.notEqual(f.rows.invitations[0].tokenHash,secret);assert.ok(f.mail[0].text.includes('https://ember.example.test/?invite='));});
test('favorites cannot reorder another person memberships or unstarred rooms',async()=>{const f=fixture('bob');await assert.rejects(()=>community.favoriteOrder(f.ctx,['public']));const own=f.rows.members.find(m=>m.personId==='bob'&&m.roomId==='public');own.favorite=true;await community.favoriteOrder(f.ctx,['public']);assert.equal(own.order,'000000');assert.equal(f.rows.members.find(m=>m.personId==='alice'&&m.roomId==='public').order,'');await assert.rejects(()=>community.favoriteOrder(f.ctx,['public','public']));});
test('webhook verifies secret, allowed room, and stable retry id without exposing secret',async()=>{const f=fixture();const b=await bots.createBot(f.ctx,{name:'Bot',roomIds:['public'],secret});assert.ok(!JSON.stringify(await bots.bots(f.ctx)).includes(secret));assert.equal((await bots.webhook(f.ctx,webhookRequest(b.id,'public','wrong'))).status,403);assert.equal((await bots.webhook(f.ctx,webhookRequest(b.id,'private'))).status,404);assert.equal((await bots.webhook(f.ctx,webhookRequest(b.id))).status,200);await bots.webhook(f.ctx,webhookRequest(b.id));assert.equal(f.rows.messages.length,1);});
test('bot room removal, key rotation and disable revoke subsequent posts',async()=>{const f=fixture();const b=await bots.createBot(f.ctx,{name:'Bot',roomIds:['public','private'],secret});await bots.updateBot(f.ctx,{id:b.id,roomIds:['private'],secret:secret+'rotated'});assert.equal((await bots.webhook(f.ctx,webhookRequest(b.id))).status,403);assert.equal((await bots.webhook(f.ctx,webhookRequest(b.id,'public',secret+'rotated'))).status,404);await bots.updateBot(f.ctx,{id:b.id,enabled:false});assert.equal((await bots.webhook(f.ctx,webhookRequest(b.id,'private',secret+'rotated'))).status,403);assert.equal(f.rows.messages.length,0);});
test('webhook rate limit stops writes, retry of accepted delivery remains idempotent',async()=>{const f=fixture();const b=await bots.createBot(f.ctx,{name:'Bot',roomIds:['public'],secret});await bots.webhook(f.ctx,webhookRequest(b.id));f.rows.webhookCounters[0].count='60';assert.equal((await bots.webhook(f.ctx,webhookRequest(b.id,'public',secret,'delivery2'))).status,429);assert.equal((await bots.webhook(f.ctx,webhookRequest(b.id))).status,200);assert.equal(f.rows.messages.length,1);});
const manifest={version:1,name:'file.txt',type:'text/plain',size:5,key:'a'.repeat(64),chunks:[{id:'b'.repeat(32),url:'/__stattic/u/'+ 'b'.repeat(32),iv:'c'.repeat(24),size:5}]};
function testDevice(number) {
 const ecdh = createECDH('prime256v1');
 ecdh.setPrivateKey(Buffer.from([number]));
 return {deviceId: number.toString(16).padStart(32, '0'), publicKey: ecdh.getPublicKey('hex', 'uncompressed')};
}
const aliceDevice = testDevice(1);
const bobDevice = testDevice(2);
const spareDevice = testDevice(3);
async function protectedUpload(f, roomId = 'private', source = manifest) {
 await attachmentDevices.registerAttachmentDevice(f.as('alice'), aliceDevice);
 await attachmentDevices.registerAttachmentDevice(f.as('bob'), bobDevice);
 const file = await files.reserveFile(f.ctx, {roomId, name: source.name, type: source.type, size: source.size});
 const {key, ...publicFields} = source;
 const encrypted = {
  ...publicFields, version: 2, fileId: file.id, senderDeviceId: bobDevice.deviceId, senderPublicKey: bobDevice.publicKey,
  wraps: [aliceDevice, bobDevice].map(({deviceId, publicKey}, i) => ({
   recipientId: deviceId, recipientPublicKey: publicKey, iv: 'a'.repeat(23) + i, key: String(i).repeat(96),
  })),
 };
 return {fileId: file.id, manifest: encrypted, message: {body: '', clientMessageId: 'protected-attachment'}};
}

test('legacy private manifest remains available to current members', async () => {
 const f = fixture('bob');
 const file = f.seed('files', {roomId: 'private', creatorId: 'bob', status: 'ready', parts: JSON.stringify(manifest)});
 assert.equal((await files.attachment(f.ctx, file.id)).key, manifest.key);
 await assert.rejects(() => files.attachment(f.as('carol'), file.id));
 for (const member of f.rows.members.filter(m => m.personId === 'bob' && m.roomId === 'private')) {
  await f.ctx.db.members.delete(member.id);
 }
 await assert.rejects(() => files.attachment(f.as('bob'), file.id));
});

test('new private and direct uploads reject raw keys and fail closed on roster changes', async () => {
 for (const roomId of ['private', 'dm']) {
  const f = fixture();
  const input = await protectedUpload(f, roomId);
  await assert.rejects(() => files.commitFile(f.ctx, {...input, manifest}), /requirements changed/);
  await assert.rejects(() => files.commitFile(f.ctx, {fileId: input.fileId, manifest: input.manifest}), /posted with a message/);
  await assert.rejects(() => files.commitFile(f.ctx, {...input, manifest: {...input.manifest, fileId: 'wrong'}}), /changed/);
  await assert.rejects(() => files.commitFile(f.ctx, {...input, manifest: {...input.manifest, key: manifest.key}}), /Invalid encrypted/);
  await assert.rejects(() => files.commitFile(f.as('alice'), input), /File unavailable/);
  await attachmentDevices.registerAttachmentDevice(f.ctx, spareDevice);
  await assert.rejects(() => files.commitFile(f.as('bob'), input), /devices changed/);
  assert.equal(f.rows.files[0].status, 'uploading');
  assert.equal(f.rows.messages.length, 0);
 }
});

test('finalizing and sending reject a room access mode change', async () => {
 const f = fixture('alice');
 const file = await files.reserveFile(f.ctx, {roomId: 'public', name: manifest.name, type: manifest.type, size: manifest.size});
 const posted = await files.reserveFile(f.ctx, {roomId: 'public', name: manifest.name, type: manifest.type, size: manifest.size});
 await files.commitFile(f.ctx, {fileId: posted.id, manifest});
 await writes.updateRoom(f.ctx, {roomId: 'public', kind: 'closed', memberIds: ['alice', 'bob']});
 await assert.rejects(() => files.commitFile(f.ctx, {fileId: file.id, manifest}), /requirements changed/);
 await assert.rejects(() => send(f, 'public', {fileId: posted.id}), /Encrypted attachments/);
 assert.equal(f.rows.messages.length, 0);
});

test('protected attachment posts once and returns just the requesting device envelope', async () => {
 const f = fixture();
 const input = await protectedUpload(f);
 const first = await files.commitFile(f.ctx, input);
 assert.equal((await files.commitFile(f.ctx, input)).id, first.id);
 assert.equal(f.rows.messages.length, 1);
 assert.equal(JSON.parse(f.rows.files[0].parts).key, undefined);
 assert.equal(first.attachment.manifest, undefined);
 assert.deepEqual(first.attachment, {
  id: input.fileId, name: manifest.name, type: manifest.type, size: manifest.size,
  version: 2, workspaceId: 'account', roomId: 'private', senderId: 'bob',
 });
 await assert.rejects(() => files.attachment(f.ctx, input.fileId), /unavailable/);
 assert.equal(await files.attachment(f.ctx, input.fileId, aliceDevice.deviceId), null);
 await assert.rejects(() => files.attachment(f.as('carol'), input.fileId, aliceDevice.deviceId), /unavailable/);
 const protectedManifest = await files.attachment(f.as('alice'), input.fileId, aliceDevice.deviceId);
 assert.equal(protectedManifest.workspaceId, 'account');
 assert.equal(protectedManifest.roomId, 'private');
 assert.equal(protectedManifest.senderId, 'bob');
 assert.deepEqual(protectedManifest.wraps, [input.manifest.wraps[0]]);
 const room = await views.room(f.ctx, 'private');
 assert.equal(JSON.stringify(room).includes(input.manifest.wraps[0].key), false);
 f.as('bob');
 await assert.rejects(() => send(f, 'private', {fileId: input.fileId}), /File unavailable/);
 await writes.deleteMessage(f.ctx, first.id);
 await assert.rejects(() => files.attachment(f.ctx, input.fileId, bobDevice.deviceId));
});

test('protected picture summaries never expose the thumbnail location or nonce', async () => {
 const f = fixture();
 const id = 'e'.repeat(32);
 const picture = {
  width: 2400, height: 1800,
  thumbnail: {type: 'image/webp', size: 7, chunks: [{id, url: '/__stattic/u/' + id, iv: 'f'.repeat(24), size: 7}]},
 };
 const input = await protectedUpload(f, 'private', {...manifest, name: 'picture.png', type: 'image/png', picture});
 const badDimensions = {...picture, width: 1_000_000};
 await assert.rejects(() => files.commitFile(f.ctx, {...input, manifest: {...input.manifest, picture: badDimensions}}), /Invalid attachment picture/);
 const duplicatedChunk = {...picture, thumbnail: {...picture.thumbnail, chunks: input.manifest.chunks, size: input.manifest.size}};
 await assert.rejects(() => files.commitFile(f.ctx, {...input, manifest: {...input.manifest, picture: duplicatedChunk}}), /Invalid attachment chunk/);
 const posted = await files.commitFile(f.ctx, input);
 assert.deepEqual(posted.attachment.picture, {width: 2400, height: 1800, thumbnail: true});
 assert.equal(JSON.stringify(posted.attachment).includes(id), false);
 const read = await files.attachment(f.as('alice'), input.fileId, aliceDevice.deviceId);
 assert.deepEqual(read.picture, picture);
 await assert.rejects(() => files.attachment(f.as('carol'), input.fileId, aliceDevice.deviceId), /unavailable/);
});

test('device registration validates points, keeps immutable ownership and rejects stale account writes', async () => {
 const f = fixture();
 await assert.rejects(() => attachmentDevices.registerAttachmentDevice(f.ctx, {deviceId: aliceDevice.deviceId, publicKey: '04' + '00'.repeat(64)}), /Invalid/);
 await assert.rejects(() => attachmentDevices.registerAttachmentDevice(f.ctx, {...aliceDevice, expectedPersonId: 'bob'}), /account changed/);
 await attachmentDevices.registerAttachmentDevice(f.ctx, aliceDevice);
 await attachmentDevices.registerAttachmentDevice(f.ctx, aliceDevice);
 await assert.rejects(() => attachmentDevices.registerAttachmentDevice(f.ctx, {...aliceDevice, publicKey: bobDevice.publicKey}), /unavailable/);
 await assert.rejects(() => attachmentDevices.registerAttachmentDevice(f.as('bob'), aliceDevice), /unavailable/);
 await assert.rejects(() => attachmentDevices.revokeAttachmentDevice(f.ctx, aliceDevice.deviceId), /unavailable/);
 await assert.rejects(() => attachmentDevices.attachmentRecipients(f.as('carol'), 'private'), /unavailable/);
 const roster = await attachmentDevices.attachmentRecipients(f.as('alice'), 'private');
 assert.equal(roster.missing, 1);
 assert.deepEqual(roster.devices, [{...aliceDevice, personId: 'alice'}]);
 await attachmentDevices.revokeAttachmentDevice(f.ctx, aliceDevice.deviceId, 'alice');
 assert.equal((await attachmentDevices.attachmentDevices(f.ctx, aliceDevice.deviceId)).currentDeviceRevoked, true);
 assert.equal((await attachmentDevices.attachmentDevices(f.as('bob'), aliceDevice.deviceId)).currentDeviceRevoked, false);
 await assert.rejects(() => attachmentDevices.registerAttachmentDevice(f.as('alice'), aliceDevice), /unavailable/);
});

test('later devices and removed members cannot retrieve a protected attachment', async () => {
 const f = fixture();
 const input = await protectedUpload(f);
 await files.commitFile(f.ctx, input);
 await attachmentDevices.registerAttachmentDevice(f.as('alice'), spareDevice);
 assert.equal(await files.attachment(f.ctx, input.fileId, spareDevice.deviceId), null);
 await attachmentDevices.revokeAttachmentDevice(f.ctx, aliceDevice.deviceId);
 assert.equal(await files.attachment(f.ctx, input.fileId, aliceDevice.deviceId), null);
 const membership = f.rows.members.find(m => m.roomId === 'private' && m.personId === 'bob');
 await f.ctx.db.members.delete(membership.id);
 await assert.rejects(() => files.attachment(f.as('bob'), input.fileId, bobDevice.deviceId), /unavailable/);
});

test('manifest validation refuses external URL, quota blocks excessive upload',async()=>{const f=fixture('bob');assert.throws(()=>files.validateManifest({...manifest,chunks:[{...manifest.chunks[0],url:'https://evil.example/file'}]}));await files.reserveFile(f.ctx,{roomId:'public',name:'file.txt',type:'text/plain',size:5});const quota=f.rows.rateLimits.find(r=>r.key==='bob:file-count');quota.count='20';await assert.rejects(()=>files.reserveFile(f.ctx,{roomId:'public',name:'file.txt',type:'text/plain',size:5}));});
test('history before/after/around is ordered and cannot use foreign-room anchor',async()=>{const f=fixture('bob');for(let i=0;i<60;i++)await seedSearch(f,`history${String(i).padStart(2,'0')}`,'public','history',`2026-01-01T00:00:${String(i).padStart(2,'0')}.000Z`);const older=await views.room(f.ctx,'public','history50');assert.ok(older.messages.every(m=>m.id<'history50'));const after=await views.roomAfter(f.ctx,'public','history50');assert.equal(after.messages.length,9);assert.equal(after.messages[0].id,'history51');const around=await views.roomAround(f.ctx,'public','history30');assert.equal(around.around,'history30');assert.equal(around.messages.length,51);await seedSearch(f,'secretanchor','private','secret','2020-01-01T00:00:00.000Z');await assert.rejects(()=>views.roomAfter(f.ctx,'public','secretanchor'));f.as('carol');await assert.rejects(()=>views.roomAround(f.ctx,'private','secretanchor'));});
test('message deletion revokes future attachment manifest retrieval',async()=>{const f=fixture('bob');const file=await files.reserveFile(f.ctx,{roomId:'public',name:'file.txt',type:'text/plain',size:5});await files.commitFile(f.ctx,{fileId:file.id,manifest});const m=await send(f,'public',{fileId:file.id});await writes.deleteMessage(f.ctx,m.id);await assert.rejects(()=>files.attachment(f.ctx,file.id));});

test('webhook rejects changed payload under same retry key and removed bot membership',async()=>{const f=fixture();const b=await bots.createBot(f.ctx,{name:'Bot',roomIds:['public'],secret});await bots.webhook(f.ctx,webhookRequest(b.id));const different=await bots.webhook(f.ctx,webhookRequest(b.id,'public',secret,'delivery1',JSON.stringify({text:'different'})));assert.equal(different.status,409);const personId=f.rows.bots.find(r=>r.id===b.id).personId;for(const m of [...f.rows.members])if(m.personId===personId)await f.ctx.db.members.delete(m.id);assert.equal((await bots.webhook(f.ctx,webhookRequest(b.id,'public',secret,'delivery2'))).status,404);});
test('invitation retry token cannot be reused for another recipient or accepted invitation',async()=>{const f=fixture();await community.invite(f.ctx,{email:'new@example.test',token:secret});await assert.rejects(()=>community.invite(f.ctx,{email:'other@example.test',token:secret}));f.rows.invitations[0].acceptedBy='bob';await assert.rejects(()=>community.invite(f.ctx,{email:'new@example.test',token:secret}));assert.equal(f.mail.length,1);});
test('manifest rejects nonce reuse across chunks and message quota prevents new sends',async()=>{assert.throws(()=>files.validateManifest({...manifest,size:4*1024*1024+5,chunks:[{...manifest.chunks[0],size:4*1024*1024},{...manifest.chunks[0],id:'d'.repeat(32),url:'/__stattic/u/'+'d'.repeat(32),size:5}]}));const f=fixture('bob');await send(f,'public');const rate=f.rows.rateLimits.find(r=>r.key==='bob:messages');assert.ok(rate,'message rate counter exists');rate.count='60';await assert.rejects(()=>send(f,'public',{clientMessageId:'next'}));assert.equal(f.rows.messages.length,1);});

test('invitation gives safe recovery guidance and is claimed only by its verified recipient', async () => {
 const f = fixture();
 await community.invite(f.ctx, {email:'new@example.test', token:secret});

 f.as('outsider');
 const wrong = await writes.join(f.ctx, {name:'Wrong account', invitationToken:secret});
 assert.equal(wrong.ok, false);
 assert.match(wrong.message, /verified email address/);
 assert.doesNotMatch(JSON.stringify(wrong), /new@example\.test/);

 f.as('new');
 f.ctx.auth.emailVerified = false;
 assert.equal((await writes.join(f.ctx, {name:'New', invitationToken:secret})).ok, false);
 f.ctx.auth.emailVerified = true;
 const expiration = f.rows.invitations[0].expiresAt;
 f.rows.invitations[0].expiresAt = '2000-01-01T00:00:00.000Z';
 const expired = await writes.join(f.ctx, {name:'New', invitationToken:secret});
 assert.match(expired.message, /expired/);
 assert.equal(f.rows.invitations[0].acceptedBy, '');
 assert.equal(f.rows.people.length, 3);

 f.rows.invitations[0].expiresAt = expiration;
 const joined = await writes.join(f.ctx, {name:'New', invitationToken:secret});
 assert.equal(joined.name, 'New');
 assert.equal(f.rows.invitations[0].acceptedBy, joined.id);
 assert.equal((await writes.join(f.ctx, {name:'New', invitationToken:secret})).ok, false);
 assert.equal(f.rows.people.length, 4);
});

test('administrators can restore deactivated members without granting them a different role', async () => {
 const f = fixture();
 await writes.updatePerson(f.ctx, {personId:'bob', status:'deactivated'});
 f.as('bob');
 const before = await views.bootstrap(f.ctx);
 assert.equal(before.user, null);
 assert.equal(before.nativeAuth.member, true);
 assert.match((await writes.join(f.ctx, {name:'Bob'})).message, /access is inactive/);
 await assert.rejects(() => writes.updatePerson(f.ctx, {personId:'bob', status:'active'}));
 f.as('alice');
 await writes.updatePerson(f.ctx, {personId:'bob', status:'active'});
 f.as('bob');
 assert.equal((await views.bootstrap(f.ctx)).user.administrator, false);
});

test('navigation icon changes persist across saves and custom CSS stays unavailable', async () => {
 const f = fixture();
 f.rows.accounts[0].customStyles = 'legacy styles';
 assert.equal((await views.bootstrap(f.ctx)).account.customStyles, '');
 await assert.rejects(() => writes.updateAccount(f.ctx, {customStyles:'replacement'}));
 assert.equal(f.rows.accounts[0].customStyles, 'legacy styles');
 assert.deepEqual((await writes.updateAccount(f.ctx, {navigationIcons:{home:'star'}})).navigationIcons, {home:'star'});
 assert.deepEqual((await writes.updateAccount(f.ctx, {navigationIcons:{search:'search'}})).navigationIcons, {home:'star', search:'search'});
 await assert.rejects(() => writes.updateAccount(f.ctx, {navigationIcons:{home:'unlisted-icon'}}));
 await assert.rejects(() => writes.updateAccount(f.ctx, {navigationIcons:{unknown:'star'}}));
 await writes.updateAccount(f.ctx, {navigationIcons:{home:''}});
 f.as('bob');
 assert.deepEqual((await views.bootstrap(f.ctx)).account.navigationIcons, {search:'search'});
 await assert.rejects(() => writes.updateAccount(f.ctx, {navigationIcons:{search:''}}));
});

test('hiding a Ping only changes the viewer’s sidebar and reopening preserves history', async () => {
 const f=fixture('bob');
 const sent=await send(f,'dm');
 await writes.updateMembership(f.ctx,{roomId:'dm',involvement:'invisible'});
 assert.equal((await views.sidebar(f.ctx)).rooms.find(room=>room.id==='dm').involvement,'invisible');
 f.as('alice');
 assert.notEqual((await views.sidebar(f.ctx)).rooms.find(room=>room.id==='dm').involvement,'invisible');
 assert.equal((await views.room(f.ctx,'dm')).messages[0].id,sent.id);
 f.as('bob');
 assert.equal((await writes.startDirect(f.ctx,['alice'])).id,'dm');
 assert.equal((await views.sidebar(f.ctx)).rooms.find(room=>room.id==='dm').involvement,'everything');
 assert.equal((await views.room(f.ctx,'dm')).messages[0].id,sent.id);
});

test('private room managers can remove themselves while leaving an active manager', async () => {
 const f=fixture();
 await assert.rejects(()=>writes.updateRoom(f.ctx,{roomId:'private',memberIds:['bob']}),/active room manager/);
 const bob=f.rows.people.find(p=>p.id==='bob');
 bob.role='administrator';
 const carol=f.rows.people.find(p=>p.id==='carol');
 carol.status='suspended';
 const carolMembership=f.seed('members',{roomId:'private',personId:'carol',lastReadAt:'',favorite:false,involvement:'mentions',order:''});
 await assert.rejects(()=>writes.updateRoom(f.ctx,{roomId:'private',memberIds:['bob','carol']}),/active people/);
 await writes.updateRoom(f.ctx,{roomId:'private',memberIds:['bob']});
 await assert.rejects(()=>views.room(f.ctx,'private'),/Room unavailable/);
 assert.ok(await f.ctx.db.members.get(carolMembership.id));
 f.as('bob');
 assert.ok((await views.sidebar(f.ctx)).rooms.some(room=>room.id==='private'));
});

test('favorite writes return current stars and archived rooms drop out of them', async () => {
 const f=fixture();
 assert.deepEqual((await writes.updateMembership(f.ctx,{roomId:'private',favorite:true})).favorites.rooms,['private']);
 await writes.updateMembership(f.ctx,{roomId:'public',favorite:true});
 assert.deepEqual((await community.favoriteOrder(f.ctx,['public','private'])).favorites.rooms,['public','private']);
 const message=await send(f,'private');
 await writes.archiveRoom(f.ctx,'private');
 assert.deepEqual((await views.sidebar(f.ctx)).favorites.rooms,['public']);
 assert.ok(await f.ctx.db.messages.get(message.id));
 await assert.rejects(()=>views.room(f.ctx,'private'),/Room unavailable/);
});

function previewRequest(url, origin = 'https://ember.example.com') {
  return {
    url: 'https://ember.example.com/link-preview',
    headers: new Headers({ origin, 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ url }),
  };
}

test('link previews stay text-only, cache metadata per member, and keep the original target', async t => {
  const f = fixture();
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(
    '<html><head><title>Fallback</title><meta property="og:title" content="Meet &amp; greet"><meta name="description" content="Schedule"><meta property="og:url" content="https://different.example/"><meta property="og:image" content="https://different.example/track.png"></head></html>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  ));
  const request = previewRequest('https://www.example.com/agenda#schedule');
  const first = await previews.linkPreview(f.ctx, request);
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(first.body), {
    title: 'Meet & greet', description: 'Schedule', image: null, url: 'https://www.example.com/agenda',
  });
  assert.equal((await previews.linkPreview(f.ctx, request)).status, 200);
  assert.equal(fetch.mock.callCount(), 1);
  f.as('bob');
  assert.equal((await previews.linkPreview(f.ctx, request)).status, 200);
  assert.equal(fetch.mock.callCount(), 2);
});

test('link previews refuse signed-out visitors, cross-origin submissions and unsafe URL formats before fetching', async t => {
  const f = fixture();
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected fetch'); });
  for (const url of ['http://example.com/', 'https://127.0.0.1/', 'https://test.internal/', 'https://example.com:8443/', 'https://example.com@host.example/']) {
    assert.equal((await previews.linkPreview(f.ctx, previewRequest(url))).status, 204);
  }
  assert.equal((await previews.linkPreview(f.ctx, previewRequest('https://example.com/', 'https://different.example'))).status, 204);
  f.ctx.auth.isSignedIn = false;
  assert.equal((await previews.linkPreview(f.ctx, previewRequest('https://example.com/'))).status, 403);
  assert.equal(fetch.mock.callCount(), 0);
});

const callbackUrl = 'https://hooks.example.org/ember';
const botMention = personId => `<p>Hi <action-text-attachment content-type="application/vnd.campfire.mention" sgid="${personId}"></action-text-attachment></p>`;
async function outgoingFixture({ directMessages = false, roomIds = ['public'] } = {}) {
 const f = fixture();
 f.ctx.env.EMBER_BOT_SIGNING_KEY = 'local-test-signing-key-placeholder-1234';
 const bot = await bots.createBot(f.ctx, { name: 'Echo', roomIds, secret, outgoingUrl: callbackUrl, directMessages });
 const personId = f.rows.bots.find(row => row.id === bot.id).personId;
 return { ...f, bot, personId };
}
function signedReply(payload, text, key = payload.reply.key) {
 const body = JSON.stringify({ text });
 return {
  params: { deliveryId: payload.deliveryId },
  headers: new Headers({ 'X-Ember-Signature': 'sha256=' + createHmac('sha256', key).update(body).digest('hex') }),
  async text() { return body; },
 };
}
async function sendToBot(f, roomId = 'public', body = botMention(f.personId)) {
 return writes.sendMessage(f.ctx, { roomId, clientMessageId: 'bot-delivery-test', body });
}

test('outgoing bots queue only authorized mentions, and dispatch a sanitized threaded reply once', async t => {
 const f = await outgoingFixture();
 const plain = await writes.sendMessage(f.ctx, { roomId: 'public', clientMessageId: 'plain', body: '<p>Hello @Echo</p>' });
 assert.equal(plain.botDeliveryCount, 0);
 assert.equal((await writes.sendMessage(f.ctx, { roomId: 'private', clientMessageId: 'private', body: botMention(f.personId) })).botDeliveryCount, 0);
 const m = await sendToBot(f);
 assert.equal(m.botDeliveryCount, 1);
 assert.equal((await sendToBot(f)).id, m.id);
 assert.equal(f.rows.botDeliveries.length, 1);
 const mocked = t.mock.method(globalThis, 'fetch', async (url, init) => {
  assert.equal(url, callbackUrl);
  assert.equal(init.redirect, 'error');
  assert.deepEqual(Object.keys(init.headers).sort(), ['Content-Type','Idempotency-Key']);
  const payload = JSON.parse(init.body);
  assert.equal(payload.messageId, m.id);
  assert.equal(payload.deliveryId, init.headers['Idempotency-Key']);
  assert.match(payload.text, /Echo/);
  assert.deepEqual(payload.author, { id: 'alice', name: 'alice' });
  assert.match(payload.reply.key, /^[a-f0-9]{64}$/);
  assert.ok(!init.body.includes(secret));
  return Response.json({ text: '<script>not markup</script>' });
 });
 f.as('bob');
 assert.equal(await botDelivery.dispatchBotDelivery(f.ctx, m.id), false);
 assert.equal(mocked.mock.callCount(), 0);
 f.as('alice');
 assert.equal(await botDelivery.dispatchBotDelivery(f.ctx, m.id), true);
 assert.equal(await botDelivery.dispatchBotDelivery(f.ctx, m.id), false);
 assert.equal(mocked.mock.callCount(), 1);
 assert.equal(f.rows.botDeliveries[0].status, 'replied');
 const replies = f.rows.messages.filter(row => row.creatorId === f.personId);
 assert.equal(replies.length, 1);
 assert.equal(replies[0].parentId, m.id);
 assert.match(replies[0].body, /&lt;script&gt;/);
});

test('one-to-one bot DMs require opt-in and accept a delivery-scoped signed async reply', async t => {
 const f = await outgoingFixture();
 await assert.rejects(writes.startDirect(f.ctx, [f.personId]));
 await bots.updateBot(f.ctx, { id: f.bot.id, directMessages: true });
 await assert.rejects(writes.startDirect(f.ctx, [f.personId, 'bob']));
 const room = await writes.startDirect(f.ctx, [f.personId]);
 const message = await sendToBot(f, room.id, '<p>Private question</p>');
 let payload;
 t.mock.method(globalThis, 'fetch', async (_url, init) => {
  payload = JSON.parse(init.body);
  assert.equal((await botDelivery.botReply(f.ctx, signedReply(payload, 'Answer', 'wrong'))).status, 403);
  assert.equal((await botDelivery.botReply(f.ctx, signedReply(payload, 'Answer'))).status, 425);
  return new Response(null, { status: 202 });
 });
 await botDelivery.dispatchBotDelivery(f.ctx, message.id);
 assert.equal(payload.roomKind, 'direct');
 assert.equal((await botDelivery.botReply(f.ctx, signedReply(payload, 'Answer', 'wrong'))).status, 403);
 assert.equal((await botDelivery.botReply(f.ctx, signedReply(payload, 'Answer'))).status, 200);
 assert.equal((await botDelivery.botReply(f.ctx, signedReply(payload, 'Answer'))).status, 200);
 assert.equal((await botDelivery.botReply(f.ctx, signedReply(payload, 'Changed answer'))).status, 409);
 const replies = f.rows.messages.filter(row => row.creatorId === f.personId);
 assert.equal(replies.length, 1);
 assert.equal(replies[0].roomId, room.id);
 assert.equal(replies[0].parentId, '');
 assert.equal(f.rows.botDeliveries.length, 1);
 await bots.updateBot(f.ctx, { id: f.bot.id, enabled: false });
 assert.equal((await botDelivery.botReply(f.ctx, signedReply(payload, 'Answer'))).status, 403);
});

test('deleted or edited messages and revoked bot configuration stop queued deliveries', async t => {
 const f = await outgoingFixture();
 const mocked = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 204 }));
 const m = await sendToBot(f);
 await writes.editMessage(f.ctx, { messageId: m.id, body: '<p>Edited</p>' });
 await botDelivery.dispatchBotDelivery(f.ctx, m.id);
 assert.equal(f.rows.botDeliveries[0].status, 'canceled');
 const next = await writes.sendMessage(f.ctx, { roomId: 'public', clientMessageId: 'second', body: botMention(f.personId) });
 await bots.updateBot(f.ctx, { id: f.bot.id, secret: secret + 'replacement' });
 await botDelivery.dispatchBotDelivery(f.ctx, next.id);
 assert.equal(f.rows.botDeliveries[1].status, 'canceled');
 assert.equal(mocked.mock.callCount(), 0);
});

test('retryable deliveries keep their id and cron recovery requires a trusted trigger', async t => {
 const f = await outgoingFixture();
 const m = await sendToBot(f);
 const attempts = [];
 t.mock.method(globalThis, 'fetch', async (_url, init) => {
  attempts.push(init.headers['Idempotency-Key']);
  return new Response(null, { status: attempts.length === 1 ? 503 : 204 });
 });
 await botDelivery.dispatchBotDelivery(f.ctx, m.id);
 const [delivery] = f.rows.botDeliveries;
 assert.equal(delivery.status, 'queued');
 assert.equal(delivery.attempts, '1');
 await botDelivery.dispatchBotDelivery(f.ctx, m.id);
 assert.equal(attempts.length, 1);
 delivery.dueAt = new Date(0).toISOString();
 assert.equal((await botDelivery.recoverBotDelivery(f.ctx, { headers: new Headers() })).status, 404);
 f.ctx.env.EMBER_BOT_CRON_TOKEN = 'test-cron-token-placeholder-12345678';
 assert.equal((await botDelivery.recoverBotDelivery(f.ctx, { headers: new Headers({ Authorization: 'Bearer ' + f.ctx.env.EMBER_BOT_CRON_TOKEN }) })).status, 204);
 assert.deepEqual(attempts, [delivery.id, delivery.id]);
 assert.equal(delivery.status, 'done');
});

test('outgoing webhook URL accepts public HTTPS and refuses credentials, private hosts, and ambiguous authorities', () => {
 assert.equal(botDelivery.outgoingBotUrl('https://HOOKS.EXAMPLE.ORG?key=abc'), 'https://hooks.example.org/?key=abc');
 for (const url of ['http://example.org', 'https://localhost/', 'https://127.0.0.1/', 'https://foo.local/', 'https://name@example.org/', 'https://example.org:9999/', 'https://example.org\\@other.org', 'https://example.org/#part']) {
  assert.throws(() => botDelivery.outgoingBotUrl(url));
 }
});

const pushEndpoint = (token) => 'https://fcm.googleapis.com/fcm/send/fixture_token_' + token;
function pushFixture() {
 const f = fixture();
 // Public test-only scalar one. Tests inject a transport and never use this on a network.
 const scalar = Buffer.alloc(32);
 scalar[31] = 1;
 f.ctx.env.EMBER_PUSH_PRIVATE_KEY = scalar.toString('base64url');
 f.ctx.env.EMBER_PUSH_CONTACT = 'mailto:push@example.test';
 return f;
}
async function optIn(f, id, endpoint = pushEndpoint(id)) {
 const ctx = f.as(id);
 const { publicKey } = await push.pushSettings(ctx, null, id);
 assert.match(publicKey, /^[A-Za-z0-9_-]{87}$/);
 await push.savePush(ctx, { endpoint, expectedPersonId: id, publicKey });
 return endpoint;
}
const pushCron = (headers = {}) => ({ headers: new Headers(headers) });

test('push enrollment is active-member opt-in, device-bound, and private', async () => {
 const f = pushFixture();
 const endpoint = await optIn(f, 'bob');
 assert.equal((await push.pushSettings(f.ctx, endpoint, 'bob')).enabled, true);
 assert.equal((await push.pushSettings(f.as('alice'), endpoint, 'alice')).enabled, false);
 assert.equal(await push.removePush(f.ctx, { endpoint, expectedPersonId: 'alice' }), false);
 const { publicKey } = await push.pushSettings(f.ctx, endpoint, 'alice');
 const base = { endpoint, expectedPersonId: 'alice', publicKey };
 await assert.rejects(() => push.savePush(f.ctx, base), /another Ember account/);
 await assert.rejects(() => push.savePush(f.ctx, { ...base, expectedPersonId: 'bob' }), /account changed/);
 for (const bad of ['https://example.test/push/a', endpoint + '?bad=1']) {
  await assert.rejects(() => push.savePush(f.ctx, { ...base, endpoint: bad }), /unavailable/);
 }
 await assert.rejects(() => push.savePush(f.as('outsider'), base), /membership required/);
 const otherDevice = await optIn(f, 'bob', pushEndpoint('other-device'));
 const serialized = JSON.stringify(await push.pushSettings(f.as('bob'), endpoint, 'bob'));
 assert.ok(!serialized.includes(endpoint));
 assert.ok(!serialized.includes(f.ctx.env.EMBER_PUSH_PRIVATE_KEY));
 assert.ok(!serialized.includes(f.ctx.env.EMBER_PUSH_CONTACT));
 assert.equal(await push.removePush(f.ctx, { endpoint, expectedPersonId: 'bob' }), true);
 assert.equal((await push.pushSettings(f.ctx, endpoint, 'bob')).enabled, false);
 assert.equal((await push.pushSettings(f.ctx, otherDevice, 'bob')).enabled, true);
});

test('push only queues opted-in eligible recipients and retries never create extra deliveries', async () => {
 const f = pushFixture();
 const bob = await optIn(f, 'bob');
 await optIn(f, 'alice');
 await optIn(f, 'carol');
 const preference = f.rows.members.find((row) => row.personId === 'bob' && row.roomId === 'private');
 const attempted = [];
 const transport = async (url, options) => {
  attempted.push({ url, options });
  return new Response(null, { status: 201 });
 };
 assert.equal((await send({ ...f, ctx: f.as('alice') }, 'private')).pushDeliveryCount, 0);
 preference.involvement = 'everything';
 const m = await send(f, 'private', { clientMessageId: 'second' });
 assert.equal(m.pushDeliveryCount, 1);
 assert.equal((await send(f, 'private', { clientMessageId: 'second' })).pushDeliveryCount, 1);
 assert.equal(f.rows.pushDeliveries.length, 1);
 assert.equal(await push.dispatchPush(f.as('bob'), m.id, transport), false);
 assert.equal(await push.dispatchPush(f.as('alice'), m.id, transport), true);
 assert.equal(await push.dispatchPush(f.ctx, m.id, transport), false);
 assert.equal(attempted.length, 1);
 assert.equal(attempted[0].url, bob);
 assert.equal(attempted[0].options.credentials, 'omit');
 assert.equal(attempted[0].options.redirect, 'error');
 assert.equal(attempted[0].options.body, undefined);
 assert.doesNotMatch(JSON.stringify(attempted[0]), /hello|private/);
});

test('mentions, muted rooms, thread-only messages, and workspace membership determine eligibility', async () => {
 const f = pushFixture();
 await optIn(f, 'bob');
 await optIn(f, 'carol');
 const bobMembership = f.rows.members.find((row) => row.personId === 'bob' && row.roomId === 'private');
 const room = f.rows.rooms.find((row) => row.id === 'private');
 const message = {
  id: 'message', roomId: room.id, creatorId: 'alice', inRoom: false, deleted: false,
  mentions: JSON.stringify([{ id: 'bob' }, { id: 'carol' }]), createdAt: '2026-11-10T00:00:00.000Z',
 };
 assert.equal(await push.enqueuePush(f.ctx, room, message), 1);
 for (const state of ['nothing', 'invisible']) {
  bobMembership.involvement = state;
  assert.equal(await push.enqueuePush(f.ctx, room, message), 0);
 }
 bobMembership.involvement = 'everything';
 assert.equal(await push.enqueuePush(f.ctx, room, { ...message, mentions: '[]' }), 1);
 bobMembership.lastReadAt = message.createdAt;
 assert.equal(await push.enqueuePush(f.ctx, room, message), 0);
 assert.equal(await push.enqueuePush(f.ctx, f.rows.rooms.find((r) => r.id === 'public'), {
  ...message, roomId: 'public', inRoom: true, mentions: '[{"id":"carol"}]',
 }), 1);
 f.rows.people.find((row) => row.id === 'carol').status = 'banned';
 assert.equal(await push.enqueuePush(f.ctx, f.rows.rooms.find((r) => r.id === 'public'), {
  ...message, roomId: 'public', inRoom: true, mentions: '[{"id":"carol"}]',
 }), 0);
});

test('push recovery is gated, rechecks access, retries temporary failures, and drops dead endpoints', async () => {
 const f = pushFixture();
 await optIn(f, 'bob');
 const membership = f.rows.members.find((row) => row.roomId === 'private' && row.personId === 'bob');
 membership.involvement = 'everything';
 const m = await send({ ...f, ctx: f.as('alice') });
 const responses = [503, 410];
 const transport = async () => new Response(null, { status: responses.shift() });
 assert.equal((await push.recoverPush(f.ctx, pushCron(), transport)).status, 404);
 assert.equal(responses.length, 2);
 assert.equal(await push.dispatchPush(f.ctx, m.id, transport), true);
 assert.equal(f.rows.pushDeliveries[0].attempts, '1');
 assert.equal(await push.dispatchPush(f.ctx, m.id, transport), false);
 f.rows.pushDeliveries[0].dueAt = new Date(0).toISOString();
 assert.equal((await push.recoverPush(f.ctx, pushCron({ 'x-spacefast-cron': '1' }), transport)).status, 204);
 assert.equal(f.rows.pushDeliveries.length, 0);
 assert.equal(f.rows.pushSubscriptions.length, 0);

 await optIn(f, 'bob');
 const again = await send({ ...f, ctx: f.as('alice') }, 'private', { clientMessageId: 'revoke' });
 await f.ctx.db.members.delete(membership.id);
 let forbiddenCalls = 0;
 const forbiddenTransport = async () => { forbiddenCalls++; return new Response(null, { status: 201 }); };
 assert.equal(await push.dispatchPush(f.ctx, again.id, forbiddenTransport), true);
 assert.equal(forbiddenCalls, 0);
 assert.equal(f.rows.pushDeliveries.length, 0);
});

test('unconfigured push exposes no key and never queues messages', async () => {
 const f = fixture();
 assert.deepEqual(await push.pushSettings(f.ctx, null, 'alice'), { publicKey: null, enabled: false, needsRefresh: false });
 assert.equal((await send(f)).pushDeliveryCount, 0);
 assert.equal(f.rows.pushDeliveries.length, 0);
});

test('push skips room and recipient scans until a device is enrolled', async () => {
 const f = pushFixture();
 const room = f.rows.rooms[0];
 f.ctx.db.members.withIndex = () => assert.fail('An empty push workspace should not scan membership');
 assert.equal(await push.enqueuePush(f.ctx, room, { id: 'empty', deleted: false }), 0);
});

test('offboarding revokes that member’s devices and reactivation does not re-enroll them', async () => {
 const f = pushFixture();
 const first = await optIn(f, 'bob');
 await optIn(f, 'bob', pushEndpoint('other-device'));
 const remaining = await optIn(f, 'carol');
 await writes.updatePerson(f.as('alice'), { personId: 'bob', status: 'deactivated' });
 assert.deepEqual(f.rows.pushSubscriptions.map((device) => device.endpoint), [remaining]);
 await writes.updatePerson(f.ctx, { personId: 'bob', status: 'active' });
 assert.equal((await push.pushSettings(f.as('bob'), first, 'bob')).enabled, false);
});

test('verified exact-domain signup uses only server claims and creates an ordinary member', async () => {
 const f = fixture('new');
 f.rows.accounts[0].joinLink = false;
 f.ctx.auth.email = 'new+work@EXAMPLE.TEST';
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.canJoinByEmailDomain, false);
 assert.equal((await writes.join(f.ctx, {name:'New'})).ok, false);

 f.ctx.env.EMBER_SIGNUP_EMAIL_DOMAINS = ' other.test, Example.Test ';
 const before = await views.bootstrap(f.ctx);
 assert.equal(before.nativeAuth.canJoinByEmailDomain, true);
 assert.doesNotMatch(JSON.stringify(before), /other\.test/i);
 assert.equal(before.user, null);
 await assert.rejects(() => views.sidebar(f.ctx), /membership required/);

 const result = await writes.join(f.ctx, {name:'New', role:'administrator'});
 assert.equal(result.administrator, false);
 assert.equal(f.rows.people.at(-1).identityId, 'new');
 assert.equal(f.rows.people.at(-1).role, 'member');
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.canJoinByEmailDomain, false);
 delete f.ctx.env.EMBER_SIGNUP_EMAIL_DOMAINS;
 assert.equal((await writes.join(f.ctx, {name:'New'})).id, result.id);
 assert.equal(f.rows.people.length, 4);
});

test('domain signup fails closed on missing, unverified, malformed, and lookalike claims', async () => {
 const f = fixture('new');
 f.ctx.env.EMBER_SIGNUP_EMAIL_DOMAINS = 'example.test';
 const input = {name:'New', email:'forged@example.test', emailVerified:true};
 const claims = [
  [undefined, true],
  ['new@example.test', undefined],
  ['new@example.test', false],
  ['new@example.test', 'true'],
  ['new@sub.example.test', true],
  ['new@notexample.test', true],
  ['new@example.test.other.test', true],
  ['new@other.test@example.test', true],
  ['new@example.test\n', true],
  ['@example.test', true],
  ['new@examplé.test', true],
 ];
 for (const [email, verified] of claims) {
  f.ctx.auth.email = email;
  f.ctx.auth.emailVerified = verified;
  assert.equal((await views.bootstrap(f.ctx)).nativeAuth.canJoinByEmailDomain, false, String(email));
  assert.equal((await writes.join(f.ctx, input)).ok, false, String(email));
 }
 f.ctx.auth.email = 'new@example.test';
 f.ctx.auth.emailVerified = true;
 f.ctx.env.EMBER_SIGNUP_EMAIL_DOMAINS = '*.example.test,@example.test,https://example.test';
 assert.equal((await writes.join(f.ctx, input)).ok, false);
 f.ctx.env.EMBER_SIGNUP_EMAIL_DOMAINS = 'example.test';
 f.ctx.auth.isSignedIn = false;
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.canJoinByEmailDomain, false);
 await assert.rejects(() => writes.join(f.ctx, input), /Sign in required/);
 assert.equal(f.rows.people.length, 3);
});

test('domain signup preserves invitation priority, inactive membership, join codes, and open signup', async () => {
 const f = fixture('bob');
 const workspace = f.rows.accounts[0];
 f.ctx.env.EMBER_SIGNUP_EMAIL_DOMAINS = 'example.test';
 f.rows.people.find(p => p.id === 'bob').status = 'deactivated';
 assert.equal((await views.bootstrap(f.ctx)).nativeAuth.canJoinByEmailDomain, false);
 assert.match((await writes.join(f.ctx, {})).message, /access is inactive/);

 f.as('new');
 workspace.openSignUp = true;
 assert.equal((await writes.join(f.ctx, {invitationToken:'invalid'})).ok, false);
 assert.equal(f.rows.people.length, 3);

 workspace.openSignUp = false;
 workspace.joinLink = true;
 workspace.joinCodeHash = await f.ctx.crypto.sha256('join-code');
 f.ctx.auth.emailVerified = false;
 assert.equal((await writes.join(f.ctx, {joinCode:'wrong-code'})).ok, false);
 assert.equal((await writes.join(f.ctx, {joinCode:'join-code'})).administrator, false);

 f.as('open');
 delete f.ctx.auth.email;
 workspace.openSignUp = true;
 workspace.joinLink = false;
 assert.equal((await writes.join(f.ctx, {})).administrator, false);
});
