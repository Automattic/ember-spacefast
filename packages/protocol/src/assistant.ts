// Ember AI, which answers as @ember through Cloudflare's AI Gateway, as administrators set it up on the
// AI assistant tab of workspace settings through `/api/account/assistant`.

/**
 * The API formats AI Gateway's REST API takes a model's requests in, at `/ai/v1/messages`,
 * `/ai/v1/responses` and `/ai/v1/chat/completions`: Anthropic's models take only Messages, some of
 * OpenAI's only Responses, and most others Chat Completions.
 */
export const MODEL_FORMATS = ["messages", "responses", "chat"] as const;
export type ModelFormat = (typeof MODEL_FORMATS)[number];

/** A model Set up Ember AI lists, with what to call it and the format AI Gateway takes its requests in. */
export interface AssistantModel {
  id: string;
  name: string;
  format: ModelFormat;
}

/**
 * The models Set up Ember AI lists, Workers AI's first, which come with Cloudflare's free daily
 * allowance, then other companies', which AI Gateway's credits pay for. Any other model in Cloudflare's
 * catalog can be typed in.
 */
export const ASSISTANT_MODELS: readonly AssistantModel[] = [
  { id: "@cf/zai-org/glm-4.7-flash", name: "GLM-4.7 Flash", format: "chat" },
  { id: "@cf/google/gemma-4-26b-a4b-it", name: "Gemma 4 26B", format: "chat" },
  { id: "@cf/openai/gpt-oss-120b", name: "gpt-oss-120b", format: "chat" },
  { id: "anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", format: "messages" },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", format: "messages" },
  { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5", format: "messages" },
  { id: "openai/gpt-6.1-sol", name: "GPT-6.1 Sol", format: "responses" },
  { id: "openai/gpt-6.1-terra", name: "GPT-6.1 Terra", format: "responses" },
  { id: "google/gemini-4-argon", name: "Gemini 4 Argon", format: "chat" },
  { id: "google/gemini-3.7-flash", name: "Gemini 3.7 Flash", format: "chat" },
  { id: "moonshotai/kimi-k3", name: "Kimi K3", format: "chat" },
];

/** Whether `model` is one of Workers AI's, which Cloudflare runs itself, rather than another company's. */
export const isWorkersAiModel = (model: string) => model.startsWith("@cf/");

/** What to call `model`: its name in the list Set up Ember AI shows, or else its ID. */
export const modelName = (model: string) => ASSISTANT_MODELS.find(({ id }) => id === model)?.name ?? model;

/** How much @ember thinks before it answers: not at all, a little, more, or the most. */
export const THINKING_LEVELS = ["off", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * About how many tokens of thinking each level allows, which a model that takes an effort instead is
 * asked for as its low, medium or high effort.
 */
export const THINKING_TOKENS: Record<ThinkingLevel, number> = { off: 0, low: 4_000, medium: 16_000, high: 32_000 };

/** How long @ember's answers are: short, medium, or long. */
export const ANSWER_LENGTHS = ["short", "medium", "long"] as const;
export type AnswerLength = (typeof ANSWER_LENGTHS)[number];

/** About how many words each length's answers keep to, which @ember is told: a long one is nearly all one message holds. */
export const ANSWER_WORDS: Record<AnswerLength, number> = { short: 150, medium: 400, long: 1_500 };

/** How much @ember thinks, and how long it answers. */
export interface AnswerLevels {
  thinking: ThinkingLevel;
  length: AnswerLength;
}

/** Each level, as its dial names it. */
export const LEVEL_NAMES: Record<ThinkingLevel | AnswerLength, string> = { off: "Off", low: "Low", medium: "Medium", high: "High", short: "Short", long: "Long" };

/** The levels of @ember's answers to someone who hasn't picked their own. */
export const DEFAULT_LEVELS: AnswerLevels = { thinking: "low", length: "medium" };

/** The most each dial goes to until an administrator sets less: the top, as Ember adds no limits of its own. */
export const TOP_LEVELS: AnswerLevels = { thinking: "high", length: "long" };

/** `levels`, each no higher than `most`'s. */
export function withinMost(levels: AnswerLevels, most: AnswerLevels): AnswerLevels {
  const lower = <T>(order: readonly T[], level: T, highest: T) => order[Math.min(order.indexOf(level), order.indexOf(highest))]!;
  return { thinking: lower(THINKING_LEVELS, levels.thinking, most.thinking), length: lower(ANSWER_LENGTHS, levels.length, most.length) };
}

/**
 * What `PATCH /api/account/assistant` changes of the most each dial goes to, and `PATCH
 * /api/users/me/assistant` of your own levels: one dial, or both.
 */
export type AnswerLevelChanges = Partial<AnswerLevels>;

/** The changes `data` gives, as a dial sends them, or null when it changes neither dial, or gives a level neither has. */
export function parseLevelChanges(data: unknown): AnswerLevelChanges | null {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const { thinking, length } = given;
  if (thinking === undefined && length === undefined) return null;
  if (thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(thinking)) return null;
  if (length !== undefined && !(ANSWER_LENGTHS as readonly unknown[]).includes(length)) return null;
  return { ...(thinking !== undefined && { thinking: thinking as ThinkingLevel }), ...(length !== undefined && { length: length as AnswerLength }) };
}

/** Why a change to the levels is refused before anything's saved. */
export const LEVELS_REFUSED = "Choose a level the dial has.";

/**
 * What @ember may do on the web while Search the web is on: search it, and read pages, the ones people
 * link to and its searches find, where AI Gateway takes its model's tool for that too.
 */
export const WEB_TOOLS = ["search", "read"] as const;
export type WebTool = (typeof WEB_TOOLS)[number];

/** The most times @ember searches the web for one answer, as each of Anthropic's searches costs a cent. */
export const WEB_SEARCHES_PER_ANSWER = 5;

/** The most pages @ember reads for one answer, as what it reads is paid for as the conversation is. */
export const PAGES_READ_PER_ANSWER = 3;

/**
 * Ember AI as the AI assistant tab shows it to administrators while it's on: the Cloudflare account it
 * asks through, its model, the most each dial goes to for anyone's questions, and what @ember does on
 * the web: what it may while Search the web is on, nothing while it's off, or null when its model can't,
 * as only Anthropic's and OpenAI's models have tools for it that AI Gateway passes on.
 */
export interface AssistantSettings {
  accountId: string;
  model: string;
  most: AnswerLevels;
  webTools: WebTool[] | null;
}

/** What `PATCH /api/account/assistant` answers once it has saved the most each dial goes to: Ember AI as it is then. */
export interface AssistantChanged {
  assistant: AssistantSettings;
}

/**
 * The levels of @ember's answers to you while Ember AI is on, as your profile shows them: yours, or
 * where they start until you pick, no higher than the most administrators allow, which it shows too.
 */
export interface YourAnswerLevels {
  levels: AnswerLevels;
  most: AnswerLevels;
}

/** What `PATCH /api/users/me/assistant` answers: your levels as they are then, or null while Ember AI is off. */
export interface AnswerLevelsAnswer {
  assistant: YourAnswerLevels | null;
}

/** What the AI assistant tab says when a change to the most each dial goes to comes while Ember AI is off. */
export const ASSISTANT_OFF = "Ember AI is off. Turn it on first.";

/** What `PUT /api/account/assistant/web_search` takes: whether @ember searches the web, as the Search the web switch says. */
export interface WebSearchChange {
  on: boolean;
}

/** The change `data` gives, as the switch sends it, or null when it doesn't say on or off. */
export function parseWebSearchChange(data: unknown): WebSearchChange | null {
  const on = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>).on : undefined;
  return typeof on === "boolean" ? { on } : null;
}

/**
 * What `PUT /api/account/assistant/web_search` answers once it has changed Search the web: Ember AI as
 * it is then, and, once it's turned on, what its model said when it searched, or else null.
 */
export interface WebSearchChanged {
  assistant: AssistantSettings;
  found: string | null;
}

/** Why a change to Search the web is refused before anything's asked. */
export const WEB_SEARCH_REFUSED = "Say whether @ember searches the web.";

/** Why Search the web can't turn on for `model`, which has no tool for it that AI Gateway passes on. */
export const cannotSearchWith = (model: string) =>
  `${modelName(model)} can't search the web through AI Gateway, but Anthropic's and OpenAI's models can. Choose one under Change.`;

/** Why it didn't turn on once the model was asked: Ember AI was changed or turned off meanwhile. */
export const WEB_SEARCH_CHANGED = "Ember AI changed while its model searched. Try again.";

/**
 * What Set up Ember AI gives `PUT /api/account/assistant`: the Cloudflare account's ID, an API token of
 * its with the Workers AI Read permission, which a change can leave out to keep the one Ember has, and
 * the ID of the model to answer with.
 */
export interface AssistantSetup {
  accountId: string;
  apiToken?: string;
  model: string;
}

/** What `PUT /api/account/assistant` answers once the model answered its test question: Ember AI as it is then, and what the model said. */
export interface AssistantSaved {
  assistant: AssistantSettings;
  greeting: string;
}

/** What `DELETE /api/account/assistant` answers: Ember AI is off. */
export interface AssistantForgotten {
  assistant: null;
}

/** A field of Set up Ember AI, which a refusal can be about. */
export type AssistantField = keyof AssistantSetup;

/** The longest model ID Ember takes, where Cloudflare's are a few dozen characters. */
export const MAX_MODEL_LENGTH = 200;

/** The longest API token Ember takes, which goes in a header of each request to Cloudflare. */
const MAX_API_TOKEN_LENGTH = 200;

/** Why Set up Ember AI's fields are refused before Cloudflare is asked about them. */
export const ACCOUNT_ID_REFUSED = "An account ID is 32 letters and digits. Copy it from Workers AI's Use REST API in the Cloudflare dashboard.";
export const API_TOKEN_REFUSED = "Paste an API token from Account API tokens in the Cloudflare dashboard.";
export const MODEL_REFUSED = "A model's ID has a slash, such as anthropic/claude-sonnet-5.5. Copy it from Cloudflare's model catalog.";

/** The Cloudflare account ID `text` gives, without the spaces around it and in small letters, or null when it can't be one: 32 hexadecimal digits. */
export function accountIdOf(text: string): string | null {
  const accountId = text.trim().toLowerCase();
  return /^[0-9a-f]{32}$/.test(accountId) ? accountId : null;
}

/** The Cloudflare API token `text` gives, without the spaces around it, or null when it can't be one: tokens have no spaces, and are a few dozen characters. */
export function apiTokenOf(text: string): string | null {
  const apiToken = text.trim();
  return apiToken.length >= 20 && apiToken.length <= MAX_API_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(apiToken) ? apiToken : null;
}

/**
 * The model ID `text` gives, without the spaces around it, or null when it can't be one: Cloudflare's
 * name the company and then the model, as `company/model`, and Workers AI's start with `@cf/`.
 */
export function modelOf(text: string): string | null {
  const model = text.trim();
  return model.length <= MAX_MODEL_LENGTH && /^@?[\w.-]+(?:\/[\w.:@-]+)+$/.test(model) ? model : null;
}

/**
 * What `PUT /api/account/assistant` gives Ember, as Set up Ember AI sends it, or why it can't be one, on
 * the field it's about. A blank API token is left out, keeping the one Ember has.
 */
export function parseAssistantSetup(data: unknown): AssistantSetup | { error: string; field: AssistantField } {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const accountId = typeof given.accountId === "string" ? accountIdOf(given.accountId) : null;
  if (accountId === null) return { error: ACCOUNT_ID_REFUSED, field: "accountId" };
  const { apiToken: typed } = given;
  if (typed !== undefined && typeof typed !== "string") return { error: API_TOKEN_REFUSED, field: "apiToken" };
  const apiToken = typed === undefined || typed.trim() === "" ? undefined : apiTokenOf(typed);
  if (apiToken === null) return { error: API_TOKEN_REFUSED, field: "apiToken" };
  const model = typeof given.model === "string" ? modelOf(given.model) : null;
  if (model === null) return { error: MODEL_REFUSED, field: "model" };
  return apiToken === undefined ? { accountId, model } : { accountId, apiToken, model };
}

/** What the AI assistant tab tells anyone but an administrator. */
export const ASSISTANT_FORBIDDEN = "Only administrators can set up Ember AI";
