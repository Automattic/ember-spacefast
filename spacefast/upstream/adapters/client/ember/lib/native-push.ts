const workerPath = '/service-worker.js';
let generation = 0;

export function canUsePush() {
  return window.isSecureContext && 'serviceWorker' in navigator && 'Notification' in window && 'PushManager' in window;
}

export async function currentPush() {
  if (!canUsePush()) return null;
  const registration = await navigator.serviceWorker.getRegistration('/');
  if (registration?.active?.scriptURL !== new URL(workerPath, location.origin).href) return null;
  return registration.pushManager.getSubscription();
}

function applicationKey(publicKey: string) {
  return Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (character) => character.charCodeAt(0));
}

async function activePushWorker() {
  const registration = await navigator.serviceWorker.register(workerPath, { scope: '/' });
  if (registration.active) return registration;
  const worker = registration.installing ?? registration.waiting;
  if (!worker) throw new Error('Ember could not start notifications.');
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => finish(new Error('Ember could not start notifications. Try again.')), 10_000);
    function finish(error?: Error) {
      window.clearTimeout(timer);
      worker!.removeEventListener('statechange', onState);
      if (error) reject(error);
      else resolve();
    }
    function onState() {
      if (worker!.state === 'activated') finish();
      if (worker!.state === 'redundant') finish(new Error('Ember could not start notifications.'));
    }
    worker.addEventListener('statechange', onState);
    onState();
  });
  return registration;
}

type SubscriptionChange = (endpoint: string) => Promise<unknown>;

export async function enableBrowserPush(publicKey: string, save: SubscriptionChange) {
  const attempt = ++generation;
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') throw new Error('Allow notifications in your browser settings, then try again.');
  if (attempt !== generation) return null;
  const registration = await activePushWorker();
  if (attempt !== generation) return null;
  const previous = await registration.pushManager.getSubscription();
  if (attempt !== generation) return null;
  if (previous) await previous.unsubscribe();
  if (attempt !== generation) return null;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationKey(publicKey),
  });
  if (attempt !== generation) {
    await subscription.unsubscribe().catch(() => false);
    return null;
  }
  try {
    await save(subscription.endpoint);
    return attempt === generation ? subscription.endpoint : null;
  } catch (error) {
    await subscription.unsubscribe().catch(() => false);
    throw error;
  }
}

export async function disableBrowserPush(remove: SubscriptionChange) {
  generation += 1;
  const subscription = await currentPush();
  if (!subscription) return;
  const requireSuccess = (result: unknown) => {
    if (result !== true) throw new Error('Subscription was not removed.');
  };
  try {
    await Promise.any([
      remove(subscription.endpoint).then(requireSuccess),
      subscription.unsubscribe().then(requireSuccess),
    ]);
  } catch {
    throw new Error('Ember could not turn off notifications. Try again.');
  }
}
