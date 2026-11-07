import { createContext, useContext, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { MAX_BOOST_LENGTH, REACTIONS, type Boost, type Me, type Message } from "@ember/protocol";
import { isAllEmoji } from "@ember/richtext/dom";
import { ArrowUp, Emoji, Minus, Xmark } from "@/components/icons/iconoir";
import { useNameOf } from "@/hooks/use-directory";
import { RefusedUnboosts, RoomConnection } from "@/hooks/use-room";
import { useScrollIntoView } from "@/hooks/use-scroll-into-view";
import { pressedAlone } from "@/lib/keyboard";
import { cn } from "@/lib/utils";
import type { MessageActions } from "./message-item";
import { AvatarLink, UserAvatar } from "./user-avatar";

/** MOCK: which redesign of the Custom reaction form shows, 0 being today's. */
export function mockVariant(): number {
  try {
    return Number(localStorage.getItem("ember-mock-boost-form") ?? 0);
  } catch {
    return 0;
  }
}

/** MOCK: the custom reactions used most recently in the room, newest first, which design 5 offers. */
export const RecentCustomReactions = createContext<string[]>([]);

/** MOCK: the room's custom reactions, newest first: any not among the bar's and the tray's, up to `count`. */
export function recentCustomReactions(messages: Message[], count = 4): string[] {
  const offered = new Set<string>(REACTIONS.map(([emoji]) => emoji));
  const boosts = messages.flatMap((message) => message.boosts).filter((boost) => !offered.has(boost.content));
  boosts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return [...new Set(boosts.map((boost) => boost.content))].slice(0, count);
}

/** A custom reaction starts with something other than a space. */
const CUSTOM_REACTION = String.raw`\S+.*`;

/** The Custom reaction form's buttons, 44px for fingers. */
const FORM_BUTTON =
  "inline-flex min-h-10 cursor-pointer items-center justify-center gap-[0.5em] rounded-[9px] border px-3 py-2 text-[13px] font-medium touch:min-h-11";

interface Props {
  message: Message;
  me: Me;
  threaded: boolean;
  /** What can be done to the message, or null where nothing can, as in a room that's gone. */
  actions: MessageActions | null;
  /** Whether the Custom reaction form shows, in place of Add a boost. */
  customizing: boolean;
  /** The Custom reaction form's field, while it shows. */
  customField?: Ref<HTMLInputElement>;
  /** Opens the message's bar with More reactions showing, from its Add a boost. */
  onAddBoost: (button: HTMLButtonElement) => void;
  /** Closes the Custom reaction form. */
  onCloseCustom: () => void;
  /** Hands focus to the message's Message options, as a reaction sent or deleted here does. */
  returnFocus: () => void;
}

/**
 * The reactions under a message (Campfire's boosts.css): a pill for each, oldest first, then Add a
 * boost, which opens the message's bar with More reactions showing, or the Custom reaction form that New
 * boost opens in its place. Add a boost shows once the message has a reaction, as messages.css shows it.
 */
export function MessageBoosts({ message, me, threaded, actions, customizing, customField, onAddBoost, onCloseCustom, returnFocus }: Props) {
  const hint = useId();
  const deletable = (boost: Boost) => actions !== null && boost.booster.id === me.id;

  // The form closes once its reaction is sent, and stays, keeping what's written, when it can't be.
  const add = (content: string) => {
    if (!actions?.boost(message.id, content)) return;
    onCloseCustom();
    returnFocus();
  };

  const cancel = () => {
    onCloseCustom();
    returnFocus();
  };

  // Focus would go with the reaction, so it goes to Message options, as it does once you react from the bar.
  const remove = (boost: Boost) => {
    const sent = actions!.unboost(boost.id);
    if (sent) returnFocus();
    return sent;
  };

  return (
    <div
      className={cn(
        // Under a grouped message's text and time, across both columns.
        "relative col-span-full flex w-full flex-wrap items-center gap-x-[0.4ch] text-message-ink",
        // Where Message options is 44px, the next message's rises 11px into this one, reaching 38px in from
        // its edge, so reactions stop short of it. A grouped message's body already keeps 32px of that clear.
        // The Custom reaction form's buttons sit higher than that, so it takes the row's whole width.
        (!customizing || mockVariant() === 1 || mockVariant() === 3) && (threaded ? "touch:pr-1.5" : "touch:pr-[38px]"),
      )}
    >
      <ul aria-label="Reactions" className="flex flex-wrap gap-x-[0.4ch] empty:hidden">
        {message.boosts.map((boost) => (
          <BoostPill key={boost.id} boost={boost} hint={hint} onDelete={deletable(boost) ? () => remove(boost) : null} />
        ))}
      </ul>
      {message.boosts.some(deletable) && (
        <span id={hint} hidden>
          Press enter to delete this boost
        </span>
      )}
      {customizing ? (
        <RedesignedReaction variant={mockVariant()} me={me} fieldRef={customField} onAdd={add} onCancel={cancel} />
      ) : (
        actions &&
        message.boosts.length > 0 && (
          <button
            type="button"
            className="mt-1 grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border bg-background text-[0.66em] text-foreground touch:size-11 hover:not-active:border-muted-foreground"
            onClick={(event) => onAddBoost(event.currentTarget)}
          >
            <Emoji className="h-5 w-[1.3em]" />
            <span className="sr-only">Add a boost</span>
          </button>
        )
      )}
    </div>
  );
}

/**
 * One reaction: its booster's avatar, named "<name> boosted <content>", then the content, larger when
 * it's all emoji. Clicking your own, or pressing Enter on it, reveals Delete this boost and focuses it,
 * as boost_delete_controller.js does, and Delete shrinks it away while it goes. Other people's do
 * nothing.
 */
function BoostPill({ boost, hint, onDelete }: { boost: Boost; hint: string; onDelete: (() => boolean) | null }) {
  const nameOf = useNameOf();
  const [expanded, setExpanded] = useState(false);
  // The connection the deletion went on, and the room's refusals to delete a reaction by then. The reaction
  // comes back if the page reconnects before it goes, since the deletion may have been lost with the
  // connection it went on, or if the room refuses to delete one, since it doesn't say which.
  const connection = useContext(RoomConnection);
  const refusals = useContext(RefusedUnboosts);
  const [deletedAt, setDeletedAt] = useState<{ connection: number; refusals: number } | null>(null);
  const deleting = deletedAt?.connection === connection && deletedAt.refusals === refusals;
  const remove = useRef<HTMLButtonElement>(null);
  const content = cn("min-w-0 leading-normal", isAllEmoji(boost.content) ? "text-base" : "text-[0.8rem]");

  useLayoutEffect(() => {
    if (expanded) remove.current?.focus();
  }, [expanded]);

  const reveal = onDelete && expanded;

  return (
    <li
      className={cn(
        "relative mt-1 flex max-w-full items-center gap-x-[0.4ch] rounded-[4rem] border bg-background pt-[0.1em] pb-[0.1em] pl-[0.1em] hover:not-active:border-muted-foreground",
        // The pill keeps the gap before its Delete button while that's hidden.
        reveal ? "pr-[0.2em]" : "pr-[calc(0.2em+0.4ch)]",
        deleting && "pointer-events-none animate-scale-fade-out motion-reduce:animate-none motion-reduce:opacity-0",
      )}
    >
      {/*
       * 2.2ch of the medium weight of the avatar button, over the button that takes the rest of the
       * pill's clicks. A pill has no room for two targets a fingertip can find, so on touch screens your own
       * is all that button.
       */}
      <AvatarLink
        user={boost.booster}
        reach="dense"
        label={`${nameOf(boost.booster)} boosted ${boost.content}`}
        className={cn("z-[1] size-[2.2ch] font-medium", onDelete && "touch:pointer-events-none")}
      />
      {onDelete ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-describedby={hint}
          // The whole pill takes the click, so a fingertip can find it.
          className={cn(content, "cursor-pointer after:absolute after:-inset-px after:rounded-[4rem]")}
          onClick={() => setExpanded((shown) => !shown)}
        >
          {boost.content}
        </button>
      ) : (
        <span className={content}>{boost.content}</span>
      )}
      {reveal && (
        <button
          ref={remove}
          type="button"
          className="relative ml-auto grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border border-transparent bg-negative-button text-[0.55rem] text-white touch:size-11 hover:not-active:brightness-70"
          onClick={() => {
            if (onDelete()) setDeletedAt({ connection, refusals });
          }}
        >
          <Minus className="h-5 w-[1.3em]" />
          <span className="sr-only">Delete this boost</span>
        </button>
      )}
    </li>
  );
}

