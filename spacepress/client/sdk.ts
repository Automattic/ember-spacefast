import { useCallback, useEffect, useState } from "react";
import { createClient } from "../sp/_generated/client/index";
import { plainTextFromHtml } from "./text";

const client = createClient();

const refreshListeners = new Set<() => void>();

async function read(operation: string, args: unknown[]) {
  const id = Number(args[0]);
  const cursor = Number(args[1]);
  return client.actions.emberRead({
    operation,
    ...(Number.isSafeInteger(id) && id > 0 ? { id } : {}),
    ...(Number.isSafeInteger(cursor) && cursor > 0 ? { cursor } : {}),
  });
}

export function useQuery<T>(operation: string, ...args: unknown[]): T | undefined {
  const key = JSON.stringify(args);
  const [result, setResult] = useState<{ key: string; value: T }>();
  useEffect(() => {
    let stopped = false;
    let pending = false;
    let previous: string | undefined;
    const poll = async () => {
      if (stopped || pending || (previous !== undefined && document.hidden)) return;
      pending = true;
      try {
        const value = await read(operation, JSON.parse(key)) as T;
        const snapshot = JSON.stringify(value);
        if (!stopped && snapshot !== previous) {
          previous = snapshot;
          setResult({ key, value });
        }
      } catch (error) {
        if (!stopped && (error as { status?: number }).status === 404) setResult(undefined);
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(poll, operation === "room" ? 2000 : 5000);
    document.addEventListener("visibilitychange", poll);
    refreshListeners.add(poll);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      refreshListeners.delete(poll);
    };
  }, [operation, key]);
  return result?.key === key ? result.value : undefined;
}

const unsupported = () => {
  throw Object.assign(new Error("This feature is not available in Ember on SpacePress."), { status: 501 });
};

export function useMutation(operation: string) {
  return useCallback(async (input: any) => {
    if (operation === "markRead" || operation === "typing") return true;
    const { actions } = client;
    let result;
    if (operation === "createRoom") {
      result = await actions.createRoom(input);
    } else if (operation === "sendMessage") {
      if (input.parentId || input.fileId) return unsupported();
      const { roomId, clientMessageId, expectedCreatorId, body } = input;
      result = await actions.sendMessage({ roomId, clientMessageId, expectedCreatorId, body: plainTextFromHtml(body) });
    } else {
      return unsupported();
    }
    refreshListeners.forEach(refresh => refresh());
    return result;
  }, [operation]);
}

export function useAuth() {
  const bootstrap = useQuery<{ user: { id: string } }>("bootstrap");
  return { identity: bootstrap ? { userId: bootstrap.user.id } : null };
}

export function signOut() {
  location.assign("/wp-login.php?action=logout");
}

export async function signInWithSpacefast() {
  const url = "/wp-login.php";
  location.assign(url);
  return { url };
}

export const signInWithGoogle = signInWithSpacefast;
export const storage = { upload: unsupported, download: unsupported };
