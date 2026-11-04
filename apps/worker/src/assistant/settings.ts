import { ASSISTANT_NAME } from "@ember/protocol";
import {
  ASSISTANT_FORBIDDEN,
  ASSISTANT_OFF,
  LEVELS_REFUSED,
  accountIdOf,
  parseAssistantSetup,
  parseLevelChanges,
  type AnswerLevelsAnswer,
  type AssistantChanged,
  type AssistantForgotten,
  type AssistantSaved,
  type ModelFormat,
} from "@ember/protocol/assistant";
import { credentialsOf } from "../auth";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { formAnswer } from "../pages";
import { workspace } from "../workspace";
import { ask, formatsFor, type Gateway, type GatewayRefusal, type Question } from "./gateway";

// Ember AI's setup, as administrators turn it on, change it and turn it off on the AI assistant tab of
// workspace settings, and the levels of @ember's answers, which they set the most of there, and each
// person picks on their profile. They answer JSON for the card, its dialog and the profile's dials.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
/** What's said of Ember AI is for administrators, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

/** Why Set up Ember AI needs an API token: Ember has none to keep. */
export const API_TOKEN_NEEDED = "Paste an API token. Ember doesn't have one yet.";
/** Why it needs one after the model answered: Ember AI was turned off meanwhile, or set up with another token. */
export const API_TOKEN_CHANGED = "Ember AI changed while the model answered, so Ember no longer has that API token. Paste an API token.";

/** What Set up Ember AI asks the model before Ember keeps it, so that it's known to answer. */
const TEST_QUESTION: Question = {
  instructions: `You are ${ASSISTANT_NAME}, the AI assistant in a team's chat, where people ask you things by mentioning @ember. An administrator has just set you up.`,
  turns: [{ role: "user", text: "Say hello to the team in one short sentence." }],
  // Room for a model that thinks before it answers, however short the answer.
  maxTokens: 2_000,
};

/** How long Set up Ember AI waits for each answer to its test question. */
const TEST_TIMEOUT_MS = 30_000;

/** The most of the model's hello the dialog shows. */
const MAX_GREETING_LENGTH = 500;

/**
 * The ID of the Cloudflare account the Worker is deployed to, which Set up Ember AI fills in, as the
 * deploy gave it, or null without one that can be an account's.
 */
export const deployedAccountIdOf = (env: Env): string | null => accountIdOf(env.CLOUDFLARE_ACCOUNT_ID ?? "");

/**
 * `PUT /api/account/assistant`, `{ accountId, apiToken, model }`: turns Ember AI on, or changes it, once
 * the model has answered a test question through AI Gateway with the account and API token given, or the
 * API token Ember has, when none is, answering Ember AI as it is then and what the model said. Someone who
 * isn't an administrator hears so before anything they sent is read. A field that can't be what it's for,
 * or that AI Gateway refuses, is refused on that field, as is the API token Ember had once it no longer
 * has it, so that turning Ember AI off while the model answers stays done.
 */
export async function saveAssistant(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const ember = workspace(env);
  const administrator = credentials && (await ember.canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, NOT_SIGNED_IN);
  if (!administrator) return problem(403, ASSISTANT_FORBIDDEN);
  const setup = parseAssistantSetup(await jsonBodyOf(request));
  if ("error" in setup) return formAnswer(setup, 422);
  const kept = setup.apiToken === undefined ? (await ember.assistantGateway())?.apiToken : undefined;
  const apiToken = setup.apiToken ?? kept;
  if (!apiToken) return formAnswer({ error: API_TOKEN_NEEDED, field: "apiToken" }, 422);
  const answered = await greetingFrom(env, { accountId: setup.accountId, apiToken, model: setup.model });
  if ("refusal" in answered) return formAnswer({ error: answered.refusal, ...(answered.field && { field: answered.field }) }, answered.status);
  const saved = await ember.changeAssistant(credentials, { accountId: setup.accountId, apiToken, model: setup.model, format: answered.format }, kept !== undefined);
  if (!saved) return problem(401, NOT_SIGNED_IN);
  if (saved === "changed") return formAnswer({ error: API_TOKEN_CHANGED, field: "apiToken" }, 422);
  if (saved === "forbidden" || !saved.assistant) return problem(403, ASSISTANT_FORBIDDEN);
  return Response.json({ assistant: saved.assistant, greeting: answered.greeting } satisfies AssistantSaved, { headers: PRIVATE });
}

/** `DELETE /api/account/assistant`: turns Ember AI off, as turning off its card's switch does, forgetting its API token. */
export async function forgetAssistant(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const forgotten = credentials && (await workspace(env).changeAssistant(credentials, null));
  if (!forgotten) return problem(401, NOT_SIGNED_IN);
  if (forgotten === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  return Response.json({ assistant: null } satisfies AssistantForgotten, { headers: PRIVATE });
}

/**
 * `PATCH /api/account/assistant`, `{ thinking?, length? }`: changes the most each of @ember's dials goes
 * to for anyone's questions, as the Ember AI card's dials do while it's on, answering Ember AI as it is
 * then. Someone who isn't an administrator hears so before anything they sent is read.
 */
export async function changeAssistantMost(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const ember = workspace(env);
  const administrator = credentials && (await ember.canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, NOT_SIGNED_IN);
  if (!administrator) return problem(403, ASSISTANT_FORBIDDEN);
  const changes = parseLevelChanges(await jsonBodyOf(request));
  if (!changes) return problem(422, LEVELS_REFUSED);
  const changed = await ember.changeAssistantMost(credentials, changes);
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  if (changed === "off") return problem(409, ASSISTANT_OFF);
  return Response.json(changed satisfies AssistantChanged, { headers: PRIVATE });
}

/**
 * `PATCH /api/users/me/assistant`, `{ thinking?, length? }`: changes how much @ember thinks and how long
 * it answers you, as your profile's dials do, answering your levels as they are then.
 */
export async function changeAnswerLevels(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const changes = parseLevelChanges(await jsonBodyOf(request));
  if (!changes) return problem(422, LEVELS_REFUSED);
  const changed = await workspace(env).changeAnswerLevels(credentials, changes);
  return changed ? Response.json(changed satisfies AnswerLevelsAnswer, { headers: PRIVATE }) : problem(401, NOT_SIGNED_IN);
}

/**
 * What the model `gateway` names says to the test question, and the format it took it in, trying each
 * format in turn while the model is refused in one (`formatsFor`), or why it didn't answer: the first
 * format's refusal, unless another's says more.
 */
async function greetingFrom(env: Env, gateway: Omit<Gateway, "format">): Promise<{ format: ModelFormat; greeting: string } | GatewayRefusal> {
  let first: GatewayRefusal | null = null;
  for (const format of formatsFor(gateway.model)) {
    const answer = await ask(env, { ...gateway, format }, TEST_QUESTION, TEST_TIMEOUT_MS);
    if (!("refusal" in answer)) return { format, greeting: greetingOf(answer.text) };
    if (!answer.wrongFormat) return answer;
    first ??= answer;
  }
  return first!;
}

/** `text` cut to what the dialog shows. */
const greetingOf = (text: string) => (text.length > MAX_GREETING_LENGTH ? `${text.slice(0, MAX_GREETING_LENGTH - 1).trimEnd()}…` : text);