/**
 * New boost's form: your avatar and "Custom reaction", a field for up to 16 characters that can't start
 * with a space, and Cancel and Add reaction. Escape cancels. It scrolls itself into view, as its
 * scroll-into-view controller does.
 */
function CustomReaction({ me, fieldRef, onAdd, onCancel }: { me: Me; fieldRef?: Ref<HTMLInputElement>; onAdd: (content: string) => void; onCancel: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const field = useId();
  const hint = useId();

  useScrollIntoView(form);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onAdd(new FormData(event.currentTarget).get("content") as string);
  };

  return (
    <div className="mt-2.5 mb-1.5 w-[340px] max-w-full min-w-0 rounded-[12px] border bg-surface p-3.5">
      <form
        ref={form}
        className="grid w-full min-w-0 gap-2.5"
        onSubmit={submit}
        onKeyDown={(event) => {
          if (!pressedAlone(event.nativeEvent, "Escape")) return;
          event.preventDefault();
          onCancel();
        }}
      >
        <div className="flex items-center gap-[9px]">
          <UserAvatar user={me} className="size-7" />
          <label htmlFor={field} className="text-[13px] font-semibold">
            Custom reaction
          </label>
        </div>
        <input
          ref={fieldRef}
          id={field}
          name="content"
          type="text"
          autoFocus
          autoComplete="off"
          autoCorrect="off"
          maxLength={MAX_BOOST_LENGTH}
          required
          pattern={CUSTOM_REACTION}
          placeholder="Emoji or a short message"
          aria-describedby={hint}
          className="block min-h-[42px] w-full min-w-0 rounded-[8px] border bg-background px-[11px] py-[9px] text-foreground placeholder:text-muted-foreground focus:border-muted-foreground focus:shadow-[0_0_0_1px_var(--muted-foreground)] focus-visible:outline-none touch:text-base"
        />
        <p id={hint} className="-mt-[3px] mb-0.5 text-[12px] text-muted-foreground">
          Up to 16 characters.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={cn(FORM_BUTTON, "bg-background text-foreground")} onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={cn(FORM_BUTTON, "border-transparent bg-foreground text-background hover:not-active:brightness-70")}>
            Add reaction
          </button>
        </div>
      </form>
    </div>
  );
}

