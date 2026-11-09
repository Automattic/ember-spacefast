import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CallsSettings } from "@ember/protocol";
import { APP_ID_REFUSED, APP_SECRET_REFUSED, appIdOf, appSecretOf, type CallsField } from "@ember/protocol/calls";
import { FIELD_INPUT, Field } from "@/components/field";
import { Xmark } from "@/components/icons/iconoir";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMounted } from "@/hooks/use-mounted";
import { ApiError, isSignedOut, saveCalls } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Actions } from "./assistant-setup";
import { dashboard, NOTE, Out } from "./model-picker";
import { DIALOG, DIALOG_BACKDROP, DIALOG_CLOSE, DIALOG_TITLE } from "./unsaved-changes";

// Set up calls, for administrators: the steps to give Ember the keys of a Realtime SFU app, which calls
// run through, in a dialog that the Calls card of Rooms and permissions opens. Cloudflare's dashboard
// makes the app, in the account Ember is deployed to when the deploy gave it, and shows its ID and its
// secret, which the Worker has Cloudflare start a session with before keeping them, saying on the field
// it's about why it didn't, if it didn't. Styled as Set up Turnstile is.

/** Where Realtime's SFU apps are made, in the Cloudflare dashboard. */
const sfuDashboard = (accountId: string | null) => dashboard(accountId, "realtime/sfu");

/** Where it's at: the app's keys, or done. */
type Step = "keys" | "done";

const TITLES: Record<Step, string> = { keys: "Set up calls", done: "Calls are set up" };

/** Why the keys weren't kept, said on the field it's about, or else, with no field, under them. */
interface Refusal {
  field: CallsField | null;
  error: string;
}

interface Props {
  calls: CallsSettings | null;
  /** The Cloudflare account Ember is deployed to, whose SFU apps the dashboard opens at, if the deploy gave it. */
  deployedAccountId: string | null;
  /** Shows calls as they're saved. */
  onSaved: (calls: CallsSettings) => void;
  onClose: () => void;
  /** Says why saving failed, when it isn't the keys' or Cloudflare's doing, as the workspace's alerts do. */
  onFailed: (error: unknown) => void;
}

