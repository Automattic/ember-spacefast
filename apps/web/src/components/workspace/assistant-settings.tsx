import { useState } from "react";
import type { WorkspaceSettings } from "@ember/protocol";
import { MAX_ASSISTANT_MODELS, MODELS_FULL, modelName, type AssistantChanges, type AssistantSettings as Assistant } from "@ember/protocol/assistant";
import { Switch } from "@/components/ui/switch";
import { useMounted } from "@/hooks/use-mounted";
import { changeAssistantSettings, forgetAssistant, isSignedOut, removeAssistantModel } from "@/lib/api";
import { AddAssistantModel } from "./add-assistant-model";
import { BUTTON } from "./email-settings";
import { LevelDials } from "./level-dials";

// The Ember AI card on the AI assistant tab, for administrators: whether @ember, an AI assistant in every
// room open to everyone, runs on a model through Cloudflare AI Gateway, and which. Its switch says
// whether it does, as Turnstile's does. Turning it on opens Set up Ember AI (`AssistantSetup`), as
// switches open setup that's missing, as the project's owner asked (2026-10-26), and turning it off takes
// @ember out of every room and forgets the API token and the models people could pick. Change opens the
// setup with the account and model as they are. While it's on, the card says what @ember sends the model,
// which its provider reads, lists the models people can pick on their profile, the one that answers
// everyone else chosen, with Add a model and each other's Remove, and has the dials of the most @ember may
// think and write for anyone's question. Each change saves at once. While one saves, Ember AI can't be
// turned off or changed, so that the save's answer can't show it as it was.

/** What @ember sends the model as it answers, which the card says while Ember AI is on. */
export const WHAT_EMBER_SENDS = "Mention @ember, or write to it directly, and it answers, sending the thread, or the room's latest messages, through Cloudflare to the model.";

/** What the card says of its models. */
export const MODELS_EXPLAINED = "People can pick any of these on their profile for @ember to answer them with. The one chosen here answers everyone else.";

/** What the card says of its dials. */
export const LIMITS_EXPLAINED =
  "The most @ember may think and write for anyone's question. Each person picks their own levels on their profile, up to these. AI Gateway's spend limits can cap what each person's questions cost, as every request says who asked.";

/** What turning Ember AI off asks first. */
export const CONFIRM_STOP_ASSISTANT =
  "Are you sure you want to turn off Ember AI? @ember will leave every room, and Ember will forget the API token and the models people can pick.";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

