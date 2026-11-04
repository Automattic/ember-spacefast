import { ASSISTANT_MODELS, MODEL_FORMATS, type AssistantField, type ModelFormat, type ThinkingLevel } from "@ember/protocol/assistant";
import type { Env } from "../env";
import { isLoopback } from "../loopback";

// Asking a model through Cloudflare's AI Gateway, with the AI REST API on api.cloudflare.com, in
// whichever of its three formats the model takes (https://developers.cloudflare.com/ai-gateway/usage/rest-api/).
// Every request goes through the account's default gateway, whose logs, caching, rate limits and spend
// limits apply, and which Cloudflare makes on the account's first request.

/** Where Cloudflare's API is. */
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** The gateway Ember's requests go through. Workers AI's models need it named; other companies' go through it anyway. */
const GATEWAY_ID = "default";

/** Where each format's requests go, under the account's `ai/v1`. */
const PATHS: Record<ModelFormat, string> = { messages: "messages", responses: "responses", chat: "chat/completions" };

/** The most of Cloudflare's own words about a refusal that Ember passes on. */
const MAX_QUOTED_LENGTH = 200;

/** What Ember asks AI Gateway with: a Cloudflare account, an API token of its, a model and the format the model takes. */
export interface Gateway {
  accountId: string;
  apiToken: string;
  model: string;
  format: ModelFormat;
}

