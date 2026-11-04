import { ASSISTANT_NAME } from "@ember/protocol";
import {
  ASSISTANT_FORBIDDEN,
  ASSISTANT_MODELS,
  ASSISTANT_OFF,
  DEFAULT_MODEL_KEPT,
  MODEL_NOT_LISTED,
  MODELS_FULL,
  accountIdOf,
  modelName,
  modelOf,
  parseAssistantChanges,
  parseAssistantKeys,
  parseAssistantSetup,
  parseNewAssistantModel,
  parseYourAssistantChanges,
  type AssistantCatalog,
  type AssistantChanged,
  type AssistantForgotten,
  type AssistantSaved,
  type ModelFormat,
  type YourAssistantChanged,
} from "@ember/protocol/assistant";
import { credentialsOf } from "../auth";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { formAnswer } from "../pages";
import { workspace, type Credentials } from "../workspace";
import { catalogOf } from "./catalog";
import { ask, formatsFor, type Gateway, type GatewayRefusal, type Question } from "./gateway";

// Ember AI's setup, as administrators turn it on, change it and turn it off on the AI assistant tab of
// workspace settings, the models people can pick, which administrators add there from Cloudflare's
// catalog, and @ember's answers to each person, which they set the most of there, and each person picks
// the levels and model of on their profile. They answer JSON for the card, its dialogs and the profile.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
/** What's said of Ember AI is for administrators, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

/** Why Set up Ember AI needs an API token: Ember has none to keep. */
export const API_TOKEN_NEEDED = "Paste an API token. Ember doesn't have one yet.";
/** Why it needs one after the model answered: Ember AI was turned off meanwhile, or set up with another token. */
export const API_TOKEN_CHANGED = "Ember AI changed while the model answered, so Ember no longer has that API token. Paste an API token.";
/** Why Add a model didn't add one: Ember AI was set up again, with another account or API token, while the model answered. */
export const SETUP_CHANGED = "Ember AI was set up again while the model answered, so it wasn't added. Add it again.";

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
 * Who `request` signs in, if they're an administrator, or else what to answer them: that they aren't
 * signed in, or aren't one, before anything they sent is read.
 */
async function administratorOf(request: Request, env: Env): Promise<Credentials | Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, NOT_SIGNED_IN);
  return administrator ? credentials : problem(403, ASSISTANT_FORBIDDEN);
}

/**
 * `POST /api/account/assistant/catalog`, `{ accountId, apiToken? }`: the text models Cloudflare's catalog
 * lists for the account given, with the API token given, or the one Ember has, when none is, as Set up
 * Ember AI and Add a model list them, or else, when the catalog can't be read, the models Ember knows, and
 * why it can't. Someone who isn't an administrator hears so before anything they sent is read, and a field
 * that can't be what it's for is refused on that field.
 */
export async function listAssistantModels(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const keys = parseAssistantKeys(await jsonBodyOf(request));
  if ("error" in keys) return formAnswer(keys, 422);
  const apiToken = keys.apiToken ?? (await workspace(env).assistantGateway())?.apiToken;
  if (!apiToken) return formAnswer({ error: API_TOKEN_NEEDED, field: "apiToken" }, 422);
  const catalog = await catalogOf(env, { accountId: keys.accountId, apiToken });
  if ("refusal" in catalog) console.error(`Listing Ember's own models, as Cloudflare's catalog wasn't read: ${catalog.refusal}`);
  const answer: AssistantCatalog = "refusal" in catalog ? { models: [...ASSISTANT_MODELS], refusal: catalog.refusal } : { models: catalog, refusal: null };
  return Response.json(answer, { headers: PRIVATE });
}

/**
 * `PUT /api/account/assistant`, `{ accountId, apiToken, model, modelName? }`: turns Ember AI on, or
 * changes it, once the model has answered a test question through AI Gateway with the account and API
 * token given, or the API token Ember has, when none is, answering Ember AI as it is then and what the
 * model said. The model answers anyone who hasn't picked another, in place of the one that did among the
 * models people can pick. Someone who isn't an administrator hears so before anything they sent is read.
 * A field that can't be what it's for, or that AI Gateway refuses, is refused on that field, as is the
 * API token Ember had once it no longer has it, so that turning Ember AI off while the model answers
 * stays done.
 */
export async function saveAssistant(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const ember = workspace(env);
  const setup = parseAssistantSetup(await jsonBodyOf(request));
  if ("error" in setup) return formAnswer(setup, 422);
  const kept = setup.apiToken === undefined ? (await ember.assistantGateway())?.apiToken : undefined;
  const apiToken = setup.apiToken ?? kept;
  if (!apiToken) return formAnswer({ error: API_TOKEN_NEEDED, field: "apiToken" }, 422);
  const answered = await greetingFrom(env, { accountId: setup.accountId, apiToken, model: setup.model });
  if ("refusal" in answered) return refused(answered);
  const chosen = { accountId: setup.accountId, apiToken, model: setup.model, format: answered.format, ...(setup.modelName && { name: setup.modelName }) };
  const saved = await ember.changeAssistant(credentials, chosen, kept !== undefined);
  if (!saved) return problem(401, NOT_SIGNED_IN);
  if (saved === "changed") return formAnswer({ error: API_TOKEN_CHANGED, field: "apiToken" }, 422);
  if (saved === "forbidden" || !saved.assistant) return problem(403, ASSISTANT_FORBIDDEN);
  return Response.json({ assistant: saved.assistant, greeting: answered.greeting } satisfies AssistantSaved, { headers: PRIVATE });
}

