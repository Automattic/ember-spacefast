import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  ACCOUNT_ID_REFUSED,
  API_TOKEN_REFUSED,
  ASSISTANT_MODELS,
  MAX_MODEL_LENGTH,
  MODEL_REFUSED,
  accountIdOf,
  apiTokenOf,
  isWorkersAiModel,
  modelName,
  modelOf,
  type AssistantField,
  type AssistantSettings,
  type WebTool,
} from "@ember/protocol/assistant";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, isSignedOut, saveAssistant } from "@/lib/api";
import { cn } from "@/lib/utils";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE, MAIN_ACTION, OTHER_ACTION } from "./unsaved-changes";

// Set up Ember AI, for administrators: the steps to give @ember a model through Cloudflare AI Gateway, in
// a dialog that the AI assistant tab's Ember AI card opens. First the Cloudflare account's ID, filled in
// with the account Ember is deployed to when the deploy gave it, and an API token of its, which Workers
// AI's Use REST API makes, then the model, which the Worker asks a test question through AI Gateway
// before keeping all three, saying on the field it's about why it didn't answer, if it didn't. Then what
// the model said, and that Search the web is off, when a change of model turned it off. Styled as Set up
// Turnstile is.

/**
 * The page at `path` in the Cloudflare dashboard, in the account `accountId` names, or else in the one
 * the dashboard picks, asking someone with several accounts which.
 */
const dashboard = (accountId: string | null, path: string) =>
  accountId === null ? `https://dash.cloudflare.com/?to=/:account/${path}` : `https://dash.cloudflare.com/${accountId}/${path}`;

/** Where Workers AI's Use REST API makes an API token and shows the account's ID, in the Cloudflare dashboard. */
const workersAiDashboard = (accountId: string | null) => dashboard(accountId, "ai/workers-ai");
/** Where AI Gateway's credits are topped up, under Credits Available, in the Cloudflare dashboard. */
const aiGatewayDashboard = (accountId: string | null) => dashboard(accountId, "ai/ai-gateway");
/** Cloudflare's catalog of the models AI Gateway takes. */
export const MODEL_CATALOG = "https://developers.cloudflare.com/ai/models/";

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";
const SELECT = cn("w-full min-w-0 border outline-none dark:bg-input/30", FIELD_INPUT);

/**
 * What the last step says once a change of model has turned Search the web off, leaving @ember doing
 * `webTools` on the web: that the new model can try it, or that it can't search.
 */
export const searchTurnedOff = (webTools: WebTool[] | null) =>
  webTools === null ? "Search the web is off, as this model can't search the web through AI Gateway." : "Search the web is off for the new model. Turn it on again to try it.";

/** Where it's at: the account and its API token, the model, or done. */
type Step = "keys" | "model" | "done";

const TITLES: Record<Step, string> = { keys: "Set up Ember AI", model: "Choose a model", done: "Ember AI is set up" };

/** The model menu's choice for a model it doesn't list, whose ID is typed. */
const ANOTHER_MODEL = "";

/** The model menu as it's set: a listed model's ID, or `ANOTHER_MODEL`, with the ID typed for that. */
interface ModelChoice {
  chosen: string;
  typed: string;
}

/** Why a field is refused, said on it, or else, with no field, under the model step's. */
interface Refusal {
  field: AssistantField | null;
  error: string;
}

/** The fields of the first step. */
type KeyField = Exclude<AssistantField, "model">;

interface Props {
  assistant: AssistantSettings | null;
  /** The Cloudflare account Ember is deployed to, which the account's ID starts as while Ember AI is off, if the deploy gave it. */
  deployedAccountId: string | null;
  /** Shows Ember AI as it's saved. */
  onSaved: (assistant: AssistantSettings) => void;
  onClose: () => void;
  /** Says why saving failed, when it isn't the setup's or AI Gateway's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Set up Ember AI: the account and its API token, then the model, which saves them once it answers a test question. */
export function AssistantSetup({ assistant, deployedAccountId, onSaved, onClose, onFailed }: Props) {
  const [step, setStep] = useState<Step>("keys");
  // The account's ID as Ember AI has it, or else as the deploy gave it, which the steps then needn't say where to copy from.
  const [filledIn] = useState(() => assistant?.accountId ?? deployedAccountId);
  const [typed, setTyped] = useState<Record<KeyField, string>>({ accountId: filledIn ?? "", apiToken: "" });
  const [model, setModel] = useState(() => modelChoiceOf(assistant));
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Asking the model a test question holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ assistant: AssistantSettings; greeting: string } | null>(null);
  // Whether @ember searched the web before, which another model may not do with the same tools, and so doesn't until it's tried.
  const [searched] = useState(() => assistant?.webTools?.includes("search") ?? false);
  const title = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  const mounted = useMounted();

