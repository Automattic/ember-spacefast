import { listenForInstallPrompt } from './install-prompt';

export function initializeWebAppInstallation() {
  listenForInstallPrompt();

  const links = {
    manifest: '/manifest.webmanifest',
    'apple-touch-icon': '/assets/ember-touch-icon.png',
  };

  for (const [rel, href] of Object.entries(links)) {
    if (document.head.querySelector(`link[rel="${rel}"]`)) continue;
    const link = document.createElement('link');
    link.rel = rel;
    link.href = href;
    if (rel === 'manifest') link.crossOrigin = 'use-credentials';
    document.head.append(link);
  }
}
