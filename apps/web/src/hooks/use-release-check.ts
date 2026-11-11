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
  // Each of the Worker's isolates keeps what GitHub told it, so answers can disagree, and opening Admin's
  // can answer after Check for updates'.
  const heard = useCallback((answer: ReleaseCheck) => setCheck((kept) => (kept && keeps(kept, answer) ? kept : answer)), []);
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

/**
 * Whether the answer `kept` stands over `answer`. One that names a release or beta newer than this Ember
 * stands over one that names none, whenever each heard from GitHub, since a release or beta once out stays
 * out, and an isolate whose ask for the newest release failed, or for the tags, says what it heard of that
 * before, though it heard of the other just now. Otherwise the one that heard of the newest release last
 * stands. An answer from this Ember as another release, once one is deployed, always replaces it.
 */
function keeps(kept: ReleaseCheck, answer: ReleaseCheck): boolean {
  if (answer.release !== kept.release) return false;
  if (namesNewer(kept) !== namesNewer(answer)) return namesNewer(kept);
  return (answer.checkedAt ?? "") < (kept.checkedAt ?? "");
}

/** Whether `check` names a release, or a beta, newer than this Ember: an update, or a beta to try. */
const namesNewer = ({ newest, newestBeta }: ReleaseCheck) => Boolean(newest?.newer || newestBeta?.newer);
