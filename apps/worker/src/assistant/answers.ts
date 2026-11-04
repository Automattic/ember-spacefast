import { ASSISTANT_ID, ASSISTANT_NAME, isMessageTooLong, MAX_MESSAGE_HTML_LENGTH, type Card, type CardImage, type LinkPreview, type Message, type User } from "@ember/protocol";
import { ANSWER_WORDS, THINKING_TOKENS, type AnswerLength, type AnswerLevels } from "@ember/protocol/assistant";
import { OPENGRAPH_EMBED_CONTENT_TYPE, prepareBody, previewContent } from "@ember/richtext";
import { decodeHTMLStrict } from "entities/decode";
import { Marked } from "marked";
import { markdownHtml } from "../bots/markdown";
import { escapeText, linkHref } from "../bots/mrkdwn";
import type { Question, RefusalReason, Turn } from "./gateway";

// What @ember asks its model when someone asks it something, and what it answers with. It reads the
// conversation it's asked in, each message after its writer's name, and answers in Markdown, thinking
// and writing as much as the asker's levels allow, which it posts as the rich text people write
// (`markdownHtml`), the pictures it shows in a card under it, as bots' image cards are, and a preview of
// its first link, as the composer adds one below a link. When it can't answer, it says why, in words
// that say who can do something about it.

/** How many of the room's latest messages @ember reads when it's asked in the room, the question among them. */
export const ROOM_MESSAGES_READ = 20;

/** How many of a thread's latest replies it reads when it's asked in one, the question among them, after the thread's first message. */
export const THREAD_REPLIES_READ = 50;

/**
 * The most characters of a conversation @ember reads: the newest messages that fit, so that one long
 * conversation costs no more than about 10,000 tokens.
 */
export const MAX_CONVERSATION_LENGTH = 40_000;

/**
 * The most tokens each length's answer may take once its model has thought: several times its words, at
 * about 1.3 tokens each, as Markdown, code and tables take more, and a model writes past what it's asked.
 */
export const ANSWER_TOKENS: Record<AnswerLength, number> = { short: 1_000, medium: 2_000, long: 6_000 };

/** The tokens of thinking an answer may take when it's asked for none, as some models think a little all the same. */
export const UNTHINKING_TOKENS = 2_000;

/** The most tokens an answer at `levels` may take: its thinking's, which counts toward them, and then its words'. */
export const maxTokensAt = ({ thinking, length }: AnswerLevels) => (thinking === "off" ? UNTHINKING_TOKENS : THINKING_TOKENS[thinking]) + ANSWER_TOKENS[length];

/** How long @ember waits for its model at the least, which most answers take a fraction of. */
const LEAST_WAIT_MS = 120_000;

/** How long it waits for each token an answer may take, as long as a slow model takes to write one. */
const WAIT_PER_TOKEN_MS = 20;

/**
 * How long @ember waits for its model to answer `question`: the longer, the more it may think and write.
 * The most, High thinking and a Long answer, is under 13 minutes, within the 15 a request on its way
 * keeps a room in memory.
 */
export const waitFor = ({ maxTokens }: Question) => Math.max(LEAST_WAIT_MS, maxTokens * WAIT_PER_TOKEN_MS);

/** Where @ember is asked something: the community's name, the room's, or null for a DM, and whether it's in a thread. */
export interface AskedIn {
  community: string;
  roomName: string | null;
  inThread: boolean;
}

/** Why a question for @ember gets no answer, which the room logs. */
export class AnswerError extends Error {}

/**
 * What @ember asks its model about the question `conversation` ends with, which `asker` asked `where`,
 * at `now`: the conversation it can read, its writers named, how to answer, and how much to think and
 * write, at the asker's `levels`, labeled with who asked.
 */
export function questionFor(conversation: Message[], asker: User, where: AskedIn, levels: AnswerLevels, now: Date): Question {
  const instructions = instructionsFor(asker, where, ANSWER_WORDS[levels.length], now);
  return { instructions, turns: turnsOf(readable(conversation, where.inThread)), maxTokens: maxTokensAt(levels), thinking: levels.thinking, askerId: asker.id };
}