/** Set up calls: an SFU app's ID and secret, which are saved once Cloudflare has started a session with them. */
export function CallsSetup({ calls, deployedAccountId, onSaved, onClose, onFailed }: Props) {
  const [step, setStep] = useState<Step>("keys");
  const [typed, setTyped] = useState<Record<CallsField, string>>({ appId: calls?.appId ?? "", appSecret: "" });
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // Checking the keys with Cloudflare holds the dialog open until it's answered.
  const [saving, setSaving] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const shown = useRef(step);
  const mounted = useMounted();

  // Each step starts at its title, so that it's read first.
  useEffect(() => {
    if (shown.current === step) return;
    shown.current = step;
    title.current?.focus();
  }, [step]);

  const type = (field: CallsField, text: string) => {
    setTyped((typed) => ({ ...typed, [field]: text }));
    if (refusal?.field === field || refusal?.field === null) setRefusal(null);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const [appId, appSecret] = [appIdOf(typed.appId), appSecretOf(typed.appSecret)];
    if (appId === null) return setRefusal({ field: "appId", error: APP_ID_REFUSED });
    if (appSecret === null) return setRefusal({ field: "appSecret", error: APP_SECRET_REFUSED });
    setRefusal(null);
    setSaving(true);
    saveCalls({ appId, appSecret }).then(
      (saved) => {
        onSaved(saved);
        if (!mounted.current) return;
        setSaving(false);
        setStep("done");
      },
      (error: unknown) => {
        if (!mounted.current && !isSignedOut(error)) return;
        setSaving(false);
        // What Cloudflare or the Worker said of the keys, or that Cloudflare didn't answer, which the step says itself.
        if (error instanceof ApiError && [422, 502].includes(error.status)) return setRefusal({ field: fieldOf(error.field), error: error.message });
        onFailed(error);
      },
    );
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
        // The keys typed aren't lost to a click beside it.
        onInteractOutside={(event) => event.preventDefault()}
        className={cn(DIALOG, "w-[480px]")}
      >
        <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className={DIALOG_CLOSE}>
          <Xmark className="size-[18px]" />
        </button>
        <DialogTitle ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "pe-10 outline-none")}>
          {TITLES[step]}
        </DialogTitle>
        {step === "keys" ? (
          <form onSubmit={save}>
            <DialogDescription className="mb-4 leading-[1.65]">
              Calls run through Cloudflare's Realtime SFU, which carries what each person in a call says to the others. It has a free monthly allowance, and
              what it sends past that is billed to your Cloudflare account. Ember keeps the app's secret encrypted.
            </DialogDescription>
            <ol aria-label="Steps to make a Realtime SFU app" className="mb-4 flex list-decimal flex-col gap-2 ps-5">
              <li>
                In the Cloudflare dashboard, open <em>Realtime</em> and choose <em>Serverless SFU</em>, then create an app.{" "}
                <Out href={sfuDashboard(deployedAccountId)}>Open Serverless SFU in the Cloudflare dashboard</Out>
              </li>
              <li>
                Copy the app's <em>App ID</em> and <em>App Secret</em> here.
              </li>
            </ol>
            <div className="flex flex-col gap-4">
              <KeyInput field="appId" id="calls_app_id" label="App ID" typed={typed.appId} onType={type} refusal={refusal} disabled={saving} />
              <KeyInput field="appSecret" id="calls_app_secret" label="App Secret" typed={typed.appSecret} onType={type} refusal={refusal} disabled={saving} />
            </div>
            {calls !== null && <p className={cn(NOTE, "mt-2")}>Ember has an app's keys already. Give another app's to run calls through it instead.</p>}
            <p role="status" className={cn(NOTE, "mt-4 wrap-anywhere empty:mt-0", !saving && "text-negative")}>
              {saving ? "Asking Cloudflare to start a session with the app's keys…" : refusal?.field === null ? refusal.error : null}
            </p>
            <Actions
              back={onClose}
              backLabel="Cancel"
              next={null}
              nextLabel={saving ? "Checking…" : "Save"}
              disabled={typed.appId.trim() === "" || typed.appSecret.trim() === ""}
              saving={saving}
            />
          </form>
        ) : (
          <>
            <DialogDescription className="mb-4 leading-[1.65]">
              Cloudflare started a session with the app's keys, so calls can run through it. Ember keeps the keys until calls are turned off.
            </DialogDescription>
            <Actions back={null} next={onClose} nextLabel="Done" />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The field of Set up calls a refusal names, if it names one. */
const fieldOf = (field: string | undefined): CallsField | null => (field === "appId" || field === "appSecret" ? field : null);

/** A key's field, with why it's refused under it, if it is. */
function KeyInput({
  field,
  id,
  label,
  typed,
  onType,
  refusal,
  disabled,
}: {
  field: CallsField;
  id: string;
  label: string;
  typed: string;
  onType: (field: CallsField, text: string) => void;
  refusal: Refusal | null;
  disabled: boolean;
}) {
  const refused = refusal?.field === field ? refusal.error : null;
  return (
    <div>
      <Field id={id} label={label}>
        <Input
          id={id}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={typed}
          disabled={disabled}
          aria-invalid={refused !== null}
          aria-describedby={refused !== null ? `${id}_refusal` : undefined}
          onChange={(event) => onType(field, event.target.value)}
          className={FIELD_INPUT}
        />
      </Field>
      {refused !== null && (
        <p id={`${id}_refusal`} role="alert" className={cn(NOTE, "mt-2 wrap-anywhere text-negative")}>
          {refused}
        </p>
      )}
    </div>
  );
}
