import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSettings } from "@ember/protocol";
import {
  ASSISTANT_OFF,
  cannotSearchWith,
  TOP_LEVELS,
  type AnswerLevelChanges,
  type AnswerLevels,
  type AssistantSettings as Assistant,
  type WebSearchChanged,
  type WebTool,
} from "@ember/protocol/assistant";
import { ApiError } from "@/lib/api";
import { AssistantSettings, CONFIRM_STOP_ASSISTANT, LIMITS_EXPLAINED, searchingWith, WEB_SEARCH_OFF, webSearchOn, WHAT_EMBER_SENDS } from "./assistant-settings";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

/**
 * Ember AI on, running on `model`, with `most` the most its dials go to, doing `webTools` on the web: nothing
 * yet for Anthropic's and OpenAI's models, which can search, and null for the rest, which can't.
 */
const on = (model: string, most: AnswerLevels = TOP_LEVELS, webTools: WebTool[] | null = /^(?:anthropic|openai)\//.test(model) ? [] : null): Assistant => ({
  accountId: ACCOUNT_ID,
  model,
  most,
  webTools,
});

/** Answers turning Ember AI off, and changing the most its dials go to, as the server would, or as `stopped` and `changed` say. */
function serve(
  stopped: () => Response | Promise<Response> = () => Response.json({ assistant: null }),
  changed: (changes: AnswerLevelChanges) => Response | Promise<Response> = (changes) => Response.json({ assistant: on("@cf/zai-org/glm-4.7-flash", { ...TOP_LEVELS, ...changes }) }),
) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method} ${String(input)}`;
    if (request === "DELETE /api/account/assistant") return stopped();
    if (request === "PATCH /api/account/assistant") return changed(JSON.parse(String(init?.body)) as AnswerLevelChanges);
    throw new Error(`Unexpected request for ${request}`);
  });
}

/** A response the test lets through when it says, with `answer` letting it through. */
function held(response: () => Response) {
  let answer = () => {};
  const answered = new Promise<Response>((resolve) => (answer = () => resolve(response())));
  return { answered: () => answered, answer: () => act(async () => answer()) };
}

/** The card, for a workspace whose Ember AI is `assistant`. */
function showCard(assistant: WorkspaceSettings["assistant"]) {
  const callbacks = { onSetUp: vi.fn(), onStopped: vi.fn(), onChanged: vi.fn(), onFailed: vi.fn() };
  render(<AssistantSettings assistant={assistant} {...callbacks} />);
  return { ...callbacks, user: userEvent.setup() };
}

const card = () => screen.getByRole("region", { name: "Ember AI" });
const assistantSwitch = () => within(card()).getByRole("switch", { name: "Ember AI" });

afterEach(() => vi.restoreAllMocks());

describe("Ember AI", () => {
  it("says what Ember AI adds while its switch is off, which turning on opens Set up Ember AI", async () => {
    serve();
    const { user, onSetUp } = showCard(null);
    const description =
      "Ember AI adds @ember, an AI assistant, to every room open to everyone, running on a model you choose through Cloudflare AI Gateway.";
    expect(card()).toHaveTextContent(description);
    expect(card()).not.toHaveTextContent(WHAT_EMBER_SENDS);
    expect(assistantSwitch()).not.toBeChecked();
    expect(assistantSwitch()).toHaveAccessibleDescription(description);
    expect(within(card()).queryAllByRole("button")).toEqual([]);
    await user.click(assistantSwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    // It stays off until a model has answered.
    expect(assistantSwitch()).not.toBeChecked();
  });

  it("names the model @ember runs on, its switch on, with Change", async () => {
    serve();
    const { user, onSetUp } = showCard(on("anthropic/claude-sonnet-5.5"));
    expect(card()).toHaveTextContent("@ember runs on Claude Sonnet 5.5 through Cloudflare AI Gateway.");
    // Who reads what @ember is asked: the model's provider, through Cloudflare.
    expect(card()).toHaveTextContent(WHAT_EMBER_SENDS);
    expect(assistantSwitch()).toBeChecked();
    expect(assistantSwitch()).toBeEnabled();
    expect(within(card()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Change"]);
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(onSetUp).toHaveBeenCalledOnce();
  });

  it("names a model it doesn't list by its ID", () => {
    serve();
    showCard(on("mistral/mistral-large-3"));
    expect(card()).toHaveTextContent("@ember runs on mistral/mistral-large-3 through Cloudflare AI Gateway.");
  });

  it("turns Ember AI off once the administrator confirms turning its switch off", async () => {
    const answer = held(() => Response.json({ assistant: null }));
    const fetch = serve(answer.answered);
    const sure = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { user, onStopped } = showCard(on("@cf/zai-org/glm-4.7-flash"));
    await user.click(assistantSwitch());
    expect(sure).toHaveBeenCalledWith(CONFIRM_STOP_ASSISTANT);
    expect(fetch).not.toHaveBeenCalled();
    expect(assistantSwitch()).toBeChecked();

    await user.click(assistantSwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant", expect.objectContaining({ method: "DELETE" }));
    expect(assistantSwitch()).not.toBeChecked();
    expect(assistantSwitch()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
    await answer.answer();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(assistantSwitch()).toBeEnabled();
  });

  it("leaves turning it off that failed to the page's alerts, its switch back on", async () => {
    serve(() => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onStopped, onFailed } = showCard(on("@cf/zai-org/glm-4.7-flash"));
    await user.click(assistantSwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(onStopped).not.toHaveBeenCalled();
    expect(assistantSwitch()).toBeChecked();
    expect(assistantSwitch()).toBeEnabled();
  });
});

describe("Limits", () => {
  const dial = (name: string) => within(card()).getByRole("group", { name });
  const level = (name: string) => within(card()).getByRole("radio", { name });

  it("has the most @ember may think and write for anyone's question while Ember AI is on, any level allowed", () => {
    serve();
    showCard(on("anthropic/claude-sonnet-5.5", { thinking: "medium", length: "long" }));
    expect(card()).toHaveTextContent(LIMITS_EXPLAINED);
    expect(within(dial("Thinking")).getByRole("radio", { name: "Medium" })).toBeChecked();
    expect(dial("Thinking")).toHaveAccessibleDescription("Thinks more first, up to about 16,000 tokens.");
    for (const name of ["Off", "Low", "High"]) expect(level(name)).toBeEnabled();
    expect(level("Long")).toBeChecked();
    expect(dial("Answer length")).toHaveAccessibleDescription("About 1,500 words, nearly all one message holds.");
  });

  it("has none while Ember AI is off", () => {
    serve();
    showCard(null);
    expect(within(card()).queryAllByRole("group")).toEqual([]);
  });

  it("saves a change at once, showing it meanwhile", async () => {
    const answer = held(() => Response.json({ assistant: on("@cf/zai-org/glm-4.7-flash", { thinking: "low", length: "long" }) }));
    const fetch = serve(undefined, answer.answered);
    const shown = on("@cf/zai-org/glm-4.7-flash");
    const { user, onChanged } = showCard(shown);
    await user.click(level("Low"));
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ thinking: "low" }) }));
    expect(onChanged).toHaveBeenCalledWith({ ...shown, most: { thinking: "low", length: "long" } });
    expect(level("Off")).toBeDisabled();
    await answer.answer();
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(level("Off")).toBeEnabled();
  });

  it("can't be turned off or changed while a change saves, so that its answer can't show Ember AI as it was", async () => {
    const answer = held(() => Response.json({ assistant: on("@cf/zai-org/glm-4.7-flash", { thinking: "low", length: "long" }) }));
    serve(undefined, answer.answered);
    const { user } = showCard(on("@cf/zai-org/glm-4.7-flash"));
    await user.click(level("Low"));
    expect(assistantSwitch()).toBeDisabled();
    expect(within(card()).getByRole("button", { name: "Change" })).toBeDisabled();
    await answer.answer();
    expect(assistantSwitch()).toBeEnabled();
    expect(within(card()).getByRole("button", { name: "Change" })).toBeEnabled();
  });

  it("shows the most as it was again when a change isn't saved, leaving why to the page's alerts", async () => {
    serve(undefined, () => Response.json({ error: ASSISTANT_OFF }, { status: 409 }));
    const shown = on("@cf/zai-org/glm-4.7-flash");
    const { user, onChanged, onFailed } = showCard(shown);
    await user.click(level("Short"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(409, ASSISTANT_OFF)));
    expect(onChanged.mock.calls).toEqual([[{ ...shown, most: { thinking: "high", length: "short" } }], [shown]]);
    expect(level("Short")).toBeEnabled();
  });
});

describe("Search the web", () => {
  const SONNET = "anthropic/claude-sonnet-5.5";
  const FOUND = "AI Gateway is Cloudflare's proxy for requests to AI models.";
  const webSwitch = () => within(card()).getByRole("switch", { name: "Search the web" });

  /** Answers turning Search the web on or off as `changed` says, keeping what the card sent. */
  function serveWebSearch(changed: (on: boolean) => Response | Promise<Response>) {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (`${init?.method} ${String(input)}` !== "PUT /api/account/assistant/web_search") throw new Error(`Unexpected request for ${init?.method} ${String(input)}`);
      return changed((JSON.parse(String(init?.body)) as { on: boolean }).on);
    });
  }

  /** What the server answers once it has turned Search the web `on` with `webTools`, or off. */
  const turned = (on_: boolean, webTools: WebTool[] = ["search", "read"]) =>
    Response.json({ assistant: on(SONNET, TOP_LEVELS, on_ ? webTools : []), found: on_ ? FOUND : null } satisfies WebSearchChanged);

  /** The card, showing Ember AI as each change to it leaves it, as the settings page does. */
  function showLiveCard(assistant: Assistant) {
    const callbacks = { onSetUp: vi.fn(), onStopped: vi.fn(), onFailed: vi.fn() };
    function Live() {
      const [shown, setShown] = useState(assistant);
      return <AssistantSettings assistant={shown} onChanged={setShown} {...callbacks} />;
    }
    render(<Live />);
    return { ...callbacks, user: userEvent.setup() };
  }

  it("is off for a model that can search until it's turned on, saying what turning it on lets @ember do", () => {
    serveWebSearch(() => turned(true));
    showLiveCard(on(SONNET));
    expect(webSwitch()).not.toBeChecked();
    expect(webSwitch()).toBeEnabled();
    expect(webSwitch()).toHaveAccessibleDescription(WEB_SEARCH_OFF);
    expect(within(card()).getByRole("status")).toHaveTextContent("");
  });

  it("turns on once the model has searched the web, saying what it found, with everything else held meanwhile", async () => {
    const answer = held(() => turned(true));
    const fetch = serveWebSearch(answer.answered);
    const { user } = showLiveCard(on(SONNET));

    await user.click(webSwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant/web_search", expect.objectContaining({ method: "PUT", body: JSON.stringify({ on: true }) }));
    expect(webSwitch()).toBeChecked();
    expect(webSwitch()).toBeDisabled();
    expect(within(card()).getByRole("status")).toHaveTextContent(searchingWith(SONNET));
    expect(assistantSwitch()).toBeDisabled();
    expect(within(card()).getByRole("button", { name: "Change" })).toBeDisabled();
    expect(within(card()).getByRole("radio", { name: "Low" })).toBeDisabled();

    await answer.answer();
    expect(webSwitch()).toBeChecked();
    expect(webSwitch()).toBeEnabled();
    expect(webSwitch()).toHaveAccessibleDescription(webSearchOn(["search", "read"]));
    expect(webSearchOn(["search", "read"])).toContain("reads the pages people link to or its searches find, at most 3");
    expect(within(card()).getByRole("status")).toHaveTextContent(`It searched the web and said: ${FOUND}`);
    expect(assistantSwitch()).toBeEnabled();
  });

  it("says when it only searches, as AI Gateway didn't take the model's tool for reading pages", async () => {
    serveWebSearch(() => turned(true, ["search"]));
    const { user } = showLiveCard(on(SONNET));
    await user.click(webSwitch());
    await waitFor(() => expect(webSwitch()).toBeEnabled());
    expect(webSwitch()).toHaveAccessibleDescription(webSearchOn(["search"]));
    expect(webSearchOn(["search"])).not.toContain("reads");
  });

  it("says why it didn't turn on, its switch back off", async () => {
    const refusal = "Claude Sonnet 5.5 answered without searching the web, so Search the web is still off. Try again, or choose another model under Change.";
    serveWebSearch(() => Response.json({ error: refusal }, { status: 422 }));
    const { user, onFailed } = showLiveCard(on(SONNET));
    await user.click(webSwitch());
    await waitFor(() => expect(within(card()).getByRole("status")).toHaveTextContent(refusal));
    expect(webSwitch()).not.toBeChecked();
    expect(webSwitch()).toBeEnabled();
    expect(onFailed).not.toHaveBeenCalled();
  });

  it("turns off without searching, saying nothing more", async () => {
    const answer = held(() => turned(false));
    const fetch = serveWebSearch(answer.answered);
    const { user } = showLiveCard(on(SONNET, TOP_LEVELS, ["search", "read"]));
    expect(webSwitch()).toBeChecked();

    await user.click(webSwitch());
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant/web_search", expect.objectContaining({ body: JSON.stringify({ on: false }) }));
    expect(webSwitch()).not.toBeChecked();
    expect(within(card()).getByRole("status")).toHaveTextContent("");
    await answer.answer();
    expect(webSwitch()).not.toBeChecked();
    expect(webSwitch()).toHaveAccessibleDescription(WEB_SEARCH_OFF);
  });

  it("says a model that can't search can't, its switch opening Set up Ember AI to choose another", async () => {
    const fetch = serveWebSearch(() => turned(true));
    const { user, onSetUp } = showLiveCard(on("@cf/zai-org/glm-4.7-flash"));
    expect(webSwitch()).toHaveAccessibleDescription(cannotSearchWith("@cf/zai-org/glm-4.7-flash"));
    await user.click(webSwitch());
    expect(onSetUp).toHaveBeenCalledOnce();
    expect(webSwitch()).not.toBeChecked();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("leaves a failure it can't say itself to the page's alerts", async () => {
    serveWebSearch(() => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }));
    const { user, onFailed } = showLiveCard(on(SONNET));
    await user.click(webSwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(within(card()).getByRole("status")).toHaveTextContent("");
    expect(webSwitch()).not.toBeChecked();
  });
});
