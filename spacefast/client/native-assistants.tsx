import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from './native-sdk';
import { Button } from './ember/components/ui/button';

type Room = { id: string; name: string; kind: string };
type Profile = { id: string; handle: string; name: string; instructions: string; roomIds: string[]; enabled: boolean; includeThreadRoot: boolean; directMessages: boolean };
type Settings = { ready: boolean; enabled: boolean; profiles: Profile[] };
const field = 'mt-1 block w-full rounded-md border bg-background p-3';

export function NativeAssistants({ rooms }: { rooms: Room[] }) {
 const settings = useQuery<Settings>('assistants');
 const toggle = useMutation('setAssistants');
 const save = useMutation('saveAssistant');
 const [edit, setEdit] = useState<string>();
 const [busy, setBusy] = useState(false);
 const [error, setError] = useState('');
 const [notice, setNotice] = useState('');
 const editTrigger = useRef<HTMLButtonElement | null>(null);
 const saveButton = useRef<HTMLButtonElement | null>(null);
 useEffect(() => {
  if (error && edit) saveButton.current?.scrollIntoView({ block: 'nearest' });
 }, [error, edit]);
 const closeEdit = () => {
  editTrigger.current?.focus();
  setEdit(undefined);
  setError('');
 };
 const toggleEdit = (id: string, button: HTMLButtonElement) => {
  if (busy) return;
  if (edit === id) {
   closeEdit();
   return;
  }
  editTrigger.current = button;
  setError('');
  setEdit(id);
 };

 if (!settings) return <p role="status">Loading AI assistants…</p>;
 const profile = settings.profiles.find(item => item.id === edit);
 const perform = async (action: () => Promise<unknown>, success: string) => {
  if (busy) return;
  setBusy(true);
  setError('');
  setNotice('');
  try { await action(); setNotice(success); }
  catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the assistant settings.'); }
  finally { setBusy(false); }
 };
 const saveProfile = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  void perform(async () => {
   await save({
    ...(profile ? { id: profile.id } : {}),
    handle: data.get('handle'), name: data.get('name'), instructions: data.get('instructions'),
    roomIds: data.getAll('roomIds'), enabled: data.has('enabled'),
    includeThreadRoot: data.has('includeThreadRoot'), directMessages: data.has('directMessages'),
   });
   closeEdit();
  }, 'Assistant saved.');
 };

 return <section className="space-y-5">
  <h2 className="text-xl font-semibold">AI assistants</h2>
  <p className="text-sm text-muted-foreground">Ember sends the triggering message as text to OpenAI when someone mentions an enabled assistant in an assigned room or sends it an allowed one-to-one direct message. For room threads, you can also allow up to 1,000 characters of the original thread message.</p>
  <p className="text-sm text-muted-foreground">OpenAI temporarily stores requests while generating replies. Ember sends no attachments, room history, or profile details. API usage is billed to the connected OpenAI project.</p>
  <div className="flex flex-wrap items-center gap-3">
   <Button disabled={!settings.ready && !settings.enabled} aria-disabled={busy || undefined} onClick={() => void perform(async () => { await toggle({ enabled: !settings.enabled }); if (settings.enabled && edit) closeEdit(); }, settings.enabled ? 'AI assistants disabled.' : 'AI assistants enabled.')}>
    {settings.enabled ? 'Disable AI assistants' : 'Enable AI assistants'}
   </Button>
   {!settings.ready && <p className="text-sm text-muted-foreground">The workspace owner needs to connect OpenAI.</p>}
  </div>
  {settings.enabled && <>
   <ul className="divide-y border-y">
    {settings.profiles.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
     <div>
      <p className="font-medium wrap-anywhere">{item.name} <span className="text-sm font-normal text-muted-foreground">@{item.handle}</span></p>
      <p className="text-sm text-muted-foreground">{item.enabled ? 'Enabled' : 'Disabled'} · {item.roomIds.length} {item.roomIds.length === 1 ? 'room' : 'rooms'}{item.directMessages ? ' · Direct messages enabled' : ''}</p>
     </div>
     <Button variant="outline" aria-disabled={busy || undefined} aria-expanded={edit === item.id} aria-label={'Edit ' + item.name} onClick={event => toggleEdit(item.id, event.currentTarget)}>Edit</Button>
    </li>)}
   </ul>
   <Button variant="outline" disabled={settings.profiles.length >= 20} aria-disabled={busy || undefined} aria-expanded={edit === 'new'} onClick={event => toggleEdit('new', event.currentTarget)}>Add assistant</Button>
   {edit && <form key={edit} className="space-y-4 rounded-md border p-4" onSubmit={saveProfile}>
    <h3 className="font-medium">{profile ? 'Edit ' + profile.name : 'New assistant'}</h3>
    <label className="block text-sm">Display name<input className={field} name="name" maxLength={60} required autoFocus defaultValue={profile?.name} /></label>
    <label className="block text-sm">Handle<input className={field} name="handle" pattern="[a-zA-Z][a-zA-Z0-9\-]{0,31}" required defaultValue={profile?.handle} readOnly={profile?.handle === 'ember'} /></label>
    <label className="block text-sm">Instructions<textarea className={field} name="instructions" rows={4} maxLength={2000} required defaultValue={profile?.instructions} /></label>
    <fieldset>
     <legend className="mb-2 text-sm font-medium">Allowed rooms</legend>
     <div className="flex flex-wrap gap-x-6 gap-y-2">
      {rooms.filter(room => room.kind !== 'direct').map(room => <label key={room.id} className="flex min-w-0 items-start gap-2 text-sm">
       <input type="checkbox" name="roomIds" value={room.id} defaultChecked={profile?.roomIds.includes(room.id)} /><span className="wrap-anywhere">{room.name}</span>
      </label>)}
     </div>
    </fieldset>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="includeThreadRoot" defaultChecked={profile?.includeThreadRoot} />Include the original message when mentioned in a room thread</label>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="directMessages" defaultChecked={profile?.directMessages} />Allow one-to-one direct messages</label>
    <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="enabled" defaultChecked={profile?.enabled} />Enable this assistant</label>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
     <Button ref={saveButton} aria-disabled={busy || undefined} aria-busy={busy || undefined}>Save assistant</Button>
     <Button type="button" variant="outline" aria-disabled={busy || undefined} onClick={() => { if (!busy) closeEdit(); }}>Cancel</Button>
    </div>
   </form>}
  </>}
  {!edit && error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  <p role="status" className="empty:hidden text-sm">{notice}</p>
 </section>;
}
