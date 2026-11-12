import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '../../../native-sdk';
import { canUsePush, currentPush, disableBrowserPush, enableBrowserPush } from '../../lib/native-push';
import { Button } from '../ui/button';

export function ProfilePush({ personId }: { personId: string }) {
  const [endpoint, setEndpoint] = useState<string | null | undefined>();
  const settings = useQuery<{ publicKey: string | null; enabled: boolean; needsRefresh: boolean }>('pushSettings', endpoint ?? null, personId);
  const save = useMutation('savePush');
  const remove = useMutation('removePush');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [permission, setPermission] = useState(() => canUsePush() ? Notification.permission : null);
  const lastSettings = useRef(settings);
  if (settings) lastSettings.current = settings;
  const displayedSettings = settings ?? lastSettings.current;
  const publicKey = displayedSettings?.publicKey;
  const enabled = Boolean(endpoint && displayedSettings?.enabled);
  const supported = canUsePush();
  const blocked = permission === 'denied' && (!enabled || displayedSettings?.needsRefresh);
  const unavailable = busy || endpoint === undefined || !settings || blocked;

  useEffect(() => {
    if (!supported) return;
    const refreshPermission = () => setPermission(Notification.permission);
    document.addEventListener('visibilitychange', refreshPermission);
    return () => document.removeEventListener('visibilitychange', refreshPermission);
  }, [supported]);

  useEffect(() => {
    let current = true;
    void currentPush().then((subscription) => {
      if (current) setEndpoint(subscription?.endpoint ?? null);
    }).catch(() => {
      if (!current) return;
      setEndpoint(null);
      setNotice('Ember could not check notifications for this browser.');
    });
    return () => { current = false; };
  }, [personId]);

  async function change() {
    if (unavailable || !settings) return;
    setBusy(true);
    setNotice('');
    try {
      if (enabled && !settings.needsRefresh) {
        await disableBrowserPush((subscription) => remove({ endpoint: subscription, expectedPersonId: personId }));
        setEndpoint(null);
        setNotice('Notifications turned off for this browser.');
      } else if (publicKey) {
        if (settings.needsRefresh && endpoint) await remove({ endpoint, expectedPersonId: personId });
        const subscription = await enableBrowserPush(publicKey, (value) => save({ endpoint: value, expectedPersonId: personId, publicKey }));
        if (subscription) {
          setEndpoint(subscription);
          setNotice('Notifications turned on for this browser.');
        }
      }
    } catch (error) {
      if (!supported || Notification.permission !== 'denied') {
        setNotice(error instanceof Error ? error.message : 'Ember could not change notifications. Try again.');
      }
    } finally {
      if (supported) setPermission(Notification.permission);
      setBusy(false);
    }
  }

  return <section className="mt-8 space-y-3 border-t pt-6" aria-labelledby="profile-notifications">
    <h2 id="profile-notifications" className="text-lg font-semibold">Notifications</h2>
    <p className="text-sm text-muted-foreground">Get an activity alert based on your room notification settings. Alerts keep message details private.</p>
    {!supported && <p className="text-sm">Use a browser that supports push notifications. On iPhone or iPad, add Ember to your Home Screen first.</p>}
    {supported && settings && !publicKey && <p className="text-sm">Browser notifications are unavailable in this workspace.</p>}
    {blocked && <p className="text-sm" id="profile-notifications-blocked">Allow notifications for Ember in your browser settings to turn them on.</p>}
    {supported && (publicKey || enabled) && <Button type="button" variant="outline" className="aria-disabled:opacity-50"
      aria-busy={busy} aria-disabled={unavailable} aria-describedby={blocked ? 'profile-notifications-blocked' : undefined} onClick={change}>
      {busy ? 'Changing notifications…' : displayedSettings?.needsRefresh ? 'Refresh notifications' : enabled ? 'Turn off notifications' : 'Turn on notifications'}
    </Button>}
    <p className="text-sm" role="status">{notice}</p>
  </section>;
}