/** What @ember is told before the conversation, asked to answer in about `words` words at most. */
function instructionsFor(asker: User, { community, roomName, inThread }: AskedIn, words: number, now: Date): string {
  const room = roomName === null ? "a direct message" : `the room "${roomName}"`;
  const today = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" }).format(now);
  return [
    `You are ${ASSISTANT_NAME}, the AI assistant in the team chat "${community}". People ask you things by mentioning @ember in a room or a thread, or by writing to you directly.`,
    `You're asked in ${inThread ? `a thread in ${room}` : room}. Its messages follow, oldest first, each after its writer's name. Answer the last one, which ${asker.name} wrote, as a helpful teammate would: plainly, and in at most about ${words.toLocaleString("en-US")} words.`,
    "Write in Markdown. Links, bold, italics, lists, quotes, code blocks and tables show as they do in the chat, and a picture you show with ![what it shows](its address) appears under your answer. Don't begin with your name.",
    `Today is ${today}, in UTC.`,
  ].join("\n\n");
}

/**
 * The messages of `conversation` @ember reads: the question it ends with, and as many of those before it
 * as fit in `MAX_CONVERSATION_LENGTH` characters, the newest first, but for a thread's first message, which
 * comes before them all.
 */
function readable(conversation: Message[], inThread: boolean): Message[] {
  const question = conversation.at(-1)!;
  const before = conversation.slice(0, -1);
  const [first, ...replies] = before;
  const candidates = inThread && first ? [first, ...replies.reverse()] : before.reverse();
  const kept = new Set<Message>([question]);
  let length = question.plainText.length;
  for (const message of candidates) {
    length += message.plainText.length;
    if (length > MAX_CONVERSATION_LENGTH) break;
    kept.add(message);
  }
  return conversation.filter((message) => kept.has(message));
}

/**
 * The conversation as the model reads it: each message after its writer's name, a file as its name, and
 * @ember's own answers as the model's turns, leaving out what was deleted and what has nothing to read.
 */
function turnsOf(messages: Message[]): Turn[] {
  return messages.flatMap((message): Turn[] => {
    const text = message.attachment ? `(shares a file, ${message.plainText})` : message.plainText.trim();
    if (message.deleted || text === "") return [];
    return [message.creator.id === ASSISTANT_ID ? { role: "assistant", text } : { role: "user", text: `${message.creator.name}: ${text}` }];
  });
}

/** @ember's answer as the room posts it: its Markdown as markup, a card of the pictures it shows, and its first web link, for a preview. */
export interface Answer {
  markup: string;
  cards: Card[];
  firstLink: string | null;
}

const markdown = new Marked({ gfm: true });

/**
 * `text`, the model's answer in Markdown, as @ember posts it, without its name in front, where the
 * conversation's form leads some models to write it, and cut to what one message holds.
 */
export function answerOf(text: string): Answer {
  const answer = text.replace(/^\s*(?:ember:|\*\*ember:\*\*|\*\*ember\*\*:)\s*(?=\S)/i, "");
  const whole = answerIn(answer);
  return fits(whole) ? whole : cutToFit(answer);
}

/** The answer `text`, in Markdown, makes: its rich text, a card of the web pictures it shows, and its first web link. */
function answerIn(text: string): Answer {
  const images: CardImage[] = [];
  let firstLink: string | null = null;
  markdown.walkTokens(markdown.lexer(text), (token) => {
    if (token.type === "image") {
      const url = webAddress(decodeHTMLStrict(token.href));
      if (url) images.push({ url, alt: decodeHTMLStrict(token.text) });
    } else if (token.type === "link") {
      // As `markdownHtml` reads them: an autolink's address is its text, with no character references.
      firstLink ??= webAddress(token.autolink ? token.href : decodeHTMLStrict(token.href));
    }
  });
  const cards: Card[] = images.length === 0 ? [] : [{ source: "blocks", parts: images.map((image) => ({ kind: "image", image })) }];
  return { markup: markdownHtml(text), cards, firstLink };
}

/** `address` as a web address, as a link to it goes, or null when it isn't one. */
function webAddress(address: string): string | null {
  const url = linkHref(address);
  return url && /^https?:/i.test(url) ? url : null;
}

/**
 * Whether `answer` fits in a message, as the room measures one (`prepareWithCards`), its markup and its
 * card no longer than a message's markup may be. The card adds no plain text, as its pictures have no titles.
 */
