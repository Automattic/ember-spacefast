import { CALLS_FORBIDDEN, parseCallsSetup, type CallsForgotten, type CallsSaved, type CallsSettings } from "@ember/protocol/calls";
import { credentialsOf } from "../auth";
import { jsonBodyOf } from "../bodies";
import type { Env } from "../env";
import { formAnswer } from "../pages";
import { workspace } from "../workspace";
import { refusalOfApp } from "./sfu";

// Calls' setup, as administrators turn calls on, change the Realtime SFU app they run through and turn
// them off on the Calls card of workspace settings' Rooms and permissions. They answer JSON for the card
// and its dialog.

const problem = (status: number, message: string) => Response.json({ error: message }, { status });

const NOT_SIGNED_IN = "Not signed in";
/** What's said of calls' setup is for administrators, which no cache should keep. */
const PRIVATE = { "Cache-Control": "no-store" };

/**
 * `PUT /api/account/calls`, `{ appId, appSecret }`: turns calls on, or changes the SFU app they run
 * through, once Cloudflare's Realtime SFU has started a session with the app's keys, answering calls as
 * they are then. Someone who isn't an administrator hears so before anything they sent is read. A key
 * that can't be one, or that the SFU refuses, is refused on its field.
 */
export async function saveCalls(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  const administrator = credentials && (await workspace(env).canAdminister(credentials));
  if (!credentials || administrator === null) return problem(401, NOT_SIGNED_IN);
  if (!administrator) return problem(403, CALLS_FORBIDDEN);
  const app = parseCallsSetup(await jsonBodyOf(request));
  if ("error" in app) return formAnswer(app, 422);
  const refusal = await refusalOfApp(env, app);
  if (refusal) return formAnswer({ error: refusal.error, ...(refusal.field && { field: refusal.field }) }, refusal.status);
  return callsAnswer(await workspace(env).changeCalls(credentials, app));
}

/** `DELETE /api/account/calls`: turns calls off, as the Calls card's switch does, which forgets the SFU app's keys. */
export async function forgetCalls(request: Request, env: Env): Promise<Response> {
  const credentials = await credentialsOf(request, env);
  return callsAnswer(credentials && (await workspace(env).changeCalls(credentials, null)));
}

/** The answer to changing calls: calls as they are then, or who can't change them. */
function callsAnswer(changed: { calls: CallsSettings | null } | "forbidden" | null): Response {
  if (!changed) return problem(401, NOT_SIGNED_IN);
  if (changed === "forbidden") return problem(403, CALLS_FORBIDDEN);
  return Response.json(changed satisfies CallsSaved | CallsForgotten, { headers: PRIVATE });
}
