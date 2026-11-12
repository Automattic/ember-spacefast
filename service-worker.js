self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('Ember', {
    body: 'New activity in Ember.',
    icon: '/assets/ember-icon-192.png',
    tag: 'ember-activity',
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const root = new URL('/', self.location.origin).href;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => client.url === root);
    if (existing) await existing.focus();
    else await self.clients.openWindow(root);
  })());
});
