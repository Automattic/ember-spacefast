import { useRef, useState } from 'react';
import { useQuery, useMutation } from './native-sdk';
import { Button } from './ember/components/ui/button';

const newSecret = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
const inputClass = 'mt-1 block w-full rounded-md border bg-background p-3';
const invalidUrlMessage = 'Enter a public HTTPS webhook URL.';
type Room = { id: string; name: string; kind: string };
type Bot = { id: string; name: string; roomIds: string[]; enabled: boolean; outgoingReady: boolean; outgoingUrl: string; directMessages: boolean };

function DeliveryFields({ bot, error, onChange }: { bot?: Bot; error?: string; onChange: () => void }) {
 const errorId = bot ? 'edit-webhook-url-error' : 'create-webhook-url-error';
 return <>
  <label className="block text-sm font-medium">
   Reply webhook URL
   <input name="outgoingUrl" type="url" placeholder="https://" defaultValue={bot?.outgoingUrl} maxLength={2048} className={inputClass} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} onInput={error ? onChange : undefined} />
  </label>
  {error && <p id={errorId} role="alert" className="text-sm text-destructive">{error}</p>}
  <label className="flex items-center gap-2 text-sm">
   <input name="directMessages" type="checkbox" defaultChecked={bot?.directMessages} />
   Allow one-to-one direct messages to this bot
  </label>
 </>;
}

function deliverySettings(data: FormData) {
 return { outgoingUrl: String(data.get('outgoingUrl') ?? ''), directMessages: data.get('directMessages') === 'on' };
}

function RoomFields({ rooms, bot }: { rooms: Room[]; bot?: Bot }) {
 return <fieldset>
  <legend className="mb-2 text-sm font-medium">Rooms</legend>
  <div className="flex flex-wrap gap-x-6 gap-y-3">
   {rooms.filter(room => room.kind !== 'direct').map(room =>
    <label key={room.id} className="flex items-center gap-2 text-sm">
     <input name="roomIds" value={room.id} type="checkbox" defaultChecked={bot?.roomIds.includes(room.id)} />
     {room.name}
    </label>)}
  </div>
 </fieldset>;
}

