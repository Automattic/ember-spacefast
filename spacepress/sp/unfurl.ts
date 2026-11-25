import { mutation } from "spacepress";
import { createHash } from "node:crypto";
import { home_url, wp_strip_all_tags } from "php/wordpress";
import { linkPreviews } from "spacepress:db";
import { actor } from "./access";
import { consumeRate } from "./records";

export function publicAddress(value: string) {
  if (value.length > 2048 || /[\s\\<>"']/u.test(value)) return "";
  const host = value.match(/^https:\/\/([a-zA-Z0-9.-]+)(?:\/|\?|#|$)/)?.[1]?.toLowerCase() ?? "";
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return "";
  if (/\.(?:local|localhost|internal|test|invalid|onion)$/.test(host)) return "";
  return value;
}

function content(value: string, limit: number) {
  return wp_strip_all_tags(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

async function fetchPreview(target: string) {
  try {
    const response = await fetch(target, { redirect: "error", headers: { Accept: "text/html", Range: "bytes=0-65535" } });
    if (!response.ok || response.redirected || !(response.headers.get("content-type") ?? "").startsWith("text/html")) return null;
    const body = (await response.text()).slice(0, 65536);
    const head = body.split("</head>")[0] ?? "";
    let title = head.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] ?? "";
    let description = "";
    let openGraphDescription = "";
    for (const tag of head.match(/<meta\s[^>]{1,3500}>/g) ?? []) {
      const name = tag.match(/\s(?:name|property)=["']([^"']+)["']/)?.[1];
      const value = tag.match(/\scontent=["']([^"']+)["']/)?.[1] ?? "";
      if (name === "og:title") title = value || title;
      if (name === "description") description = value;
      if (name === "og:description") openGraphDescription = value;
    }
    return title ? { url: target, title: content(title, 160), description: content(openGraphDescription || description, 280), image: null } : null;
  } catch {
    return null;
  }
}

export const unfurl = mutation({ access: "authenticated" }, async ({ url }: { url: string }) => {
  const user = await actor();
  const target = publicAddress(url.split("#")[0] ?? "");
  const root = home_url("/").toLowerCase();
  if (!target || target.toLowerCase().startsWith(root) || target.toLowerCase() + "/" === root) return null;
  const key = createHash("sha256").update(user.id + "\n" + target).digest("hex");
  const [existing] = await linkPreviews.system.list({ where: { key }, limit: 1 });
  const now = Date.now();
  if (existing && existing.expiresAt > now) {
    return existing.title ? { url: target, title: existing.title, description: existing.description, image: null } : null;
  }
  await consumeRate(user.id + ":link-preview", 12, 60000);
  const preview = await fetchPreview(target);
  const fields = { title: preview?.title ?? "", description: preview?.description ?? "", expiresAt: now + 1800000 };
  if (existing) await linkPreviews.system.update(existing.id, fields);
  else await linkPreviews.system.create({ key, ...fields });
  const expired = await linkPreviews.system.list({ where: { expiresAt: { lt: now } }, limit: 8 });
  for (const record of expired) await linkPreviews.system.delete(record.id);
  return preview;
});
