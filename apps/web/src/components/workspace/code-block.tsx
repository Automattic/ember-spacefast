import { createElement, useContext, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { DisplayElement } from "@ember/richtext/dom";
import { Copy } from "@/components/icons/iconoir";
import { copyWithSuccess } from "@/lib/clipboard";
import type { Token } from "@/lib/highlight";
import { marked, SearchMarks } from "./search-marks";

type Highlighter = typeof import("@/lib/highlight");

let highlighter: Highlighter | undefined;
let loading: Promise<Highlighter> | undefined;

/** highlight.js and its languages, loaded the first time a message has code to highlight. */
function loadHighlighter(): Promise<Highlighter> {
  loading ??= import("@/lib/highlight").then(
    (module) => (highlighter = module),
    (error: unknown) => {
      // The next code block tries again.
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/** The highlighter once it's loaded, which it loads when `wanted`. */
function useHighlighter(wanted: boolean): Highlighter | undefined {
  const [loaded, setLoaded] = useState(highlighter);
  useEffect(() => {
    if (!wanted || loaded) return;
    let current = true;
    loadHighlighter().then(
      (module) => current && setLoaded(module),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [wanted, loaded]);
  return loaded;
}

/** A code block's code when it holds only text, its `<br>`s read as newlines; null when it holds anything else. */
function codeOf(block: DisplayElement): string | null {
  let code = "";
  for (const child of block.children) {
    if (child.kind === "text") code += child.value;
    else if (child.kind === "element" && child.name === "br") code += "\n";
    else return null;
  }
  return code;
}

/** `node`'s text as it reads, its `<br>`s as newlines, which `textContent` would drop. */
function textOf(node: Node): string {
  if (node.nodeName === "BR") return "\n";
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  return Array.from(node.childNodes, textOf).join("");
}

/** `token` as React draws it, with what `marks` matches in its text marked. */
const tokenNode = (token: Token, marks: RegExp | null): ReactNode =>
  typeof token === "string"
    ? marked(token, marks)
    : createElement("span", { className: token.className }, ...token.children.map((child) => tokenNode(child, marks)));

/**
 * A message's code block, highlighted once highlight.js has loaded, as Campfire's `MessageFormatter`
 * highlights one (app/javascript/models/message_formatter.js): only when it holds nothing but text, so
 * not when an address in it is linked. What a search's results mark in it stays marked.
 */
export function CodeBlock({ block, children, ...props }: ComponentProps<"pre"> & { block: DisplayElement }) {
  const pre = useRef<HTMLPreElement>(null);
  const code = codeOf(block);
  const language = block.attrs["data-language"];
  const highlighter = useHighlighter(code !== null);
  const marks = useContext(SearchMarks);
  const tokens = useMemo(() => (highlighter && code !== null ? highlighter.highlight(code, language) : null), [highlighter, code, language]);
  return createElement(
    "div",
    { className: "code-block group/code relative" },
    createElement("pre", { ...props, ref: pre }, ...(tokens ? tokens.map((token) => tokenNode(token, marks)) : [children])),
    <button
      type="button"
      aria-label="Copy code"
      className="absolute top-1.5 right-1.5 flex size-8 cursor-pointer items-center justify-center rounded-[6px] bg-background text-muted-foreground opacity-0 hover:bg-hover group-hover/code:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground touch:size-11 touch:opacity-100 [&_svg]:size-4"
      onClick={(event) => void copyWithSuccess(event.currentTarget, code ?? (pre.current ? textOf(pre.current) : ""))}
    >
      <Copy />
    </button>,
  );
}
