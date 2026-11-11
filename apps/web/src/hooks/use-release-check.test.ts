import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReleaseCheck } from "@ember/protocol";
import { checkForRelease, checkForReleaseAfresh } from "@/lib/api";
import { useReleaseCheck } from "./use-release-check";

vi.mock("@/lib/api", () => ({ checkForRelease: vi.fn(), checkForReleaseAfresh: vi.fn() }));

/** When GitHub named a release to the Worker, minutes past 4 PM. */
const minutesPast = (minutes: number) => new Date(Date.UTC(2026, 10, 11, 16, minutes)).toISOString();

/** What the Worker says of releases while `newest` is GitHub's newest, after this Ember's 0.1, as GitHub named it `checkedAt`. */
const newestIs = (newest: string, checkedAt = minutesPast(Number(newest.split(".")[1]))): ReleaseCheck => ({
  release: "0.1",
  beta: false,
  newest: { release: newest, notes: `https://github.com/NYLLON-SOFTWARE/ember-cloudflare/releases/tag/v${newest}.0`, newer: true },
  checkedAt,
  newestBeta: null,
  copy: null,
});

/** The browser's idle callbacks, which run when a test says, unless they're cancelled first. */
const idle = new Map<number, () => void>();
let lastIdle = 0;

/** Runs the idle callbacks waiting. */
function becomeIdle() {
  const waiting = [...idle.values()];
  idle.clear();
  act(() => waiting.forEach((run) => run()));
}

/** How many times the Worker was asked, and how many of those afresh. */
const asked = () => [vi.mocked(checkForRelease).mock.calls.length, vi.mocked(checkForReleaseAfresh).mock.calls.length];

beforeEach(() => {
  vi.stubGlobal("requestIdleCallback", (run: () => void) => {
    idle.set(++lastIdle, run);
    return lastIdle;
  });
  vi.stubGlobal("cancelIdleCallback", (handle: number) => idle.delete(handle));
  vi.mocked(checkForRelease).mockResolvedValue(newestIs("0.2"));
  vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.3"));
});

afterEach(() => {
  // Unmounted while what it calls on the way out is still stubbed.
  cleanup();
  idle.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Checking for a newer release", () => {
  it.each([false, true])("asks once the page is ready, then afresh each time Admin opens, and never for leaving it (strict: %s)", async (strict) => {
    const { result, rerender } = renderHook(({ ready, inAdmin }) => useReleaseCheck(true, ready, inAdmin), {
      initialProps: { ready: false, inAdmin: false },
      wrapper: strict ? StrictMode : undefined,
    });
    becomeIdle();
    expect(asked()).toEqual([0, 0]);
    rerender({ ready: true, inAdmin: false });
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.2")));

    rerender({ ready: true, inAdmin: true });
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.3")));
    rerender({ ready: true, inAdmin: false });
    becomeIdle();
    expect(asked()).toEqual([1, 1]);
    rerender({ ready: true, inAdmin: true });
    becomeIdle();
    expect(asked()).toEqual([1, 2]);
  });

  it.each([false, true])("asks afresh alone for a page that's ready in Admin as it loads (strict: %s)", async (strict) => {
    const { result } = renderHook(() => useReleaseCheck(true, true, true), { wrapper: strict ? StrictMode : undefined });
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.3")));
    expect(asked()).toEqual([0, 1]);
  });

  it("asks nothing for anyone but an administrator, in Admin or out", () => {
    const { result, rerender } = renderHook(({ inAdmin }) => useReleaseCheck(false, true, inAdmin), { initialProps: { inAdmin: false } });
    rerender({ inAdmin: true });
    becomeIdle();
    expect(asked()).toEqual([0, 0]);
    expect(result.current.check).toBeNull();
  });
});

describe("Check for updates", () => {
  it("asks afresh at once, without waiting for the browser to be idle, settling once the Worker has answered", async () => {
    const { result } = renderHook(() => useReleaseCheck(true, true, true));
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.3")));

    vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.4"));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.4"));
    expect(asked()).toEqual([0, 2]);
    expect(idle.size).toBe(0);
  });

  it("keeps what the Worker heard from GitHub last, as another isolate's answer can arrive after it having heard before", async () => {
    // Opening Admin asks first, but its answer, which heard of 0.3 at 4:03, comes after Check for updates' of 0.4 at 4:04.
    let answerOpening: (check: ReleaseCheck) => void = () => {};
    vi.mocked(checkForReleaseAfresh).mockImplementationOnce(() => new Promise((resolve) => (answerOpening = resolve)));
    const { result } = renderHook(() => useReleaseCheck(true, true, true));
    becomeIdle();
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.4"));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.4"));
    await act(async () => answerOpening(newestIs("0.3")));
    expect(result.current.check).toEqual(newestIs("0.4"));

    // One that heard from GitHub at the same time changes it, but one that never heard from it doesn't.
    vi.mocked(checkForReleaseAfresh).mockResolvedValue(newestIs("0.5", minutesPast(4)));
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.5", minutesPast(4)));
    vi.mocked(checkForReleaseAfresh).mockResolvedValue({ ...newestIs("0.6"), newest: null, checkedAt: null });
    await act(() => result.current.checkAgain());
    expect(result.current.check).toEqual(newestIs("0.5", minutesPast(4)));
  });

  it("fails as asking does, keeping what the Worker said before", async () => {
    const { result } = renderHook(() => useReleaseCheck(true, true, true));
    becomeIdle();
    await waitFor(() => expect(result.current.check).toEqual(newestIs("0.3")));
    const error = new Error("Failed to fetch");
    vi.mocked(checkForReleaseAfresh).mockRejectedValue(error);
    await act(() => expect(result.current.checkAgain()).rejects.toBe(error));
    expect(result.current.check).toEqual(newestIs("0.3"));
  });
});
