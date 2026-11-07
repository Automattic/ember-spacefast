import { createContext, createElement, Fragment, useContext, type ReactNode } from "react";

/**
 * What to mark in the messages inside it, as a search's results mark the words it matched (`marksFor`),
 * or null for nothing: in their text, their code and their bots' cards, as all of it was searched.
 */
export const SearchMarks = createContext<RegExp | null>(null);

/** `text` with each match of `marks` in a `<mark>`. */
export function marked(text: string, marks: RegExp | null): ReactNode {
  if (!marks) return text;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const match of text.matchAll(marks)) {
    parts.push(text.slice(from, match.index), createElement("mark", { key: match.index, "data-search-match": "" }, match[0]));
    from = match.index + match[0].length;
  }
  if (parts.length === 0) return text;
  return createElement(Fragment, null, ...parts, text.slice(from));
}

/** Text that isn't rich text, as a card's title is, with what the search matched marked. */
export function Marked({ children }: { children: string }) {
  return marked(children, useContext(SearchMarks));
}