  // Each step starts at its title, so that it's read first.
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    title.current?.focus();
  }, [step]);

  const refuse = (field: AssistantField | null, error: string) => {
    setRefusal({ field, error });
    if (field === "accountId" || field === "apiToken") setStep("keys");
  };

  const save = (chosen: string) => {
    setRefusal(null);
    setSaving(true);
    const apiToken = apiTokenOf(typed.apiToken);
    saveAssistant({ accountId: accountIdOf(typed.accountId) ?? "", ...(apiToken && { apiToken }), model: chosen }).then(
      (answer) => {
        onSaved(answer.assistant);
        if (!mounted.current) return;
        setSaving(false);
        setSaved(answer);
        setStep("done");
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What AI Gateway or the Worker said of the setup, or that AI Gateway didn't answer, which the step says itself.
        if (error instanceof ApiError && [422, 429, 502].includes(error.status)) return refuse(fieldOf(error.field), error.message);
        onFailed(error);
      },
    );
  };

  const steps: Record<Step, ReactNode> = {
    keys: (
      <KeysStep
        hasToken={assistant !== null}
        filledIn={filledIn !== null}
        deployedAccountId={deployedAccountId}
        typed={typed}
        onType={(field, text) => {
          setTyped((typed) => ({ ...typed, [field]: text }));
          if (refusal?.field === field) setRefusal(null);
        }}
        refusal={refusal}
        onRefuse={refuse}
        onContinue={() => setStep("model")}
        onCancel={onClose}
      />
    ),
    model: (
      <ModelStep
        accountId={accountIdOf(typed.accountId)}
        model={model}
        onChoose={(model) => {
          setModel(model);
          if (refusal?.field === "model" || refusal?.field === null) setRefusal(null);
        }}
        refusal={refusal}
        onRefuse={refuse}
        saving={saving}
        onSave={save}
        onBack={() => setStep("keys")}
      />
    ),
    done: saved && (
      <>
        <DialogDescription className="mb-4 leading-[1.65]">
          @ember is in every room open to everyone, running on <span className="wrap-anywhere">{modelName(saved.assistant.model)}</span>. Asked to say hello, it
          said:
        </DialogDescription>
        <blockquote className="border-s-2 ps-3 whitespace-pre-wrap wrap-anywhere">{saved.greeting}</blockquote>
        {searched && !saved.assistant.webTools?.includes("search") && <p className={cn(NOTE, "mt-4")}>{searchTurnedOff(saved.assistant.webTools)}</p>}
        <Actions back={null} next={onClose} nextLabel="Done" />
      </>
    ),
  };

  return (
    <Dialog open onOpenChange={(open) => open || saving || onClose()}>
      <DialogContent
        showCloseButton={false}
        aria-busy={saving || undefined}
        overlayClassName={DIALOG_BACKDROP}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          title.current?.focus();
        }}
        // What's typed isn't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(DIALOG, "w-[480px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          {TITLES[step]}
        </DialogTitle>
        {steps[step]}
      </DialogContent>
    </Dialog>
  );
}

/** The model menu as Ember AI has it: its model, under Another model if it isn't listed, or the first listed while it's off. */
function modelChoiceOf(assistant: AssistantSettings | null): ModelChoice {
  if (assistant === null) return { chosen: ASSISTANT_MODELS[0]!.id, typed: "" };
  return ASSISTANT_MODELS.some(({ id }) => id === assistant.model) ? { chosen: assistant.model, typed: "" } : { chosen: ANOTHER_MODEL, typed: assistant.model };
}

/** The field of Set up Ember AI a refusal names, if it names one. */
function fieldOf(field: string | undefined): AssistantField | null {
  return field === "accountId" || field === "apiToken" || field === "model" ? field : null;
}

/** The buttons at a step's foot, as Set up Turnstile's are: going back, or else cancelling, and going on. */
function Actions({
  back,
  backLabel = "Back",
  next,
  nextLabel = "Continue",
  disabled = false,
  saving = false,
}: {
  back: (() => void) | null;
  backLabel?: string;
  /** Goes on, or null when the step's form does, as its submit button. */
  next: (() => void) | null;
  nextLabel?: string;
  disabled?: boolean;
  saving?: boolean;
}) {
  return (
    <div className="mt-[26px] flex justify-end gap-2.5">
      {back && (
        <button type="button" disabled={saving} onClick={back} className={OTHER_ACTION}>
          {backLabel}
        </button>
      )}
      <button type={next ? "button" : "submit"} disabled={disabled || saving} onClick={next ?? undefined} className={MAIN_ACTION}>
        {nextLabel}
      </button>
    </div>
  );
}