interface FormProps {
  me: Me;
  fieldRef?: Ref<HTMLInputElement>;
  onAdd: (content: string) => void;
  onCancel: () => void;
}

/** MOCK: today's form, or one of the five redesigns. */
function RedesignedReaction({ variant, ...props }: FormProps & { variant: number }) {
  switch (variant) {
    case 1:
      return <PillReaction {...props} />;
    case 2:
      return <SlimReaction {...props} />;
    case 3:
      return <PopoverReaction {...props} />;
    case 5:
      return <SuggestedReaction {...props} />;
    default:
      return <CustomReaction {...props} />;
  }
}

/** MOCK: what each redesign's form does: Enter or its button adds, Escape cancels, and it scrolls itself into view. */
function useReactionForm({ onAdd, onCancel }: Pick<FormProps, "onAdd" | "onCancel">) {
  const form = useRef<HTMLFormElement>(null);
  const [value, setValue] = useState("");
  useScrollIntoView(form);
  return {
    form,
    value,
    setValue,
    onSubmit: (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onAdd(new FormData(event.currentTarget).get("content") as string);
    },
    onKeyDown: (event: KeyboardEvent<HTMLFormElement>) => {
      if (!pressedAlone(event.nativeEvent, "Escape")) return;
      event.preventDefault();
      onCancel();
    },
  };
}

/** How many characters are left, shown once five or fewer are. */
function Remaining({ value, className }: { value: string; className?: string }) {
  const left = MAX_BOOST_LENGTH - value.length;
  if (left > 5) return null;
  return <span className={cn("shrink-0 text-[11px] leading-none whitespace-nowrap text-muted-foreground tabular-nums", left === 0 && "text-negative", className)}>{left} left</span>;
}

