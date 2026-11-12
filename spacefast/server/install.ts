import { json } from '@spacefast/zero/server';

export function webAppManifest() {
  return json({
    id: '/',
    name: 'Ember',
    short_name: 'Ember',
    description: 'Team chat with rooms, direct messages, and threads.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    icons: [
      { src: '/assets/ember-icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/assets/ember-icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  }, { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' } });
}