/** One turn of a conversation for a model to go on with: what someone wrote, or one of the model's own answers. */
export interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * What to ask a model: how it should answer, the conversation, oldest first, ending with what it's asked,
 * the most tokens its answer may take, its thinking among them, how much to think first, if it's told,
 * and who asked, if someone did, whom AI Gateway's logs and spend limits then know each request by
 * (custom metadata's `user_id`).
 */
export interface Question {
  instructions: string;
  turns: Turn[];
  maxTokens: number;
  thinking?: ThinkingLevel;
  askerId?: string;
}

/**
 * What went wrong asking a model: Cloudflare didn't take the API token, or found no such account, AI
 * Gateway's credits ran out, the model wasn't taken, AI Gateway turned the request away, the conversation
 * was longer than the model reads, AI Gateway didn't answer, the model answered with nothing, or it took
 * every token it could before it answered anything.
 */
export type RefusalReason = "token" | "account" | "credits" | "model" | "busy" | "too long" | "unanswered" | "nothing" | "out of room";

/**
 * Why a model didn't answer, in words an administrator can act on, with what went wrong, the status to
 * answer them with and the field of Set up Ember AI it's about, if one is: `wrongFormat` when the model
 * was refused in a way another format might not be.
 */
export interface GatewayRefusal {
  status: number;
  reason: RefusalReason;
  refusal: string;
  field?: AssistantField;
  wrongFormat?: boolean;
}

export const GATEWAY_UNANSWERED = "AI Gateway didn't answer. Try again in a moment.";
export const NOTHING_ANSWERED = "The model answered with nothing. Try again, or choose another model.";
export const OUT_OF_ROOM = "The model took every token it could before it answered. Try again, or choose another model.";

/** A model's answer: its text, and whether it was cut short, as it took every token it could. */
export interface Answered {
  text: string;
  cut?: true;
}

/**
 * What the model `gateway` names answers `question` in its format, or why it didn't, waiting at most
 * `timeoutMs` for it. A model that doesn't take being told how much to think is asked again without.
 */
export async function ask(env: Env, gateway: Gateway, question: Question, timeoutMs: number): Promise<Answered | GatewayRefusal> {
  const answered = await askOnce(env, gateway, question, timeoutMs);
  if (question.thinking === undefined || !("refusal" in answered) || !answered.wrongFormat) return answered;
  console.error(`Asking ${gateway.model} again without a thinking level, which it didn't take: ${answered.refusal}`);
  const { thinking: _, ...unthinking } = question;
  return askOnce(env, gateway, unthinking, timeoutMs);
}

/** What the model `gateway` names answers `question`, asked once. */
async function askOnce(env: Env, gateway: Gateway, question: Question, timeoutMs: number): Promise<Answered | GatewayRefusal> {
  let response: Response;
  try {
    response = await fetch(`${cloudflareApiOf(env)}/accounts/${gateway.accountId}/ai/v1/${PATHS[gateway.format]}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gateway.apiToken}`,
        "Content-Type": "application/json",
        "cf-aig-gateway-id": GATEWAY_ID,
        ...(question.askerId !== undefined && { "cf-aig-metadata": JSON.stringify({ user_id: question.askerId }) }),
      },
      body: JSON.stringify(requestOf(gateway, question)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.error("Asking AI Gateway failed:", error instanceof Error ? error.name : "unknown error");
    return { status: 502, reason: "unanswered", refusal: GATEWAY_UNANSWERED };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) return refusalOf(response.status, body);
  const text = answerIn(gateway.format, body)?.trim();
  const cut = ranOutIn(gateway.format, body);
  if (text) return cut ? { text, cut } : { text };
  return cut ? { status: 502, reason: "out of room", refusal: OUT_OF_ROOM, field: "model" } : { status: 502, reason: "nothing", refusal: NOTHING_ANSWERED, field: "model" };
}

/**
 * The formats to ask `model` in, the one it's likeliest to take first: a listed model's, else Messages
 * for Anthropic's, which take nothing else, Responses for OpenAI's, some of which take only that, and
 * Chat Completions for the rest.
 */
export function formatsFor(model: string): ModelFormat[] {
  const listed = ASSISTANT_MODELS.find(({ id }) => id === model)?.format;
  const first = listed ?? (model.startsWith("anthropic/") ? "messages" : model.startsWith("openai/") ? "responses" : "chat");
  return [first, ...MODEL_FORMATS.filter((format) => format !== first)];
}

/** Where Cloudflare's API is: the browser tests' stand-in, which `AI_GATEWAY_URL` names at a loopback address, or Cloudflare's own. */
export function cloudflareApiOf(env: Env): string {
  const standIn = URL.parse(env.AI_GATEWAY_URL?.trim() ?? "");
  return standIn && isLoopback(standIn) ? standIn.origin : CLOUDFLARE_API;
}

/**
 * The body of a request asking `question` in `gateway`'s format, telling the model how much to think as
 * the format does: Anthropic's adaptive thinking at an effort, whose lowest is as little as their models
 * think, OpenAI's reasoning effort, or Chat Completions' `reasoning_effort`, "none" for no thinking.
 */
function requestOf({ model, format }: Gateway, { instructions, turns, maxTokens, thinking }: Question): Record<string, unknown> {
  const effort = thinking === "off" ? "none" : thinking;
  if (format === "messages") {
    const messages = alternating(turns).map(({ role, text }) => ({ role, content: text }));
    return { model, max_tokens: maxTokens, system: instructions, messages, ...(effort && { thinking: { type: "adaptive" }, output_config: { effort: effort === "none" ? "low" : effort } }) };
  }
  if (format === "responses") {
    return { model, max_output_tokens: maxTokens, instructions, input: turns.map(({ role, text }) => ({ role, content: text })), ...(effort && { reasoning: { effort } }) };
  }
  return {
    model,
    max_completion_tokens: maxTokens,
    messages: [{ role: "system", content: instructions }, ...turns.map(({ role, text }) => ({ role, content: text }))],
    ...(effort && { reasoning_effort: effort }),
  };
}

/**
 * `turns` as Anthropic's Messages takes them: starting with someone's, and taking turns, so that what
 * several people wrote in a row is one turn, a blank line apart.
 */
export function alternating(turns: Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last?.role === turn.role) last.text = `${last.text}\n\n${turn.text}`;
    else if (last || turn.role === "user") merged.push({ ...turn });
  }
  return merged;
}

