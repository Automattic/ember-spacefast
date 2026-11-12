import { useContext, useEffect, useState, type FormEvent } from "react";
import {
  attachmentFingerprint,
  type AttachmentIdentity,
  findAttachmentIdentity,
  getAttachmentIdentity,
  retireAttachmentIdentity,
} from "../../../e2ee-attachments";
import { useMutation, useQuery } from "../../../native-sdk";
import { PeopleContext } from "../../hooks/use-directory";
import { PROFILE_PATH } from "../../hooks/use-route";
import { getVerifiedAttachmentFingerprint, verifyAttachmentFingerprint } from "../../lib/attachment-device-trust";
import { PageLink } from "../page-link";
import { Button } from "../ui/button";
import { Panel } from "./settings-page";

type AttachmentDevice = Pick<AttachmentIdentity, "deviceId" | "publicKey">;
type AccountDevices = { workspaceId: string; personId: string; devices: AttachmentDevice[]; currentDeviceRevoked?: boolean };
type RecipientDevice = AttachmentDevice & { personId: string };
type AttachmentRecipients = { workspaceId: string; senderId: string; protected: boolean; devices: RecipientDevice[]; missing: number };

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function useLocalDevice(workspaceId: string | undefined, personId: string, revision = 0) {
  const [result, setResult] = useState<{
    workspaceId: string;
    personId: string;
    revision: number;
    device: AttachmentDevice | null;
    fingerprint: string | null;
    error?: string;
  }>();

  useEffect(() => {
    if (!workspaceId) return;
    let active = true;
    async function load(workspace: string) {
      try {
        if (!globalThis.crypto?.subtle || !globalThis.indexedDB) {
          throw new Error("Encrypted attachments need a secure connection and browser storage.");
        }
        const identity = await findAttachmentIdentity(workspace, personId);
        const device = identity && { deviceId: identity.deviceId, publicKey: identity.publicKey };
        const fingerprint = device ? await attachmentFingerprint(device.publicKey) : null;
        if (active) setResult({ workspaceId: workspace, personId, revision, device, fingerprint });
      } catch (error) {
        if (active) setResult({
          workspaceId: workspace, personId, revision, device: null, fingerprint: null,
          error: errorMessage(error, "Ember could not read this browser’s attachment key."),
        });
      }
    }
    void load(workspaceId);
    return () => { active = false; };
  }, [workspaceId, personId, revision]);

  return result?.workspaceId === workspaceId && result?.personId === personId && result?.revision === revision ? result : undefined;
}

export function ProfileAttachmentDevices({ personId }: { personId: string }) {
  const result = useQuery<AccountDevices>("attachmentDevices");
  const account = result?.personId === personId ? result : undefined;
  const register = useMutation<[AttachmentDevice & { expectedPersonId: string }]>("registerAttachmentDevice");
  const revoke = useMutation<[string, string]>("revokeAttachmentDevice");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const local = useLocalDevice(account?.workspaceId, personId, revision);
  const currentDeviceId = local?.device?.deviceId;
  const deviceStatus = useQuery<AccountDevices>("attachmentDevices", ...(currentDeviceId ? [currentDeviceId] : []));
  const statusReady = !currentDeviceId || (deviceStatus?.personId === personId && deviceStatus.workspaceId === account?.workspaceId);
  const registration = account?.devices.find((device) => device.deviceId === currentDeviceId);
  const enrolled = registration && registration.publicKey === local?.device?.publicKey;

  async function enroll() {
    if (!account || busy || !local || local.error || registration || !statusReady) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      if (currentDeviceId && deviceStatus?.currentDeviceRevoked) {
        await retireAttachmentIdentity(account.workspaceId, personId, currentDeviceId);
      }
      const device = await getAttachmentIdentity(account.workspaceId, personId);
      await register({ deviceId: device.deviceId, publicKey: device.publicKey, expectedPersonId: personId });
      setNotice("This browser is enrolled.");
    } catch (error) {
      setError(errorMessage(error, "Ember could not enroll this browser."));
    } finally {
      setRevision((value) => value + 1);
      setBusy(false);
    }
  }

  async function revokeDevice(deviceId: string) {
    if (!account || busy || !confirm("Revoke this device? It will stop receiving keys for new encrypted attachments.")) return;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await revoke(deviceId, personId);
      if (deviceId === currentDeviceId) await retireAttachmentIdentity(account.workspaceId, personId, deviceId);
      setNotice("Device revoked.");
    } catch (error) {
      setError(errorMessage(error, "Ember could not revoke this device."));
    } finally {
      setRevision((value) => value + 1);
      setBusy(false);
    }
  }

  return (
    <section id="attachment-devices" className="mt-8 min-w-0 space-y-3 border-t pt-6" aria-labelledby="attachment-devices-heading">
      <h2 id="attachment-devices-heading" className="text-lg font-semibold">Encrypted attachment devices</h2>
      <p className="text-sm text-muted-foreground">Enroll this browser to send and open new encrypted files in private rooms and Pings. The browser stores its own key. Clearing browser data can make encrypted files unreadable here.</p>
      {(!account || !local || !statusReady) && <p role="status" className="text-sm">Checking attachment devices…</p>}
      {local?.error && <p role="alert" className="text-sm">{local.error}</p>}
      {account && local && !local.error && !registration && statusReady && (
        <Button type="button" variant="outline" className="touch:min-h-11 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground" disabled={busy} onClick={enroll}>Enroll this browser</Button>
      )}
      {registration && !enrolled && <p role="alert" className="text-sm">This browser’s key differs from its registered key. Revoke its registration and enroll again.</p>}
      {enrolled && local?.fingerprint && (
        <div className="min-w-0 space-y-2 rounded-md border p-3 text-sm">
          <h3 className="font-medium">This browser’s fingerprint</h3>
          <p className="text-muted-foreground">Give the full fingerprint to people in your private conversation in person or over a separate trusted channel.</p>
          <code className="block select-all break-all">{local.fingerprint}</code>
        </div>
      )}
      {account && account.devices.length > 0 && (
        <ul className="divide-y rounded-md border">
          {account.devices.map((device) => (
            <li key={device.deviceId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 p-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium">{device.deviceId === currentDeviceId ? "This browser" : "Enrolled device"}</p>
                <p className="break-all text-muted-foreground">Device ID {device.deviceId}</p>
              </div>
              <Button type="button" variant="outline" className="touch:min-h-11 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground" aria-label={`Revoke device ${device.deviceId}`} disabled={busy} onClick={() => void revokeDevice(device.deviceId)}>Revoke</Button>
            </li>
          ))}
        </ul>
      )}
      {error && <p role="alert" className="text-sm">{error}</p>}
      <p role="status" className="text-sm">{notice}</p>
    </section>
  );
}

