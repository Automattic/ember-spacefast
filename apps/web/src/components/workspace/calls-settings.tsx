import { useState } from "react";
import type { WorkspaceSettings } from "@ember/protocol";
import { Switch } from "@/components/ui/switch";
import { useMounted } from "@/hooks/use-mounted";
import { forgetCalls, isSignedOut } from "@/lib/api";
import { BUTTON } from "./email-settings";

// The Calls card in Rooms and permissions, for administrators: whether Ember has what calls run through,
// which is Cloudflare's Realtime SFU, by an SFU app in the Cloudflare account of whoever runs Ember, whose
// keys an administrator gives it. Its switch says whether it has, as Turnstile's does. Turning it on
// opens Set up calls (`CallsSetup`), as switches open setup that's missing, as the project's owner asked
// (2026-10-26), and turning it off forgets the app's keys. Change keys opens the setup with the app's ID
// as it is. Until rooms have calls, which the changes after this one bring, the card says that nobody
// can call yet.

/** What the card says of calls while they're off. */
export const CALLS_EXPLAINED =
  "Calls let people in a room talk to each other. They run through Cloudflare's Realtime SFU, with an app in your Cloudflare account.";

/** What the card says until rooms have calls: for now it only keeps the app's keys. */
export const CALLS_COMING = "People can't call each other yet. That comes in a later update, and the app's keys wait here until then.";

/** What turning calls off asks first. */
export const CONFIRM_STOP_CALLS = "Are you sure you want to turn off calls? Ember will forget the SFU app's keys.";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  calls: WorkspaceSettings["calls"];
  /** Opens Set up calls. */
  onSetUp: () => void;
  /** Shows that calls are off, once turning them off has forgotten the app's keys. */
  onStopped: () => void;
  /** Says why turning them off failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Whether calls are on, for administrators, and through which SFU app they run, or else what calls would add. */
export function CallsSettings({ calls, onSetUp, onStopped, onFailed }: Props) {
  const [stopping, setStopping] = useState(false);
  const mounted = useMounted();

  const stop = () => {
    if (!confirm(CONFIRM_STOP_CALLS)) return;
    setStopping(true);
    forgetCalls().then(
      () => {
        onStopped();
        if (mounted.current) setStopping(false);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setStopping(false);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="calls-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h3 id="calls-heading" className="text-base font-semibold">
            Calls
          </h3>
          <p id="calls-description" className={NOTE}>
            {calls === null ? (
              CALLS_EXPLAINED
            ) : (
              <>
                Calls run through the Realtime SFU app <strong className="font-semibold wrap-anywhere">{calls.appId}</strong> in your Cloudflare account.
              </>
            )}
          </p>
          <p className={NOTE}>{CALLS_COMING}</p>
        </div>
        <Switch
          checked={calls !== null && !stopping}
          onCheckedChange={(on) => (on ? onSetUp() : stop())}
          disabled={stopping}
          aria-labelledby="calls-heading"
          aria-describedby="calls-description"
        />
      </div>
      {calls !== null && (
        <div>
          <button type="button" onClick={onSetUp} disabled={stopping} className={BUTTON}>
            Change keys
          </button>
        </div>
      )}
    </section>
  );
}