/**
 * `POST /api/account/assistant/models`, `{ model, modelName? }`: adds the model to those people can pick,
 * as Add a model on the Ember AI card does, once it has answered a test question through Ember AI's
 * account, answering Ember AI as it is then and what the model said. Someone who isn't an administrator
 * hears so before anything they sent is read. A model that can't be one, or that AI Gateway refuses, is
 * refused on its field, and one that answered through Ember AI as it was before it was set up again isn't
 * added.
 */
export async function addAssistantModel(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const ember = workspace(env);
  const added = parseNewAssistantModel(await jsonBodyOf(request));
  if ("error" in added) return formAnswer(added, 422);
  const gateway = await ember.assistantGateway();
  if (!gateway) return problem(409, ASSISTANT_OFF);
  const answered = await greetingFrom(env, { accountId: gateway.accountId, apiToken: gateway.apiToken, model: added.model });
  if ("refusal" in answered) return refused(answered);
  const saved = await ember.addAssistantModel(credentials, { id: added.model, name: added.modelName ?? modelName(added.model), format: answered.format }, gateway);
  if (!saved) return problem(401, NOT_SIGNED_IN);
  if (saved === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  if (saved === "off") return problem(409, ASSISTANT_OFF);
  if (saved === "changed") return problem(409, SETUP_CHANGED);
  if (saved === "full") return formAnswer({ error: MODELS_FULL, field: "model" }, 422);
  return Response.json({ assistant: saved.assistant, greeting: answered.greeting } satisfies AssistantSaved, { headers: PRIVATE });
}

/**
 * `DELETE /api/account/assistant/models`, `{ model }`: takes the model out of those people can pick, as its
 * Remove on the Ember AI card does, answering Ember AI as it is then, but for the model @ember answers
 * everyone with. Someone who isn't an administrator hears so before anything they sent is read.
 */
export async function removeAssistantModel(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const body = await jsonBodyOf(request);
  const model = typeof body === "object" && body !== null && "model" in body && typeof body.model === "string" ? modelOf(body.model) : null;
  if (model === null) return problem(422, MODEL_NOT_LISTED);
  const removed = await workspace(env).removeAssistantModel(credentials, model);
  if (!removed) return problem(401, NOT_SIGNED_IN);
  if (removed === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  if (removed === "off") return problem(409, ASSISTANT_OFF);
  if (removed === "everyone's") return problem(409, DEFAULT_MODEL_KEPT);
  return Response.json(removed satisfies AssistantChanged, { headers: PRIVATE });
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
 * `PATCH /api/account/assistant`, `{ thinking?, length?, model? }`: changes the most each of @ember's dials
 * goes to for anyone's questions, as the Ember AI card's dials do while it's on, and which of the models
 * people can pick it answers everyone else with, as the card's Models do, answering Ember AI as it is
 * then. Someone who isn't an administrator hears so before anything they sent is read.
 */
export async function changeAssistantSettings(request: Request, env: Env): Promise<Response> {
  const credentials = await administratorOf(request, env);
  if (credentials instanceof Response) return credentials;
  const changes = parseAssistantChanges(await jsonBodyOf(request));
  if ("error" in changes) return problem(422, changes.error);
  const changed = await workspace(env).changeAssistantSettings(credentials, changes);
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "forbidden") return problem(403, ASSISTANT_FORBIDDEN);
  if (changed === "off") return problem(409, ASSISTANT_OFF);
  if (changed === "not listed") return problem(422, MODEL_NOT_LISTED);
  return Response.json(changed satisfies AssistantChanged, { headers: PRIVATE });
}

/**
 * `PATCH /api/users/me/assistant`, `{ thinking?, length?, model? }`: changes how much @ember thinks and how
 * long it answers you, as your profile's dials do, and the model it answers you with, as its Model menu
 * does, of those administrators let people pick, or theirs with null, answering @ember's answers to you
 * as they are then.
 */
export async function changeYourAssistant(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  if (!credentials) return problem(401, NOT_SIGNED_IN);
  const changes = parseYourAssistantChanges(await jsonBodyOf(request));
  if ("error" in changes) return problem(422, changes.error);
  const changed = await workspace(env).changeYourAssistant(credentials, changes);
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "not listed") return problem(422, MODEL_NOT_LISTED);
  return Response.json(changed satisfies YourAssistantChanged, { headers: PRIVATE });
}

/** What to answer when the model didn't answer its test question: why, on the field it's about, if one is. */
const refused = ({ refusal, field, status }: GatewayRefusal) => formAnswer({ error: refusal, ...(field && { field }) }, status);

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
