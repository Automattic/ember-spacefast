import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSettings } from "@ember/protocol";
import { CALLS_FORBIDDEN } from "@ember/protocol/calls";
import { ApiError } from "@/lib/api";
import { CALLS_COMING, CALLS_EXPLAINED, CallsSettings, CONFIRM_STOP_CALLS } from "./calls-settings";

const APP_ID = "2a95132c15732412d22c1476fa83f27a";

/** Answers turning calls off as the server would, or as `stopped` says. */
function serve(stopped: () => Response | Promise<Response> = () => Response.json({ calls: null })) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (`${init?.method} ${String(input)}` === "DELETE /api/account/calls") return stopped();
    throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
  });
}

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/** The card, for a workspace whose calls are as `calls` says. */
function showCard(calls: WorkspaceSettings["calls"]) {
  const callbacks = { onSetUp: vi.fn(), onStopped: vi.fn(), onFailed: vi.fn() };
  render(<CallsSettings calls={calls} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const card = () => screen.getByRole("region", { name: "Calls" });
const callsSwitch = () => within(card()).getByRole("switch", { name: "Calls" });

afterEach(() => vi.restoreAllMocks());

describe("Set up calls", () => {
  it("says what calls are while its switch is off, which turning on opens Set up calls", async () => {
    serve();
    const { user, onSetUp } = showCard(null);
    expect(card()).toHaveTextContent(CALLS_EXPLAINED);
    expect(card()).toHaveTextContent(CALLS_COMING);
    expect(within(card()).getByRole("heading", { level: 3, name: "Calls" })).toBeVisible();
    expect(callsSwitch()).not.toBeChecked();
    expect(callsSwitch()).toHaveAccessibleDescription(CALLS_EXPLAINED);
    expect(within(card()).queryAllByRole("button")).toEqual([]);
    await user.click(callsSwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    // It stays off until the app's keys are given.
    expect(callsSwitch()).not.toBeChecked();
  });

  it("names the SFU app calls run through, its switch on, with Change keys", async () => {
    serve();
    const { user, onSetUp } = showCard({ appId: APP_ID });
    const description = `Calls run through the Realtime SFU app ${APP_ID} in your Cloudflare account.`;
    expect(card()).toHaveTextContent(description);
    expect(card()).toHaveTextContent(CALLS_COMING);
    expect(callsSwitch()).toBeChecked();
    expect(callsSwitch()).toBeEnabled();
    expect(callsSwitch()).toHaveAccessibleDescription(description);
    expect(within(card()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Change keys"]);
    await user.click(screen.getByRole("button", { name: "Change keys" }));
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it("forgets the app's keys once the administrator confirms turning its switch off", async () => {
    const answer = held(() => Response.json({ calls: null }));
    const fetch = serve(answer.answered);
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user, onStopped } = showCard({ appId: APP_ID });
    await user.click(callsSwitch());
    expect(sure).toHaveBeenCalledWith(CONFIRM_STOP_CALLS);
    expect(fetch).not.toHaveBeenCalled();
    expect(callsSwitch()).toBeChecked();

    await user.click(callsSwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/calls", expect.objectContaining({ method: "DELETE" }));
    expect(callsSwitch()).not.toBeChecked();
    expect(callsSwitch()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change keys" })).toBeDisabled();
    await answer.answer();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(callsSwitch()).toBeEnabled();
  });

  it("leaves turning it off that failed to the page's alerts, its switch back on", async () => {
    serve(() => Response.json({ error: CALLS_FORBIDDEN }, { status: 403 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onStopped, onFailed } = showCard({ appId: APP_ID });
    await user.click(callsSwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, CALLS_FORBIDDEN)));
    expect(onStopped).not.toHaveBeenCalled();
    expect(callsSwitch()).toBeChecked();
    expect(callsSwitch()).toBeEnabled();
  });
});
