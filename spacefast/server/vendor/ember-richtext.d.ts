export type MentionUser = { id: string; name: string };
export type PreparedBody = { html: string; plainText: string; mentions: MentionUser[]; blank: boolean };
export declare function prepareBody(markup: string, resolve: (sgid: string) => MentionUser | undefined): PreparedBody | null;
export declare function userIdsIn(markup: string): string[];
export declare function userIdFromSgid(sgid: string): string | undefined;
export type HtmlNode = {
  kind: string;
  name?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  children?: HtmlNode[];
};
export declare function parseHtml(markup: string): HtmlNode;
