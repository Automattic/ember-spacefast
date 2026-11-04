import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSettings } from "@ember/protocol";
import {
  ASSISTANT_MODELS,
  ASSISTANT_OFF,
  DEFAULT_MODEL_KEPT,
  MAX_ASSISTANT_MODELS,
  MODELS_FULL,
  TOP_LEVELS,
  type AnswerLevels,
  type AssistantCatalog,
  type AssistantChanges,
  type AssistantModel,
  type AssistantSettings as Assistant,
  type NewAssistantModel,
} from "@ember/protocol/assistant";
import { ApiError } from "@/lib/api";
import { AssistantSettings, CONFIRM_STOP_ASSISTANT, LIMITS_EXPLAINED, MODELS_EXPLAINED, WHAT_EMBER_SENDS } from "./assistant-settings";
import { CATALOG_UNREAD } from "./model-picker";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

/** The model `id`, as Ember knows it, or else as it would know one it doesn't. */
function known(id: string): AssistantModel {
  const { name, format } = ASSISTANT_MODELS.find((model) => model.id === id) ?? { name: id, format: "chat" as const };
  return { id, name, format };
}

/** Ember AI on, running on `model`, with `most` the most its dials go to, and people able to pick `others` too. */
const on = (model: string, most: AnswerLevels = TOP_LEVELS, others: string[] = []): Assistant => ({
  accountId: ACCOUNT_ID,
  model,
  models: [model, ...others].map(known),
  most,
});

type Answer<T = void> = (given: T) => Response | Promise<Response>;

/** Cloudflare's catalog, as the Worker lists it, Workers AI's models first. */
const CATALOG: AssistantCatalog = {
  models: [known("@cf/zai-org/glm-4.7-flash"), known("anthropic/claude-sonnet-5.5"), { ...known("openai/gpt-6.1-sol"), price: { input: 2, output: 10 } }],
  refusal: null,
};

/**
 * Answers turning Ember AI off, changing it, taking a model out, listing Cloudflare's catalog and adding a
 * model as the server would, or as `stopped`, `changed`, `removed`, `listed` and `added` say.
 */
function serve({
  stopped = () => Response.json({ assistant: null }),
  changed = ({ model, ...levels }) => Response.json({ assistant: on(model ?? "@cf/zai-org/glm-4.7-flash", { ...TOP_LEVELS, ...levels }) }),
  removed = () => Response.json({ assistant: on("@cf/zai-org/glm-4.7-flash") }),
  listed = () => Response.json(CATALOG),
  added = ({ model }) => Response.json({ assistant: on("anthropic/claude-sonnet-5.5", TOP_LEVELS, [model]), greeting: "Hello! I'm here to help." }),
}: {
  stopped?: Answer;
  changed?: Answer<AssistantChanges>;
  removed?: Answer<string>;
  listed?: Answer;
  added?: Answer<NewAssistantModel>;
} = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = `${init?.method} ${String(input)}`;
    const body = () => JSON.parse(String(init?.body)) as unknown;
    if (request === "DELETE /api/account/assistant") return stopped();
    if (request === "PATCH /api/account/assistant") return changed(body() as AssistantChanges);
    if (request === "DELETE /api/account/assistant/models") return removed((body() as { model: string }).model);
    if (request === "POST /api/account/assistant/catalog") return listed();
    if (request === "POST /api/account/assistant/models") return added(body() as NewAssistantModel);
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
    expect(within(card()).getAllByRole("button").map((button) => button.textContent)).toEqual(["Change", "Add a model"]);
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
    const fetch = serve({ stopped: answer.answered });
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
    serve({ stopped: () => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { user, onStopped, onFailed } = showCard(on("@cf/zai-org/glm-4.7-flash"));
    await user.click(assistantSwitch());
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(onStopped).not.toHaveBeenCalled();
    expect(assistantSwitch()).toBeChecked();
    expect(assistantSwitch()).toBeEnabled();
  });
});

