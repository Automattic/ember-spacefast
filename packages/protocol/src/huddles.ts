// Huddles, in which people in a room talk to each other through Cloudflare's Realtime SFU, by an SFU app
// in the Cloudflare account of whoever runs Ember, whose keys administrators give it in Set up huddles,
// behind the Huddles card of workspace settings, through `/api/account/huddles`.

/** Huddles as the Huddles card shows them to administrators while they're on: the SFU app they run through, by its ID. */
export interface HuddlesSettings {
  appId: string;
}

/** What Set up huddles gives `PUT /api/account/huddles`: a Realtime SFU app's ID and its secret, as Cloudflare's dashboard shows them when the app is made. */
export interface HuddlesSetup {
  appId: string;
  appSecret: string;
}

/** What `PUT /api/account/huddles` answers once Cloudflare has taken the app's keys: huddles as they are then. */
export interface HuddlesSaved {
  huddles: HuddlesSettings;
}

/** What `DELETE /api/account/huddles` answers: huddles are off. */
export interface HuddlesForgotten {
  huddles: null;
}

/** A field of Set up huddles, which a refusal can be about. */
export type HuddlesField = "appId" | "appSecret";

/** How long an SFU app's ID is, and its secret, as Cloudflare's API gives them. */
const APP_ID_LENGTH = 32;
const APP_SECRET_LENGTH = 64;

/** Why Set up huddles' fields are refused before Cloudflare is asked about them. */
export const APP_ID_REFUSED = `An App ID is ${APP_ID_LENGTH} letters and digits. Copy it from your app under Realtime's Serverless SFU in the Cloudflare dashboard.`;
export const APP_SECRET_REFUSED = `An App Secret is ${APP_SECRET_LENGTH} letters and digits. Copy it from your app under Realtime's Serverless SFU in the Cloudflare dashboard.`;

/** Why they're refused once Cloudflare has been asked to start a session with them, or couldn't be. */
export const APP_ID_UNKNOWN = "Cloudflare doesn't know that App ID. Copy it again from your app, or try again in a minute if you've just made it.";
export const APP_SECRET_UNKNOWN = "Cloudflare didn't take that App Secret for this app. Copy both from the same app.";
export const HUDDLES_UNCHECKED = "Ember couldn't reach Cloudflare to check the app's keys. Try again.";

/** What the Huddles card tells anyone but an administrator. */
export const HUDDLES_FORBIDDEN = "Only administrators can set up huddles";

/** The SFU app ID `text` gives, without the spaces around it, or null when it can't be one: 32 letters and digits. */
export function appIdOf(text: string): string | null {
  const appId = text.trim();
  return appId.length === APP_ID_LENGTH && /^[0-9a-z]+$/i.test(appId) ? appId : null;
}

/** The SFU app secret `text` gives, without the spaces around it, or null when it can't be one: 64 letters and digits. */
export function appSecretOf(text: string): string | null {
  const appSecret = text.trim();
  return appSecret.length === APP_SECRET_LENGTH && /^[0-9a-z]+$/i.test(appSecret) ? appSecret : null;
}

/** What `PUT /api/account/huddles` gives Ember, as Set up huddles sends it, or why it can't be an app's keys, on the field it's about. */
export function parseHuddlesSetup(data: unknown): HuddlesSetup | { error: string; field: HuddlesField } {
  const given = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  const appId = typeof given.appId === "string" ? appIdOf(given.appId) : null;
  if (appId === null) return { error: APP_ID_REFUSED, field: "appId" };
  const appSecret = typeof given.appSecret === "string" ? appSecretOf(given.appSecret) : null;
  if (appSecret === null) return { error: APP_SECRET_REFUSED, field: "appSecret" };
  return { appId, appSecret };
}