export function NativeWebhooks({ rooms }: { rooms: Room[] }) {
 const bots = useQuery<Bot[]>('bots');
 const create = useMutation('createBot');
 const update = useMutation('updateBot');
 const [notice, setNotice] = useState('');
 const [urls, setUrls] = useState<string[]>([]);
 const [busy, setBusy] = useState(false);
 const [editing, setEditing] = useState('');
 const [formError, setFormError] = useState<{ form: string; text: string }>();
 const [savedRow, setSavedRow] = useState('');
 const clearError = () => setFormError(undefined);
 const editButton = useRef<HTMLButtonElement | null>(null);
 const closeEdit = () => {
  editButton.current?.focus();
  setEditing('');
  setFormError(undefined);
 };
 const reveal = (id: string, roomIds: string[], secret: string) =>
  setUrls(roomIds.map(roomId => `${location.origin}/webhooks/${encodeURIComponent(id)}/${encodeURIComponent(roomId)}/${secret}/slack`));
 const perform = async (operation: () => Promise<void>, form?: string) => {
  setBusy(true);
  setNotice('');
  setFormError(undefined);
  try { await operation(); }
  catch (error) {
   const text = error instanceof Error ? error.message : 'Could not save the webhook.';
   if (form) setFormError({ form, text });
   else setNotice(text);
  }
  finally { setBusy(false); }
 };
 const errorFor = (form: string) => formError?.form === form ? formError.text : undefined;
 const createError = errorFor('create');

 return <section className="mt-8 border-t pt-6">
  <h2 className="mb-2 text-xl font-semibold">Webhook bots</h2>
  <p className="mb-4 text-sm text-muted-foreground">Post Slack-compatible messages into selected rooms. If you add a reply webhook, Ember sends messages that mention the bot in those rooms to its URL. Allow direct messages only if you trust the webhook provider with private messages.</p>
  <form className="space-y-4" onSubmit={event => {
   event.preventDefault();
   const form = event.currentTarget;
   const data = new FormData(form);
   void perform(async () => {
    const secret = newSecret();
    const result = await create({ name: String(data.get('name')), roomIds: data.getAll('roomIds').map(String), secret, ...deliverySettings(data) }) as Bot;
    reveal(result.id, result.roomIds, secret);
    form.reset();
    setNotice('Webhook created. Save its private posting URLs now.');
   }, 'create');
  }}>
   <label className="block text-sm font-medium">Webhook name<input name="name" required maxLength={80} className={inputClass} /></label>
   <RoomFields rooms={rooms} />
   <DeliveryFields error={createError === invalidUrlMessage ? createError : undefined} onChange={clearError} />
   <Button disabled={busy}>Create webhook</Button>
   {createError && createError !== invalidUrlMessage && <p role="alert" className="text-sm text-destructive">{createError}</p>}
  </form>
  <p role="status" className="mt-4 text-sm">{notice}</p>
  {urls.length > 0 && <div className="mt-4 space-y-3 rounded-md border p-4">
   <p className="text-sm font-medium">Anyone with one of these private URLs can post in its room.</p>
   {urls.map(url => <label key={url} className="block text-sm">Webhook URL<input value={url} readOnly onFocus={event => event.currentTarget.select()} className="mt-1 w-full rounded-md border bg-background p-3 font-mono text-xs" /></label>)}
   <Button variant="outline" onClick={() => setUrls([])}>Hide URLs</Button>
  </div>}
  <ul className="mt-5 divide-y">{bots?.map(bot => {
   const editError = errorFor(bot.id);
   return <li key={bot.id} className="space-y-3 py-4">
   <div className="flex flex-wrap items-center justify-between gap-3">
    <div>
     <p className="font-medium">{bot.name}</p>
     <p className="text-sm text-muted-foreground">{bot.enabled ? 'Enabled' : 'Disabled'} · {bot.roomIds.length} {bot.roomIds.length === 1 ? 'room' : 'rooms'}{bot.outgoingUrl && (bot.outgoingReady ? ' · Replies configured' : ' · Replies need hosting setup')}</p>
    </div>
    <div className="flex flex-wrap gap-2">
     <Button variant="outline" aria-expanded={editing === bot.id} ref={editing === bot.id ? editButton : undefined} aria-disabled={busy || undefined} onClick={() => {
      if (busy) return;
      if (editing === bot.id) closeEdit();
      else {
       setEditing(bot.id);
       setFormError(undefined);
      }
      setSavedRow('');
     }}>{editing === bot.id ? 'Cancel' : 'Edit'}</Button>
     <Button variant="outline" disabled={busy} onClick={() => void perform(async () => { await update({ id: bot.id, enabled: !bot.enabled }); })}>{bot.enabled ? 'Disable' : 'Enable'}</Button>
     <Button variant="outline" disabled={busy} onClick={() => {
      if (!confirm('Replace the private URLs for ' + bot.name + '? Existing URLs will stop working.')) return;
      void perform(async () => {
       const secret = newSecret();
       await update({ id: bot.id, secret });
       reveal(bot.id, bot.roomIds, secret);
       setNotice('Webhook key replaced. Save the new URLs now.');
      });
     }}>Replace key</Button>
    </div>
   </div>
   <p role="status" className="empty:hidden text-sm">{savedRow === bot.id ? 'Webhook settings saved.' : ''}</p>
   {editing === bot.id && <form className="space-y-3 rounded-md border p-4" onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const roomIds = new Set(data.getAll('roomIds').map(String));
    // Preserve assigned rooms absent from the current administrator's sidebar.
    for (const roomId of bot.roomIds) if (!rooms.some(room => room.id === roomId)) roomIds.add(roomId);
    void perform(async () => {
     await update({ id: bot.id, name: String(data.get('name')), roomIds: [...roomIds], ...deliverySettings(data) });
     closeEdit();
     setSavedRow(bot.id);
    }, bot.id);
   }}>
    <label className="block text-sm font-medium">Webhook name<input name="name" defaultValue={bot.name} autoFocus required maxLength={80} className={inputClass} /></label>
    <RoomFields rooms={rooms} bot={bot} />
    <DeliveryFields bot={bot} error={editError === invalidUrlMessage ? editError : undefined} onChange={clearError} />
    <Button disabled={busy}>Save webhook settings</Button>
    {editError && editError !== invalidUrlMessage && <p role="alert" className="text-sm text-destructive">{editError}</p>}
   </form>}
  </li>;
  })}</ul>
 </section>;
}
