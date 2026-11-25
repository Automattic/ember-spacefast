import { mutation } from "spacepress";
import { wp_strip_all_tags } from "php/wordpress";
import { actor } from "./access";

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

export const unfurl = mutation({ access: "authenticated", rateLimit: "20/min" }, async ({ url }: { url: string }) => {
  await actor();
  const target = publicAddress(url);
  if (!target) return null;
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
});
