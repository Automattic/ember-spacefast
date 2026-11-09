import { APP_ID_UNKNOWN, APP_SECRET_UNKNOWN, HUDDLES_UNCHECKED, type HuddlesField, type HuddlesSetup } from "@ember/protocol/huddles";
import type { Env } from "../env";
import { isLoopback } from "../loopback";

// Cloudflare's Realtime SFU, which huddles run through, by its HTTPS API
// (https://developers.cloudflare.com/realtime/sfu/https-api/). A request names an SFU app by its ID and
// carries the app's secret as its bearer token, so only the Worker asks, and the secret never leaves it.
// What the SFU answers is logged by its status and error code alone.

/** Where the SFU's API is. */
const SFU_API = "https://rtc.live.cloudflare.com/v1";
/** How long the SFU has to answer. */
const SFU_TIMEOUT_MS = 10_000;
/** The most of an error code of the SFU's that's logged. */
const MAX_LOGGED_CODE_LENGTH = 40;

/** A Realtime SFU app's keys: its ID and its secret, as Cloudflare's dashboard shows them when the app is made. */
export type SfuApp = HuddlesSetup;

/** Where the SFU's API is: the browser tests' stand-in, which `REALTIME_SFU_URL` names at a loopback address, or Cloudflare's own. */
function sfuApiOf(env: Env): string {
  const standIn = URL.parse(env.REALTIME_SFU_URL?.trim() ?? "");
  return standIn && isLoopback(standIn) ? `${standIn.origin}/v1` : SFU_API;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The error code the SFU refuses a request with, if it answers one, as far as it's logged. */
function errorCodeOf(said: unknown): string | null {
  const code = isRecord(said) ? said.errorCode : null;
  return typeof code === "string" ? code.slice(0, MAX_LOGGED_CODE_LENGTH) : null;
}

/**
 * Why `app`'s keys aren't kept, as the SFU answers a request to start a session with them: the field
 * it's about and the status to refuse them with, or null once it has started one, which says that the
 * app is there and that the secret is its own. Nobody connects to that session, so the SFU drops it by
 * itself.
 */
export async function refusalOfApp(env: Env, app: SfuApp): Promise<{ error: string; field?: HuddlesField; status: number } | null> {
  let answer: Response;
  let said: unknown;
  try {
    answer = await fetch(`${sfuApiOf(env)}/apps/${app.appId}/sessions/new`, {
      method: "POST",
      headers: { Authorization: `Bearer ${app.appSecret}` },
      redirect: "manual",
      signal: AbortSignal.timeout(SFU_TIMEOUT_MS),
    });
    said = await answer.json().catch(() => null);
  } catch (error) {
    console.error("Asking the Realtime SFU to start a session failed:", error instanceof Error ? error.name : "unknown error");
    return { error: HUDDLES_UNCHECKED, status: 502 };
  }
  if (answer.ok && isRecord(said) && typeof said.sessionId === "string") return null;
  const code = errorCodeOf(said);
  console.warn("The Realtime SFU didn't start a session:", answer.status, code);
  if (answer.status === 404 || code === "not_found") return { error: APP_ID_UNKNOWN, field: "appId", status: 422 };
  if (answer.status === 401 || answer.status === 403 || code === "unauthorized") return { error: APP_SECRET_UNKNOWN, field: "appSecret", status: 422 };
  return { error: HUDDLES_UNCHECKED, status: 502 };
}