/** A link out, which opens in a new tab. */
function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener" className="underline">
      {children}
    </a>
  );
}

/** Why `field` is refused, under it, if it is. */
function FieldRefusal({ id, field, refusal }: { id: string; field: AssistantField; refusal: Refusal | null }) {
  if (refusal?.field !== field) return null;
  return (
    <p id={id} role="alert" className={cn(NOTE, "mt-2 wrap-anywhere text-negative")}>
      {refusal.error}
    </p>
  );
}

/**
 * The first step: the Cloudflare account's ID and an API token of its, from Workers AI's Use REST API,
 * which go on to the model once they can be an account's, a token left blank keeping the one Ember has.
 * The dashboard opens at the account typed, once it can be one.
 */
function KeysStep({
  hasToken,
  filledIn,
  deployedAccountId,
  typed,
  onType,
  refusal,
  onRefuse,
  onContinue,
  onCancel,
}: {
  hasToken: boolean;
  /** Whether the account's ID was filled in, so that the steps needn't say where to copy it from. */
  filledIn: boolean;
  deployedAccountId: string | null;
  typed: Record<KeyField, string>;
  onType: (field: KeyField, text: string) => void;
  refusal: Refusal | null;
  onRefuse: (field: KeyField, error: string) => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const next = (event: FormEvent) => {
    event.preventDefault();
    if (accountIdOf(typed.accountId) === null) return onRefuse("accountId", ACCOUNT_ID_REFUSED);
    if (typed.apiToken.trim() !== "" && apiTokenOf(typed.apiToken) === null) return onRefuse("apiToken", API_TOKEN_REFUSED);
    onContinue();
  };
  const accountId = accountIdOf(typed.accountId);
  const accountRefused = refusal?.field === "accountId";
  const deployedTo = !accountRefused && deployedAccountId !== null && accountId === deployedAccountId;
  const tokenRefused = refusal?.field === "apiToken";

  return (
    <form onSubmit={next}>
      <DialogDescription className="mb-4 leading-[1.65]">
        Ember AI asks a model through your Cloudflare account's AI Gateway. Workers AI's models come with a free daily allowance, and other companies' are paid
        for with AI Gateway's credits. Ember keeps the API token encrypted.
      </DialogDescription>
      <ol aria-label="Steps to make a Workers AI API token" className="mb-4 flex list-decimal flex-col gap-2 ps-5">
        <li>
          In the Cloudflare dashboard, open <em>Workers AI</em> and choose <em>Use REST API</em>. <Out href={workersAiDashboard(accountId)}>Open Workers AI in the Cloudflare dashboard</Out>
        </li>
        <li>
          Choose <em>Create a Workers AI API Token</em>, then <em>Create API Token</em>, and copy the token here.
        </li>
        {!filledIn && (
          <li>
            Copy the <em>Account ID</em> shown there too.
          </li>
        )}
      </ol>
      <div className="flex flex-col gap-4">
        <div>
          <Field id="assistant_account_id" label="Account ID">
            <Input
              id="assistant_account_id"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={typed.accountId}
              aria-invalid={accountRefused}
              aria-describedby={accountRefused ? "assistant-account-id-refusal" : deployedTo ? "assistant-account-id-description" : undefined}
              onChange={(event) => onType("accountId", event.target.value)}
              className={FIELD_INPUT}
            />
          </Field>
          {accountRefused ? (
            <FieldRefusal id="assistant-account-id-refusal" field="accountId" refusal={refusal} />
          ) : (
            deployedTo && (
              <p id="assistant-account-id-description" className={cn(NOTE, "mt-2")}>
                Ember is deployed to this account. To ask through another, paste that account's ID.
              </p>
            )
          )}
        </div>
        <div>
          <Field id="assistant_api_token" label="API token">
            <Input
              id="assistant_api_token"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={typed.apiToken}
              aria-invalid={tokenRefused}
              aria-describedby={tokenRefused ? "assistant-api-token-refusal" : hasToken ? "assistant-api-token-description" : undefined}
              onChange={(event) => onType("apiToken", event.target.value)}
              className={FIELD_INPUT}
            />
          </Field>
          {tokenRefused ? (
            <FieldRefusal id="assistant-api-token-refusal" field="apiToken" refusal={refusal} />
          ) : (
            hasToken && (
              <p id="assistant-api-token-description" className={cn(NOTE, "mt-2")}>
                Ember has an API token already. Leave this blank to keep it, or paste another to ask with it instead.
              </p>
            )
          )}
        </div>
      </div>
      <Actions back={onCancel} backLabel="Cancel" next={null} disabled={typed.accountId.trim() === "" || (!hasToken && typed.apiToken.trim() === "")} />
    </form>
  );
}

/**
 * The second step: the model @ember runs on, Workers AI's or another company's that Ember lists, or any
 * other in Cloudflare's catalog, by its ID, which Save asks a test question. AI Gateway's credits are
 * topped up in the account given, `accountId`.
 */
function ModelStep({
  accountId,
  model,
  onChoose,
  refusal,
  onRefuse,
  saving,
  onSave,
  onBack,
}: {
  accountId: string | null;
  model: ModelChoice;
  onChoose: (model: ModelChoice) => void;
  refusal: Refusal | null;
  onRefuse: (field: AssistantField, error: string) => void;
  saving: boolean;
  onSave: (model: string) => void;
  onBack: () => void;
}) {
  const another = model.chosen === ANOTHER_MODEL;
  // The model as chosen, or as typed, which may not be one yet.
  const id = another ? model.typed.trim() : model.chosen;
  const modelRefused = refusal?.field === "model";

  const save = (event: FormEvent) => {
    event.preventDefault();
    const chosen = modelOf(id);
    if (chosen === null) return onRefuse("model", MODEL_REFUSED);
    onSave(chosen);
  };

  return (
    <form onSubmit={save}>
      <DialogDescription className="mb-4 leading-[1.65]">
        Choose the model @ember runs on. Ember asks it a test question through AI Gateway before keeping it.
      </DialogDescription>
      <div className="flex flex-col gap-4">
        <div>
          <Field id="assistant_model" label="Model">
            <select
              id="assistant_model"
              value={model.chosen}
              disabled={saving}
              aria-invalid={modelRefused && !another}
              aria-describedby={modelRefused && !another ? "assistant-model-refusal" : id !== "" ? "assistant-model-cost" : undefined}
              onChange={(event) => onChoose({ ...model, chosen: event.target.value })}
              className={SELECT}
            >
              <optgroup label="Workers AI, with a free daily allowance">
                <ModelOptions workersAi />
              </optgroup>
              <optgroup label="Other companies', paid for with AI Gateway's credits">
                <ModelOptions workersAi={false} />
              </optgroup>
              <option value={ANOTHER_MODEL}>Another model…</option>
            </select>
          </Field>
          {!another && <FieldRefusal id="assistant-model-refusal" field="model" refusal={refusal} />}
        </div>
        {another && (
          <div>
            <Field id="assistant_model_id" label="Model ID">
              <Input
                id="assistant_model_id"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={MAX_MODEL_LENGTH}
                placeholder="company/model"
                value={model.typed}
                disabled={saving}
                aria-invalid={modelRefused}
                aria-describedby={modelRefused ? "assistant-model-refusal" : "assistant-model-id-description"}
                onChange={(event) => onChoose({ ...model, typed: event.target.value })}
                className={FIELD_INPUT}
              />
            </Field>
            {modelRefused ? (
              <FieldRefusal id="assistant-model-refusal" field="model" refusal={refusal} />
            ) : (
              <p id="assistant-model-id-description" className={cn(NOTE, "mt-2")}>
                Copy a model's ID from Cloudflare's catalog, such as anthropic/claude-sonnet-5.5. <Out href={MODEL_CATALOG}>Open the model catalog</Out>
              </p>
            )}
          </div>
        )}
      </div>
      {id !== "" && (
        <p id="assistant-model-cost" className={cn(NOTE, "mt-2")}>
          {isWorkersAiModel(id) ? (
            "Workers AI's models run on Cloudflare, free up to a daily allowance, and beyond it on Workers Paid."
          ) : (
            <>
              AI Gateway's credits pay for this model. Top them up under <em>Credits Available</em> in AI Gateway.{" "}
              <Out href={aiGatewayDashboard(accountId)}>Open AI Gateway in the Cloudflare dashboard</Out>
            </>
          )}
        </p>
      )}
      <p role="status" className={cn(NOTE, "mt-2 wrap-anywhere empty:mt-0", !saving && "text-negative")}>
        {saving ? `Asking ${modelName(id)} a test question…` : refusal?.field === null ? refusal.error : null}
      </p>
      <Actions back={onBack} next={null} nextLabel={saving ? "Asking…" : "Save"} disabled={id === ""} saving={saving} />
    </form>
  );
}

/** The models Ember lists that Workers AI runs, or else those of other companies. */
function ModelOptions({ workersAi }: { workersAi: boolean }) {
  return ASSISTANT_MODELS.filter(({ id }) => isWorkersAiModel(id) === workersAi).map(({ id, name }) => (
    <option key={id} value={id}>
      {name}
    </option>
  ));
}