/**
 * The field every redesign shares: up to 16 characters that can't start with a space, named Custom reaction,
 * or by the label for its `id` where it has one.
 */
function ReactionField({
  id,
  fieldRef,
  value,
  onValue,
  placeholder = "Emoji or a short message",
  className,
}: {
  id?: string;
  fieldRef?: Ref<HTMLInputElement>;
  value: string;
  onValue: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const hint = useId();
  return (
    <>
      <input
        ref={fieldRef}
        id={id}
        aria-label={id ? undefined : "Custom reaction"}
        name="content"
        type="text"
        autoFocus
        autoComplete="off"
        autoCorrect="off"
        enterKeyHint="send"
        maxLength={MAX_BOOST_LENGTH}
        required
        pattern={CUSTOM_REACTION}
        placeholder={placeholder}
        aria-describedby={hint}
        value={value}
        onChange={(event) => onValue(event.currentTarget.value)}
        className={cn("block min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground touch:text-base", className)}
      />
      <span id={hint} hidden>
        Up to 16 characters.
      </span>
    </>
  );
}

/** The X that closes a form: a 28px circle with a mouse, 44px for fingers, named Cancel. */
function CloseButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "grid size-7 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-foreground touch:size-11",
        className,
      )}
    >
      <Xmark className="size-4" />
      <span className="sr-only">Cancel</span>
    </button>
  );
}

/** Add reaction: the composer's Send, small, inside the field's right end; dim until there's something to add. */
function SendButton({ ready }: { ready: boolean }) {
  return (
    <button type="submit" className="group/send grid size-7 shrink-0 cursor-pointer place-items-center touch:size-11">
      <span
        className={cn(
          "grid size-7 place-items-center rounded-full bg-foreground text-background transition-opacity group-hover/send:brightness-70 touch:size-8",
          !ready && "opacity-25",
        )}
      >
        <ArrowUp className="size-4" />
      </span>
      <span className="sr-only">Add reaction</span>
    </button>
  );
}

/** Ember's ring round a field with a button in it, while it has focus. */
const FIELD_BOX =
  "flex min-w-0 items-center rounded-[9px] border bg-background transition-shadow duration-150 focus-within:ring-2 focus-within:ring-selected-dark";

/**
 * MOCK 1, Pill: the field is the reaction you're adding, a pill at the end of the row with your avatar,
 * as wide as what's written, and an X. Enter adds it, or Add reaction, which shows once something's written.
 */
function PillReaction({ me, fieldRef, onAdd, onCancel }: FormProps) {
  const { form, value, setValue, onSubmit, onKeyDown } = useReactionForm({ onAdd, onCancel });
  return (
    <form
      ref={form}
      data-mock-form
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      className={cn(FIELD_BOX, "mt-1 h-8 max-w-full gap-[0.4ch] rounded-[4rem] pr-0.5 pl-[0.2em] touch:h-11 touch:pl-1.5")}
    >
      <UserAvatar user={me} className="size-[22px] touch:size-7" />
      <ReactionField
        fieldRef={fieldRef}
        value={value}
        onValue={setValue}
        // Sized to what's written, which the placeholder would hold wider.
        placeholder={value === "" ? "Emoji or a word" : ""}
        className="min-w-[5ch] text-[0.8rem] [field-sizing:content]"
      />
      <Remaining value={value} />
      {/* Add reaction shows once there's something to add. */}
      {value.trim() !== "" && (
        <button type="submit" className="group/send grid size-6 shrink-0 cursor-pointer place-items-center touch:size-10">
          <span className="grid size-6 place-items-center rounded-full bg-foreground text-background group-hover/send:brightness-70 touch:size-7">
            <ArrowUp className="size-3.5" />
          </span>
          <span className="sr-only">Add reaction</span>
        </button>
      )}
      <CloseButton onClick={onCancel} className="size-6 touch:-my-px touch:size-10" />
    </form>
  );
}

/**
 * MOCK 2, Slim field: one line, as the composer is, with its Send in the field and an X beside it.
 */