/** The text of a model's answer in `format`, leaving out its thinking, or null without any. */
function answerIn(format: ModelFormat, body: unknown): string | null {
  if (!isObject(body)) return null;
  if (format === "messages") return textOf(body.content, "text");
  if (format === "responses") {
    const messages = Array.isArray(body.output) ? body.output.filter((item): item is Record<string, unknown> => isObject(item) && item.type === "message") : [];
    return messages.map((message) => textOf(message.content, "output_text") ?? "").join("") || (typeof body.output_text === "string" ? body.output_text : null);
  }
  const [choice] = Array.isArray(body.choices) ? body.choices : [];
  const content = isObject(choice) && isObject(choice.message) ? choice.message.content : null;
  return typeof content === "string" ? content : textOf(content, "text");
}

/** Whether a model's answer in `format` stopped where it did because it took every token it could. */
function ranOutIn(format: ModelFormat, body: unknown): boolean {
  if (!isObject(body)) return false;
  if (format === "messages") return body.stop_reason === "max_tokens";
  if (format === "responses") return body.status === "incomplete" && isObject(body.incomplete_details) && body.incomplete_details.reason === "max_output_tokens";
  const [choice] = Array.isArray(body.choices) ? body.choices : [];
  return isObject(choice) && choice.finish_reason === "length";
}

/** The text of the parts of `content` whose type is `type`, joined, or null without any. */
function textOf(content: unknown, type: string): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content.filter((part) => isObject(part) && part.type === type && typeof part.text === "string").map((part) => part.text as string);
  return texts.length > 0 ? texts.join("") : null;
}

/**
 * Why AI Gateway refused a request with `status`, from its `body`, which is Cloudflare's, with errors and
 * their codes, or the format's own, with an error, and says in words what to do, with Cloudflare's own.
 */
export function refusalOf(status: number, body: unknown): GatewayRefusal {
  const { codes, message } = errorIn(body);
  const said = (lead: string) => (message ? `${lead} Cloudflare says: ${quoted(message)}` : lead);
  if (status === 401 || (status === 403 && codes.includes(10000))) {
    const refusal = said("Cloudflare didn't take that API token for this account. Check the account ID, and that the token has the Workers AI Read permission.");
    return { status: 422, reason: "token", field: "apiToken", refusal };
  }
  // "Could not route to /client/v4/accounts/…, perhaps your object identifier is invalid?"
  if (codes.includes(7003) || codes.includes(7000)) {
    return { status: 422, reason: "account", field: "accountId", refusal: said("Cloudflare has no account with that ID that the token can reach.") };
  }
  if (status === 402) {
    const refusal = said("This model is paid for with AI Gateway's credits, and there aren't enough. Top them up under Credits Available in AI Gateway, or choose a Workers AI model.");
    return { status: 422, reason: "credits", refusal };
  }
  if (status === 403) return { status: 422, reason: "model", field: "model", refusal: said("Cloudflare won't run that model for this account.") };
  if (status === 413) return { status: 422, reason: "too long", refusal: said("The model can't read that much at once.") };
  if (status === 400 || status === 404 || status === 422) return { status: 422, reason: "model", field: "model", refusal: said("AI Gateway didn't take that model."), wrongFormat: true };
  if (status === 429) return { status: 429, reason: "busy", refusal: said("AI Gateway is turning requests away for now, or a spend limit was reached. Try again later.") };
  return { status: 502, reason: "unanswered", refusal: said(GATEWAY_UNANSWERED) };
}

/** The codes and the first message of the errors in a refusal's body, in any of the shapes AI Gateway answers with. */
function errorIn(body: unknown): { codes: number[]; message: string | null } {
  if (!isObject(body)) return { codes: [], message: null };
  const errors = Array.isArray(body.errors) ? body.errors.filter(isObject) : [];
  const codes = errors.map(({ code }) => code).filter((code): code is number => typeof code === "number");
  const error = isObject(body.error) ? body.error.message : body.error;
  const message = [errors[0]?.message, error, body.message].find((text): text is string => typeof text === "string" && text.trim() !== "");
  return { codes, message: message?.trim() ?? null };
}

/** `message` cut to what Ember passes on. */
const quoted = (message: string) => (message.length > MAX_QUOTED_LENGTH ? `${message.slice(0, MAX_QUOTED_LENGTH - 1).trimEnd()}…` : message);

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
