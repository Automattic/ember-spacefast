import { esc_html } from "php/wordpress";
import { publicAddress } from "./unfurl";

export type SlackText = {
  type?: string; text?: string; url?: string; name?: string; image_url?: string; alt_text?: string;
  elements?: unknown[]; style?: { bold?: boolean; italic?: boolean; strike?: boolean; code?: boolean };
};

export function slackAddress(raw: string) {
  const url = raw.replaceAll("&amp;", "&");
  const https = url.startsWith("http://") ? "https://" + url.slice(7) : url;
  return publicAddress(https) ? url : "";
}

export function plainSlack(text: string) {
  const raw = text.replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
  return "<p>" + esc_html(raw.slice(0, 20000)).replaceAll("\n", "<br>") + "</p>";
}

function slackLink(encoded: string) {
  const parts = encoded.slice(4, -4).split("|");
  const url = slackAddress(parts[0] ?? "");
  const label = esc_html(parts[1] ?? parts[0] ?? "");
  return url ? '<a href="' + esc_html(url) + '">' + label + "</a>" : label;
}

export function slackMarkup(raw: string) {
  const tokens = esc_html(raw.slice(0, 20000)).split(/(&lt;https?:\/\/[^\s<>]{1,3000}?&gt;)/g);
  const text = tokens.map((token, index) => {
    const value = token ?? "";
    return index % 2 ? slackLink(value) : value
      .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
      .replace(/_([^_\n]+)_/g, "<em>$1</em>")
      .replace(/~([^~\n]+)~/g, "<s>$1</s>")
      .replace(/`([^`\n]+)`/g, "<code>$1</code>");
  }).join("");
  return "<p>" + text.replaceAll("\n", "<br>") + "</p>";
}

export function slackTextHtml(entry?: SlackText) {
  const text = entry?.text ?? "";
  return entry?.type === "plain_text" ? plainSlack(text) : slackMarkup(text);
}

function inline(nodes: unknown[]) {
  let html = "";
  for (const raw of nodes.slice(0, 100)) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as SlackText;
    let part = esc_html(node.text ?? "");
    if (node.type === "link") {
      const url = slackAddress(node.url ?? "");
      part = url ? '<a href="' + esc_html(url) + '">' + (part || esc_html(url)) + "</a>" : part;
    } else if (node.type === "emoji") part = ":" + esc_html(node.name ?? "") + ":";
    const style = node.style;
    if (style?.bold) part = "<strong>" + part + "</strong>";
    if (style?.italic) part = "<em>" + part + "</em>";
    if (style?.strike) part = "<s>" + part + "</s>";
    if (style?.code) part = "<code>" + part + "</code>";
    html += part;
  }
  return html;
}

export function slackRichText(nodes: unknown[]) {
  let html = "";
  for (const raw of nodes.slice(0, 100)) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as SlackText;
    const elements = node.elements ?? [];
    if (node.type === "rich_text_list") {
      let list = "";
      for (const rawItem of elements.slice(0, 100)) {
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as SlackText;
        list += "<li>" + inline(item.elements ?? []) + "</li>";
      }
      html += "<ul>" + list + "</ul>";
    } else {
      const contents = inline(elements);
      const tag = node.type === "rich_text_quote" ? "blockquote" : node.type === "rich_text_preformatted" ? "pre" : "p";
      html += "<" + tag + ">" + contents + "</" + tag + ">";
    }
  }
  return html;
}
