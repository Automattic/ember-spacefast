import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SFU_APP, SFU_PORT } from "../../projects/workspace-settings";

// Cloudflare's Realtime SFU for the huddles spec, at the address the second test server's REALTIME_SFU_URL
// names, as Ember asks it (apps/worker/src/huddles/sfu.ts): it knows one app, `SFU_APP`, starts a session
// for it when asked with its secret, and refuses as Cloudflare does an app it doesn't know, or a secret
// that isn't the app's. Cloudflare documents that refusal's error code but not its status, so 401 here
// is a guess, and Ember reads either.

/** What Ember asked the SFU: how, where, and with which secret. */
export interface SfuAsked {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface FakeSfu {
  /** What it was asked, in order. */
  asked: SfuAsked[];
  close(): Promise<void>;
}

/** Starts the SFU. */
export async function startFakeSfu(): Promise<FakeSfu> {
  const asked: SfuAsked[] = [];
  const server = createServer((request, response) => answer(request, response, asked));
  await new Promise<void>((resolve) => server.listen(SFU_PORT, "127.0.0.1", resolve));
  return { asked, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function answer(request: IncomingMessage, response: ServerResponse, asked: SfuAsked[]): void {
  const { method = "", url = "" } = request;
  const { authorization } = request.headers;
  asked.push({ method, path: url, authorization });
  const say = (status: number, body: unknown) => void response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  const appId = /^\/v1\/apps\/([^/]+)\/sessions\/new$/.exec(url)?.[1];
  if (method !== "POST" || appId !== SFU_APP.appId) {
    return say(404, { errorCode: "not_found", errorDescription: `appId ${appId ?? ""} does not exist. If you created or modified the App recently, it may take up to 60 seconds to reflect changes globally.` });
  }
  if (authorization !== `Bearer ${SFU_APP.appSecret}`) return say(401, { errorCode: "unauthorized", errorDescription: "The SFU App Secret was not accepted." });
  say(201, { sessionId: randomUUID().replaceAll("-", "") });
}