export function RoomAttachmentDevices({ roomId, personId, people }: {
  roomId: string;
  personId: string;
  people: ReadonlyArray<{ id: string; name: string }>;
}) {
  const result = useQuery<AttachmentRecipients>("attachmentRecipients", roomId);
  const roster = result?.senderId === personId ? result : undefined;
  const local = useLocalDevice(roster?.workspaceId, personId);
  const directory = useContext(PeopleContext);
  const devices = roster?.devices.filter((device) =>
    device.personId !== personId || device.deviceId !== local?.device?.deviceId || device.publicKey !== local?.device?.publicKey,
  ) ?? [];
  if (roster && !roster.protected) return null;

  return (
    <Panel className="space-y-3" aria-labelledby="room-attachment-devices">
      <h2 id="room-attachment-devices" className="text-lg font-semibold">Encrypted attachment devices</h2>
      <p className="text-sm text-muted-foreground">Ask each device owner for the full fingerprint from their Profile in person or over a separate trusted channel. Enter it here to verify the device for encrypted file sharing.</p>
      <PageLink href={PROFILE_PATH} className="inline-block text-sm font-medium underline underline-offset-4 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground">Manage your devices in Profile</PageLink>
      {(!roster || !local) && <p role="status" className="text-sm">Checking conversation devices…</p>}
      {local?.error && <p role="alert" className="text-sm">{local.error}</p>}
      {roster && roster.missing > 0 && (
        <p className="text-sm">{roster.missing === 1 ? "One participant needs to enroll a device before anyone can send encrypted files." : `${roster.missing} participants need to enroll a device before anyone can send encrypted files.`}</p>
      )}
      {roster && local && !local.error && devices.length > 0 && (
        <ul className="divide-y">
          {devices.map((device) => (
            <DeviceVerification
              key={JSON.stringify([roster.workspaceId, personId, device.personId, device.deviceId, device.publicKey])}
              device={device}
              name={directory.get(device.personId)?.name ?? people.find((person) => person.id === device.personId)?.name ?? device.personId}
              personId={personId}
              workspaceId={roster.workspaceId}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function DeviceVerification({ device, name, personId, workspaceId }: {
  device: RecipientDevice;
  name: string;
  personId: string;
  workspaceId: string;
}) {
  const [entered, setEntered] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fingerprint, setFingerprint] = useState<string>();
  const saved = getVerifiedAttachmentFingerprint(workspaceId, personId, device.personId, device.deviceId);

  useEffect(() => {
    let active = true;
    attachmentFingerprint(device.publicKey).then(
      (value) => { if (active) setFingerprint(value); },
      () => { if (active) setError("Ember could not read this device’s fingerprint."); },
    );
    return () => { active = false; };
  }, [device.publicKey]);

  const changed = fingerprint && saved && fingerprint !== saved;
  const verified = fingerprint && fingerprint === saved;
  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!fingerprint || changed || busy) return;
    setBusy(true);
    setError("");
    try {
      await verifyAttachmentFingerprint(workspaceId, personId, device.personId, device.deviceId, fingerprint, entered);
      setEntered("");
      setNotice("Device verified.");
    } catch (error) {
      setError(errorMessage(error, "Ember could not verify this device."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="min-w-0 space-y-2 py-3 text-sm">
      <p className="font-medium">{name}{device.personId === personId ? " (your device)" : ""}</p>
      <p className="break-all text-muted-foreground">Device ID {device.deviceId}</p>
      {changed && <p role="alert">This verified device’s key changed. Ask its owner to revoke it and enroll again.</p>}
      {verified && <p role="status">{notice || "Verified"}</p>}
      {fingerprint && !saved && (
        <form className="space-y-2" onSubmit={verify}>
          <label className="block font-medium">
            Full fingerprint <span className="sr-only">for {name}’s device {device.deviceId}</span>
            <input
              type="text"
              value={entered}
              onChange={(event) => setEntered(event.target.value)}
              className="mt-1 block w-full rounded-md border bg-background p-2.5 font-mono focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
          <Button type="submit" variant="outline" className="touch:min-h-11 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground" disabled={busy}>Verify device</Button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </li>
  );
}