function SlimReaction({ fieldRef, onAdd, onCancel }: FormProps) {
  const { form, value, setValue, onSubmit, onKeyDown } = useReactionForm({ onAdd, onCancel });
  return (
    <form ref={form} data-mock-form onSubmit={onSubmit} onKeyDown={onKeyDown} className="mt-1.5 flex w-[19rem] max-w-full items-center gap-1 touch:w-full">
      <div className={cn(FIELD_BOX, "h-9 flex-1 gap-1.5 pr-1 pl-3 touch:h-11 touch:pr-0")}>
        <ReactionField fieldRef={fieldRef} value={value} onValue={setValue} className="flex-1 text-sm" />
        <Remaining value={value} />
        <SendButton ready={value.trim() !== ""} />
      </div>
      <CloseButton onClick={onCancel} />
    </form>
  );
}

/**
 * MOCK 3, Mini popover: a small card that floats under the reactions, over what follows, so nothing moves,
 * titled Custom reaction with its X at the top right. Enter adds.
 */
function PopoverReaction({ fieldRef, onAdd, onCancel }: FormProps) {
  const { form, value, setValue, onSubmit, onKeyDown } = useReactionForm({ onAdd, onCancel });
  const field = useId();
  return (
    <div
      data-mock-form
      className="absolute top-full left-0 z-20 mt-1.5 w-[15.5rem] max-w-full rounded-[11px] border border-message-border bg-background p-1.5 pb-2 shadow-[0_6px_20px_var(--dialog-shadow-faint),0_1px_3px_#0000001a] touch:w-[17rem]"
    >
      <form ref={form} onSubmit={onSubmit} onKeyDown={onKeyDown} className="grid gap-1">
        <div className="flex items-center gap-2 pl-1.5">
          <label htmlFor={field} className="text-[11px] leading-normal font-medium text-muted-foreground">
            Custom reaction
          </label>
          <Remaining value={value} className="ml-auto" />
          <CloseButton onClick={onCancel} className={cn("size-6 touch:size-11", value.length < MAX_BOOST_LENGTH - 5 && "ml-auto")} />
        </div>
        <div className={cn(FIELD_BOX, "mx-0.5 h-9 px-2.5 touch:h-11")}>
          <ReactionField id={field} fieldRef={fieldRef} value={value} onValue={setValue} className="flex-1 text-sm" />
        </div>
      </form>
    </div>
  );
}

/**
 * MOCK 5, Suggestions: the slim field, then the custom reactions used here lately, one tap each, narrowed to
 * those that start with what's written.
 */
function SuggestedReaction({ fieldRef, onAdd, onCancel }: FormProps) {
  const { form, value, setValue, onSubmit, onKeyDown } = useReactionForm({ onAdd, onCancel });
  const recent = useContext(RecentCustomReactions);
  const typed = value.trim().toLowerCase();
  const offered = recent.filter((content) => content.toLowerCase().startsWith(typed) && content.toLowerCase() !== typed);
  return (
    <form ref={form} data-mock-form onSubmit={onSubmit} onKeyDown={onKeyDown} className="mt-1.5 grid w-[19rem] max-w-full grid-cols-[minmax(0,1fr)] gap-1.5 touch:w-full">
      <div className="flex items-center gap-1">
        <div className={cn(FIELD_BOX, "h-9 flex-1 gap-1.5 pr-1 pl-3 touch:h-11 touch:pr-0")}>
          <ReactionField fieldRef={fieldRef} value={value} onValue={setValue} className="flex-1 text-sm" />
          <Remaining value={value} />
          <SendButton ready={value.trim() !== ""} />
        </div>
        <CloseButton onClick={onCancel} />
      </div>
      {offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 pl-0.5">
          <span className="mr-0.5 text-[11px] font-medium text-muted-foreground">Recent</span>
          <Suggestions contents={offered} onPick={onAdd} />
        </div>
      )}
    </form>
  );
}

function Suggestions({ contents, onPick }: { contents: string[]; onPick: (content: string) => void }): ReactNode {
  return contents.map((content) => (
    <button
      key={content}
      type="button"
      onClick={() => onPick(content)}
      className={cn(
        "h-7 cursor-pointer rounded-[4rem] border bg-background px-2.5 leading-none text-message-ink hover:not-active:border-muted-foreground touch:h-9",
        isAllEmoji(content) ? "text-base" : "text-[0.8rem]",
      )}
    >
      {content}
    </button>
  ));
}
