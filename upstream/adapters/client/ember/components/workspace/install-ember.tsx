import { useSyncExternalStore } from 'react';
import { useMediaQuery } from '../../hooks/use-media-query';
import { canInstall, promptInstall, subscribeToInstallPrompt } from '../../lib/install-prompt';
import { Button } from '../ui/button';

export function InstallEmber() {
  const canPrompt = useSyncExternalStore(subscribeToInstallPrompt, canInstall);
  const standalone = useMediaQuery('(display-mode: standalone)');
  if (standalone || (navigator as Navigator & { standalone?: boolean }).standalone) return null;

  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const macSafari = /Macintosh/.test(navigator.userAgent)
    && /Safari/.test(navigator.userAgent) && !/Chrome|Chromium|Firefox|Edg/.test(navigator.userAgent);

  return (
    <section className="mt-8 space-y-3 border-t pt-6" aria-labelledby="install-ember-heading">
      <h2 id="install-ember-heading" className="text-base font-semibold">Install Ember</h2>
      {canPrompt ? (
        <Button variant="outline" onClick={promptInstall}>Install app</Button>
      ) : (
        <p className="text-sm text-muted-foreground">
          {ios ? 'In Safari, open Share and tap Add to Home Screen. Turn on Open as Web App if it appears, then tap Add.'
            : macSafari ? 'In Safari, choose File, then Add to Dock.'
              : 'Open your browser menu and look for Install Ember or Add to Home screen.'}
        </p>
      )}
    </section>
  );
}