describe("Models", () => {
  const models = () => within(card()).getByRole("group", { name: "Models" });
  const model = (name: string) => within(models()).getByRole("radio", { name });
  const addModel = () => within(card()).getByRole("button", { name: "Add a model" });
  const SEVERAL = on("anthropic/claude-sonnet-5.5", TOP_LEVELS, ["@cf/zai-org/glm-4.7-flash", "openai/gpt-6.1-sol"]);

  it("lists the models people can pick, the one that answers everyone else chosen, with Remove for the others", () => {
    serve();
    showCard(SEVERAL);
    expect(card()).toHaveTextContent("@ember runs on Claude Sonnet 5.5 through Cloudflare AI Gateway, or on the model each person picks.");
    expect(models()).toHaveAccessibleDescription(MODELS_EXPLAINED);
    expect(within(models()).getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual(["Claude Sonnet 5.5", "GLM-4.7 Flash", "GPT-6.1 Sol"]);
    expect(model("Claude Sonnet 5.5")).toBeChecked();
    expect(within(models()).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["Remove GLM-4.7 Flash", "Remove GPT-6.1 Sol"]);
    expect(addModel()).toBeEnabled();
  });

  it("has none while Ember AI is off", () => {
    serve();
    showCard(null);
    expect(within(card()).queryByRole("group", { name: "Models" })).toBeNull();
  });

  it("saves another model chosen to answer everyone at once, showing it meanwhile", async () => {
    const answer = held(() => Response.json({ assistant: { ...SEVERAL, model: "openai/gpt-6.1-sol" } }));
    const fetch = serve({ changed: answer.answered });
    const { user, onChanged } = showCard(SEVERAL);
    await user.click(model("GPT-6.1 Sol"));
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ model: "openai/gpt-6.1-sol" }) }));
    expect(onChanged).toHaveBeenCalledWith({ ...SEVERAL, model: "openai/gpt-6.1-sol" });
    expect(model("GLM-4.7 Flash")).toBeDisabled();
    expect(addModel()).toBeDisabled();
    expect(assistantSwitch()).toBeDisabled();
    await answer.answer();
    expect(onChanged).toHaveBeenLastCalledWith({ ...SEVERAL, model: "openai/gpt-6.1-sol" });
    expect(model("GLM-4.7 Flash")).toBeEnabled();
  });

  it("takes a model out at once with its Remove, showing it gone meanwhile", async () => {
    const answer = held(() => Response.json({ assistant: on("anthropic/claude-sonnet-5.5", TOP_LEVELS, ["openai/gpt-6.1-sol"]) }));
    const fetch = serve({ removed: answer.answered });
    const { user, onChanged } = showCard(SEVERAL);
    await user.click(within(models()).getByRole("button", { name: "Remove GLM-4.7 Flash" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/account/assistant/models",
      expect.objectContaining({ method: "DELETE", body: JSON.stringify({ model: "@cf/zai-org/glm-4.7-flash" }) }),
    );
    expect(onChanged).toHaveBeenCalledWith({ ...SEVERAL, models: [known("anthropic/claude-sonnet-5.5"), known("openai/gpt-6.1-sol")] });
    expect(within(models()).getByRole("button", { name: "Remove GPT-6.1 Sol" })).toBeDisabled();
    await answer.answer();
    expect(onChanged).toHaveBeenCalledTimes(2);
    expect(within(models()).getByRole("button", { name: "Remove GPT-6.1 Sol" })).toBeEnabled();
  });

  it("shows the models as they were again when a change isn't saved, leaving why to the page's alerts", async () => {
    serve({ removed: () => Response.json({ error: DEFAULT_MODEL_KEPT }, { status: 409 }) });
    const { user, onChanged, onFailed } = showCard(SEVERAL);
    await user.click(within(models()).getByRole("button", { name: "Remove GPT-6.1 Sol" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(409, DEFAULT_MODEL_KEPT)));
    expect(onChanged.mock.calls).toEqual([[{ ...SEVERAL, models: [known("anthropic/claude-sonnet-5.5"), known("@cf/zai-org/glm-4.7-flash")] }], [SEVERAL]]);
  });

  it("can't add a model once people can pick from as many as there can be", () => {
    serve();
    const others = Array.from({ length: MAX_ASSISTANT_MODELS - 1 }, (_, index) => `@cf/meta/model-${index}`);
    showCard(on("anthropic/claude-sonnet-5.5", TOP_LEVELS, others));
    expect(addModel()).toBeDisabled();
    expect(addModel()).toHaveAccessibleDescription(MODELS_FULL);
  });
});

describe("Add a model", () => {
  const dialog = () => screen.getByRole("dialog");
  const menu = () => within(dialog()).getByRole("combobox", { name: "Model" });

  /** Opens Add a model from the card, for a workspace whose Ember AI is `assistant`, once its catalog is listed. */
  async function openDialog(assistant: Assistant = on("anthropic/claude-sonnet-5.5")) {
    const shown = showCard(assistant);
    await shown.user.click(within(card()).getByRole("button", { name: "Add a model" }));
    await within(dialog()).findByRole("combobox", { name: "Model" });
    return shown;
  }

  it("offers Cloudflare's catalog's models people can't pick yet, the first of them chosen", async () => {
    const fetch = serve();
    await openDialog();
    expect(dialog()).toHaveAccessibleName("Add a model");
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant/catalog", expect.objectContaining({ method: "POST", body: JSON.stringify({ accountId: ACCOUNT_ID }) }));
    expect(within(menu()).getAllByRole("option").map((option) => option.textContent)).toEqual(["GLM-4.7 Flash", "GPT-6.1 Sol · $2 / $10", "Another model…"]);
    expect(menu()).toHaveValue("@cf/zai-org/glm-4.7-flash");
    expect(dialog()).not.toHaveTextContent(CATALOG_UNREAD);
  });

  it("adds the model chosen once it answers a test question, saying what it said", async () => {
    const fetch = serve();
    const { user, onChanged } = await openDialog();
    await user.selectOptions(menu(), "openai/gpt-6.1-sol");
    expect(dialog()).toHaveTextContent("AI Gateway's credits pay for this model, $2 for each million tokens it reads, and $10 for each million it writes.");
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(fetch).toHaveBeenCalledWith(
      "/api/account/assistant/models",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ model: "openai/gpt-6.1-sol", modelName: "GPT-6.1 Sol" }) }),
    );
    expect(await screen.findByRole("dialog", { name: "Model added" })).toHaveTextContent(
      "People can pick GPT-6.1 Sol on their profile now. Asked to say hello, it said:Hello! I'm here to help.",
    );
    expect(onChanged).toHaveBeenCalledWith(on("anthropic/claude-sonnet-5.5", TOP_LEVELS, ["openai/gpt-6.1-sol"]));
    await user.click(within(dialog()).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds a model the catalog doesn't list by its ID", async () => {
    const fetch = serve();
    const { user } = await openDialog();
    await user.selectOptions(menu(), "Another model…");
    await user.type(within(dialog()).getByRole("textbox", { name: "Model ID" }), " mistral/mistral-large-3 ");
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(fetch).toHaveBeenCalledWith("/api/account/assistant/models", expect.objectContaining({ body: JSON.stringify({ model: "mistral/mistral-large-3" }) }));
    expect(await screen.findByRole("dialog", { name: "Model added" })).toHaveTextContent("People can pick mistral/mistral-large-3 on their profile now.");
  });

  it("says why a model didn't answer on its menu, adding nothing", async () => {
    const refusal = "The model didn't answer: it isn't one AI Gateway knows.";
    serve({ added: () => Response.json({ error: refusal, field: "model" }, { status: 422 }) });
    const { user, onChanged } = await openDialog();
    await user.click(within(dialog()).getByRole("button", { name: "Add" }));
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(refusal);
    expect(menu()).toHaveAttribute("aria-invalid", "true");
    expect(menu()).toHaveAccessibleDescription(refusal);
    expect(onChanged).not.toHaveBeenCalled();
    expect(dialog()).toHaveAccessibleName("Add a model");
  });

  it("offers the models Ember knows when the catalog couldn't be read, saying why", async () => {
    const refusal = "Cloudflare's model catalog didn't answer.";
    serve({ listed: () => Response.json({ models: ASSISTANT_MODELS, refusal }) });
    await openDialog();
    expect(dialog()).toHaveTextContent(`${CATALOG_UNREAD} ${refusal}`);
    expect(within(menu()).getAllByRole("option")).toHaveLength(ASSISTANT_MODELS.length);
  });

  it("leaves listing that failed to the page's alerts, closing", async () => {
    serve({ listed: () => Response.json({ error: "Only administrators can set up Ember AI" }, { status: 403 }) });
    const { user, onFailed } = showCard(on("anthropic/claude-sonnet-5.5"));
    await user.click(within(card()).getByRole("button", { name: "Add a model" }));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(403, "Only administrators can set up Ember AI")));
    expect(screen.queryByRole("dialog")).toBeNull();
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
    const fetch = serve({ changed: answer.answered });
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
    serve({ changed: answer.answered });
    const { user } = showCard(on("@cf/zai-org/glm-4.7-flash"));
    await user.click(level("Low"));
    expect(assistantSwitch()).toBeDisabled();
    expect(within(card()).getByRole("button", { name: "Change" })).toBeDisabled();
    await answer.answer();
    expect(assistantSwitch()).toBeEnabled();
    expect(within(card()).getByRole("button", { name: "Change" })).toBeEnabled();
  });

  it("shows the most as it was again when a change isn't saved, leaving why to the page's alerts", async () => {
    serve({ changed: () => Response.json({ error: ASSISTANT_OFF }, { status: 409 }) });
    const shown = on("@cf/zai-org/glm-4.7-flash");
    const { user, onChanged, onFailed } = showCard(shown);
    await user.click(level("Short"));
    await waitFor(() => expect(onFailed).toHaveBeenCalledWith(new ApiError(409, ASSISTANT_OFF)));
    expect(onChanged.mock.calls).toEqual([[{ ...shown, most: { thinking: "high", length: "short" } }], [shown]]);
    expect(level("Short")).toBeEnabled();
  });
});
