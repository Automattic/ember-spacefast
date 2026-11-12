const fingerprintPattern = /^[a-f0-9]{64}$/;

function storageKey(workspaceId: string, viewerId: string, personId: string, deviceId: string): string {
  return `ember:verified-attachment-device:${JSON.stringify([workspaceId, viewerId, personId, deviceId])}`;
}

export function getVerifiedAttachmentFingerprint(workspaceId: string, viewerId: string, personId: string, deviceId: string): string | null {
  try {
    const saved = localStorage.getItem(storageKey(workspaceId, viewerId, personId, deviceId));
    return saved && fingerprintPattern.test(saved) ? saved : null;
  } catch {
    return null;
  }
}

function saveFingerprint(key: string, fingerprint: string): void {
  const saved = localStorage.getItem(key);
  if (saved !== null && saved !== fingerprint) {
    throw new Error("A verified device’s fingerprint changed. Ask its owner to enroll a new device.");
  }
  localStorage.setItem(key, fingerprint);
}

function saveWithDatabaseLock(key: string, fingerprint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("ember-attachment-trust", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("lock");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      // The read/write transaction serializes the localStorage check and save across tabs.
      const transaction = db.transaction("lock", "readwrite");
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
      const request = transaction.objectStore("lock").get(key);
      request.onsuccess = () => {
        try {
          saveFingerprint(key, fingerprint);
        } catch (error) {
          reject(error);
          transaction.abort();
        }
      };
    };
  });
}

export async function verifyAttachmentFingerprint(
  workspaceId: string,
  viewerId: string,
  personId: string,
  deviceId: string,
  fingerprint: string,
  enteredFingerprint: string,
): Promise<void> {
  const entered = enteredFingerprint.replace(/[\s-]/g, "").toLowerCase();
  if (!fingerprintPattern.test(fingerprint) || entered !== fingerprint) {
    throw new Error("The fingerprints don’t match. Check the full fingerprint with the device owner.");
  }

  const key = storageKey(workspaceId, viewerId, personId, deviceId);
  try {
    if (navigator.locks) await navigator.locks.request(key, () => saveFingerprint(key, fingerprint));
    else await saveWithDatabaseLock(key, fingerprint);
  } catch (error) {
    if (error instanceof Error && error.name === "Error") throw error;
    throw new Error("This browser could not save the verification.");
  }
}