function fits({ markup, cards }: Answer): boolean {
  if (markup.length > MAX_MESSAGE_HTML_LENGTH || JSON.stringify(cards).length > MAX_MESSAGE_HTML_LENGTH) return false;
  const body = prepareBody(markup, () => undefined);
  return body !== null && !isMessageTooLong(body.plainText);
}

/**
 * The answer as much of `text` makes as fits in a message: its first lines, or the start of its first
 * line when even that doesn't fit, ending with an ellipsis where it's cut. Its Markdown can show more
 * than it's written in, as a numbered list counts up, or a picture's address shows for each reference to
 * it, so each cut is measured as it shows.
 */
function cutToFit(text: string): Answer {
  const cutFits = (length: number) => fits(cutAt(text, length));
  const lineEnds = Array.from(text.matchAll(/\n/g), ({ index }) => index);
  const lines = largest(lineEnds.length, (count) => cutFits(lineEnds[count - 1]!));
  return cutAt(text, lines > 0 ? lineEnds[lines - 1]! : largest(lineEnds[0] ?? text.length, cutFits));
}

/** The answer `text`'s first `length` characters make, ending with an ellipsis to say it's cut. */
const cutAt = (text: string, length: number) => answerIn(`${text.slice(0, length).trimEnd()}\n\n…`);

/** The largest count from 0 to `most` that `holds` is true of, as it is of every count below one it's true of. */
function largest(most: number, holds: (count: number) => boolean): number {
  let [low, high] = [0, most + 1];
  while (high - low > 1) {
    const count = Math.floor((low + high) / 2);
    if (holds(count)) low = count;
    else high = count;
  }
  return low;
}

/** `preview` as the attachment the composer adds below a link it has a preview of, as Lexxy writes one. */
export function previewAttachment({ url, image, title, description }: LinkPreview): string {
  const content = previewContent({ href: url, url: image ?? undefined, filename: title, description });
  return `<action-text-attachment content-type="${OPENGRAPH_EMBED_CONTENT_TYPE}" content="${escapeText(content).replace(/"/g, "&quot;")}"></action-text-attachment>`;
}

/** Where administrators set Ember AI up, as @ember's notes name it. */
const SETTINGS = "AI assistant in community settings";

/** Where each person picks how much @ember thinks and writes for them, and the model it answers them with, as its notes name it. */
const YOUR_LEVELS = "Ember AI on your profile";

/** What @ember says when it can't answer, for each reason it can't, and while its API token doesn't open. */
export const NOTES: Record<RefusalReason | "unopened token", string> = {
  token: `I can't answer right now: Cloudflare didn't take Ember AI's API token. An administrator can give it another under ${SETTINGS}.`,
  account: `I can't answer right now: Cloudflare can't find Ember AI's account. An administrator can set it up again under ${SETTINGS}.`,
  credits: "I can't answer right now: the AI Gateway credits that pay for my model have run out. An administrator can top them up in AI Gateway, or choose a Workers AI model.",
  model: `I can't answer right now: AI Gateway didn't take my question for its model. An administrator can choose another model under ${SETTINGS}.`,
  busy: "I can't answer right now: AI Gateway is turning requests away, or a spend limit was reached. Try again later.",
  "too long": "I can't answer that here: the conversation is longer than my model reads at once. Try asking in a new thread.",
  unanswered: "I couldn't answer: AI Gateway didn't answer in time. Try again in a moment.",
  nothing: "I couldn't answer: my model answered with nothing. Try asking again.",
  "out of room": `I couldn't answer: my model thought for as long as it may before it wrote anything. Try asking again, or choose less Thinking under ${YOUR_LEVELS}.`,
  "unopened token": `I can't answer right now: Ember AI's API token no longer opens here. An administrator can set it up again under ${SETTINGS}.`,
};

/** What @ember says instead, when it can't answer with the model whoever asked picked, for the reasons they can do something about. */
export const PICKED_MODEL_NOTES: Partial<Record<RefusalReason, string>> = {
  credits: `I can't answer right now: the AI Gateway credits that pay for the model you picked have run out. An administrator can top them up in AI Gateway, or you can pick another model under ${YOUR_LEVELS}.`,
  model: `I can't answer right now: AI Gateway didn't take my question for the model you picked. Pick another model under ${YOUR_LEVELS}.`,
};
