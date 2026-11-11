import { useCallback, useEffect, useState } from "react";
import type { ReleaseCheck } from "@ember/protocol";
import { checkForRelease, checkForReleaseAfresh } from "@/lib/api";
import { whenIdle } from "@/lib/idle";

/** What the Worker says of Ember's releases, and Check for updates, which asks it afresh. */
export interface ReleaseChecking {
  /** The release this Ember is and the newest one GitHub names, or null until the Worker answers, and for anyone but an administrator. */
  check: ReleaseCheck | null;
  /** Has the Worker ask GitHub again, as Check for updates does, settling once it's answered, or failing as asking failed. */
  checkAgain: () => Promise<void>;
}

/**
 * For an administrator, the release this Ember is and the newest one GitHub names, which the Worker is
 * asked for once the page is `ready` and the browser is idle, and again for someone made an
 * administrator. Each time they open Admin (`inAdmin` on every page of community settings) it's asked
 * afresh, having the Worker ask GitHub again, as the project's owner asked (2026-11-05), though going on
 * to another of its pages, or leaving it, asks nothing. Check for updates, which he asked for too
 * (2026-11-11), asks afresh at once. Null until it answers, and for anyone else, or when asking fails,
 * which nothing but Check for updates waits on.
 */
export function useReleaseCheck(administrator: boolean, ready: boolean, inAdmin: boolean): ReleaseChecking {
  const [check, setCheck] = useState<ReleaseCheck | null>(null);
  // How many times Admin has opened since the page loaded.
  const [admin, setAdmin] = useState({ open: inAdmin, openings: 0 });
  if (admin.open !== inAdmin) setAdmin({ open: inAdmin, openings: admin.openings + (inAdmin ? 1 : 0) });
  const asking = administrator && ready;
  // Each of the Worker's isolates keeps what GitHub told it, so an answer that heard from GitHub before
  // the one kept, as opening Admin's can, answering after Check for updates', changes nothing.
  const heard = useCallback((answer: ReleaseCheck) => setCheck((kept) => (kept && heardBefore(answer, kept) ? kept : answer)), []);
  // Not run for `inAdmin` itself, so that leaving Admin doesn't ask, but whenever this runs in Admin, it's
  // for opening it, or for the page becoming ready, or someone made an administrator, there.
  useEffect(() => {
    if (!asking) return;
    let current = true;
    const ask = inAdmin ? checkForReleaseAfresh : checkForRelease;
    const cancel = whenIdle(
      () =>
        void ask().then(
          (answer) => current && heard(answer),
          () => {},
        ),
    );
    return () => {
      current = false;
      cancel();
    };
  }, [asking, admin.openings]);
  const checkAgain = useCallback(() => checkForReleaseAfresh().then(heard), [heard]);
  return { check: administrator ? check : null, checkAgain };
}

/** Whether `answer` heard from GitHub before `kept` did, as the release each names says. */
const heardBefore = (answer: ReleaseCheck, kept: ReleaseCheck) => (answer.checkedAt ?? "") < (kept.checkedAt ?? "");