interface Props {
  assistant: WorkspaceSettings["assistant"];
  /** Opens Set up Ember AI. */
  onSetUp: () => void;
  /** Shows that Ember AI is off, once turning it off has. */
  onStopped: () => void;
  /** Shows Ember AI as a change to its models or dials leaves it, or as it was again when the change fails. */
  onChanged: (assistant: Assistant) => void;
  /** Says why turning it off failed, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Whether @ember runs on a model, for administrators, and which, or else what Ember AI would add. */
export function AssistantSettings({ assistant, onSetUp, onStopped, onChanged, onFailed }: Props) {
  const [stopping, setStopping] = useState(false);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const mounted = useMounted();

  /** Shows Ember AI as `changed` at once, and saves it with `save`, showing it as it was, `shown`, again if it isn't saved. */
  const saveShown = (shown: Assistant, changed: Assistant, save: () => Promise<Assistant>) => {
    setSaving(true);
    onChanged(changed);
    save().then(
      (saved) => {
        onChanged(saved);
        if (mounted.current) setSaving(false);
      },
      (error: unknown) => {
        onChanged(shown);
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        onFailed(error);
      },
    );
  };

  /** Changes the model that answers everyone, or the most of the dials, by `changes`. */
  const change = (shown: Assistant, { model, ...levels }: AssistantChanges) =>
    saveShown(shown, { ...shown, model: model ?? shown.model, most: { ...shown.most, ...levels } }, () => changeAssistantSettings({ ...levels, ...(model && { model }) }));

  /** Takes `model` out of the models people can pick. */
  const remove = (shown: Assistant, model: string) =>
    saveShown(shown, { ...shown, models: shown.models.filter(({ id }) => id !== model) }, () => removeAssistantModel(model));

  const stop = () => {
    if (!confirm(CONFIRM_STOP_ASSISTANT)) return;
    setStopping(true);
    forgetAssistant().then(
      () => {
        onStopped();
        if (mounted.current) setStopping(false);
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setStopping(false);
        onFailed(error);
      },
    );
  };

  return (
    <section aria-labelledby="assistant-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div className="flex items-center gap-x-[1ch] gap-y-4">
        <div className="min-w-0 flex-1">
          <h2 id="assistant-heading" className="text-base font-semibold">
            Ember AI
          </h2>
          <p id="assistant-description" className={NOTE}>
            {assistant === null ? (
              "Ember AI adds @ember, an AI assistant, to every room open to everyone, running on a model you choose through Cloudflare AI Gateway."
            ) : (
              <>
                @ember runs on <strong className="font-semibold wrap-anywhere">{modelName(assistant.model, assistant.models)}</strong> through Cloudflare AI
                Gateway{assistant.models.length > 1 && ", or on the model each person picks"}.
              </>
            )}
          </p>
        </div>
        <Switch
          checked={assistant !== null && !stopping}
          onCheckedChange={(on) => (on ? onSetUp() : stop())}
          disabled={stopping || saving}
          aria-labelledby="assistant-heading"
          aria-describedby="assistant-description"
        />
      </div>
      {assistant !== null && (
        <>
          <p className={NOTE}>{WHAT_EMBER_SENDS}</p>
          <div>
            <button type="button" onClick={onSetUp} disabled={stopping || saving} className={BUTTON}>
              Change
            </button>
          </div>
          <Models
            assistant={assistant}
            disabled={stopping || saving}
            onChoose={(model) => change(assistant, { model })}
            onRemove={(model) => remove(assistant, model)}
            onAdd={() => setAdding(true)}
          />
          <div className="flex flex-col gap-3 border-t pt-4">
            <div>
              <h3 className="text-sm font-semibold">Limits</h3>
              <p className={NOTE}>{LIMITS_EXPLAINED}</p>
            </div>
            <LevelDials name="assistant-most" levels={assistant.most} disabled={stopping || saving} onChange={(changes) => change(assistant, changes)} />
          </div>
          {adding && <AddAssistantModel assistant={assistant} onAdded={onChanged} onClose={() => setAdding(false)} onFailed={onFailed} />}
        </>
      )}
    </section>
  );
}

/**
 * The models people can pick, in the order they were added, each a radio button that chooses it to
 * answer everyone else, with a Remove for each but that one, and Add a model under them, until there are
 * as many as there can be.
 */
function Models({
  assistant,
  disabled,
  onChoose,
  onRemove,
  onAdd,
}: {
  assistant: Assistant;
  disabled: boolean;
  onChoose: (model: string) => void;
  onRemove: (model: string) => void;
  onAdd: () => void;
}) {
  const full = assistant.models.length >= MAX_ASSISTANT_MODELS;
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      <div>
        <h3 id="assistant-models-heading" className="text-sm font-semibold">
          Models
        </h3>
        <p id="assistant-models-description" className={NOTE}>
          {MODELS_EXPLAINED}
        </p>
      </div>
      <fieldset aria-labelledby="assistant-models-heading" aria-describedby="assistant-models-description" className="flex min-w-0 flex-col gap-1">
        {assistant.models.map(({ id, name }) => (
          <div key={id} className="flex items-center gap-[1ch]">
            <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 has-disabled:cursor-default">
              <input
                type="radio"
                name="assistant-model"
                value={id}
                checked={assistant.model === id}
                disabled={disabled}
                onChange={() => onChoose(id)}
                className="size-4 flex-none accent-foreground"
              />
              <span className="min-w-0 wrap-anywhere">{name}</span>
            </label>
            {assistant.model !== id && (
              <button type="button" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => onRemove(id)} className={BUTTON}>
                Remove
              </button>
            )}
          </div>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-x-[1ch] gap-y-2">
        <button type="button" disabled={disabled || full} onClick={onAdd} aria-describedby={full ? "assistant-models-full" : undefined} className={BUTTON}>
          Add a model
        </button>
        {full && (
          <p id="assistant-models-full" className={NOTE}>
            {MODELS_FULL}
          </p>
        )}
      </div>
    </div>
  );
}
