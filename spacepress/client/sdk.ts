import { useCallback, useEffect, useState } from "react";
import { createClient } from "../sp/_generated/client/index";
import { prepareBody, userIdsIn } from "../../spacefast/client/richtext/dom";

const client = createClient();

const refreshListeners = new Set<() => void>();

export async function readAction(operation: string, args: unknown[]) {
  if (operation === "messageCheck") {
    const [roomId, clientMessageIds] = args as [string, string[]];
    return client.actions.messageCheck({ roomId, clientMessageIds });
  }
  if (operation === "threadChanges") {
    const [parentId, after, before, since, until] = args as [string, number, number, string, string];
    return client.actions.threadChanges({ parentId, after, before, since, until });
  }
  if (operation === "roomChanges") {
    const [roomId, after, before, since, until] = args as [string, number, number, string, string];
    return client.actions.roomChanges({ roomId, after, before, since, until });
  }
  if (operation === "invitations") return client.actions.invitationList();
  if (operation === "bots") return client.actions.botList();
  if (operation === "assistants") return client.actions.assistantList();
  if (operation === "pushSettings") return client.actions.pushSettings({ endpoint: String(args[0] ?? ""), expectedPersonId: String(args[1]) });
  if (operation === "attachment") return client.actions.attachment({ id: String(args[0]), deviceId: args[1] as string | undefined });
  if (operation === "attachmentRecipients") return client.actions.attachmentRecipients({ id: String(args[0]) });
  if (operation === "attachmentDevices") return client.actions.attachmentDeviceList({ deviceId: args[0] as string | undefined });
  if (operation === "search") {
    const { q, query, roomId, from, cursor, sort, hasLink, hasFile, withMe, inThread } =
      args[0] as Parameters<typeof client.actions.emberSearch>[0];
    return client.actions.emberSearch({ q, query, roomId, from, cursor, sort, hasLink, hasFile, withMe, inThread });
  }
  if (operation === "bootstrap") return client.actions.emberBootstrap();
  if (operation === "profile") return client.actions.emberProfile();
  if (operation === "settings") return client.actions.emberSettings();
  if (operation === "recentSearches") return client.actions.emberRecentSearches();
  if (operation === "directory") return client.actions.emberDirectory();
  if (operation === "sidebar") return client.actions.emberSidebar();
  const id = Number(args[0]);
  const cursor = Number(args[1]);
  const idInput = Number.isSafeInteger(id) && id > 0 ? { id } : {};
  const cursorInput = Number.isSafeInteger(cursor) && cursor > 0 ? { cursor } : {};
  if (operation === "room") return client.actions.emberRoom({ ...idInput, ...cursorInput });
  if (operation === "roomAfter") return client.actions.emberRoomAfter({ ...idInput, ...cursorInput });
  if (operation === "roomAround") return client.actions.emberRoomAround({ ...idInput, ...cursorInput });
  if (operation === "thread") return client.actions.emberThread({ ...idInput, ...cursorInput });
  if (operation === "roomSettings") return client.actions.emberRoomSettings(idInput);
  if (operation === "assistantNotice") return client.actions.emberAssistantNotice(idInput);
  return unsupported();
}

type ReadFailure = { status?: number; code?: string };
let leaving = false;

function leaveView(path: string) {
  if (leaving) return;
  leaving = true;
  const app = document.getElementById("ember-native-app");
  if (app) app.hidden = true;
  if (path === location.href) location.reload();
  else location.replace(path);
}

export function useQueryStatus<T>(operation: string, ...args: unknown[]) {
  const key = JSON.stringify(args);
  const [result, setResult] = useState<{ key: string; value?: T; error?: ReadFailure }>();
  useEffect(() => {
    let stopped = false;
    let pending = false;
    let previous: string | undefined;
    const poll = async () => {
      if (stopped || pending || (previous !== undefined && document.hidden)) return;
      pending = true;
      try {
        const value = await readAction(operation, JSON.parse(key)) as T;
        const snapshot = JSON.stringify(value);
        if (!stopped && snapshot !== previous) {
          previous = snapshot;
          setResult({ key, value });
        }
      } catch (error) {
        if (stopped) return;
        const failure = error as ReadFailure;
        const { status, code } = failure;
        if (code === "session_changed" || status === 401 || (status === 403 && operation === "bootstrap")) {
          leaveView(location.href);
          return;
        }
        if ((operation === "room" || operation === "thread") && (status === 403 || status === 404)) {
          const room = location.pathname.match(/^\/rooms\/\d+(?=\/|$)/)?.[0];
          leaveView(operation === "thread" && status === 404 && room && location.pathname.includes("/threads/") ? room : "/");
          return;
        }
        previous = undefined;
        const denied = status === 403 || status === 404;
        setResult(current => ({ key, value: !denied && current?.key === key ? current.value : undefined, error: failure }));
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(poll, ["room", "thread"].includes(operation) ? 2000 : 5000);
    document.addEventListener("visibilitychange", poll);
    refreshListeners.add(poll);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
      refreshListeners.delete(poll);
    };
  }, [operation, key]);
  return result?.key === key ? result : {};
}

export function useQuery<T>(operation: string, ...args: unknown[]): T | undefined {
  return useQueryStatus<T>(operation, ...args).value;
}

const unsupported = () => {
  throw Object.assign(new Error("This feature is not available in Ember on SpacePress."), { status: 501 });
};

const byId = new Set(["archiveRoom", "leaveRoom", "roomPresence", "deleteMessage", "unreact", "cancelFile", "revokeInvitation"]);

export function useMutation(operation: string) {
  return useCallback(async (...args: unknown[]) => {
    if (!Object.hasOwn(client.actions, operation)) return unsupported();
    const actions = client.actions as Record<string, (input?: unknown) => Promise<unknown>>;
    let input = args[0];
    if (byId.has(operation)) input = { id: args[0] };
    if (operation === "markRead") input = { id: args[0], through: args[1], expectedPersonId: args[2] };
    if (operation === "typing") input = { id: args[0], on: args[1] };
    if (operation === "revokeAttachmentDevice") input = { id: args[0], expectedPersonId: args[1] };
    if (operation === "startDirect") input = { userIds: args[0] };
    if (operation === "favoriteOrder" || operation === "sharedOrder") input = { roomIds: args[0] };
    if (operation === "sendMessage" || operation === "editMessage") {
      const message = input as { body: string };
      const mentions = userIdsIn(message.body);
      const directory = mentions.length
        ? await readAction("directory", []) as { users: { id: string; name: string; status: string }[] }
        : { users: [] };
      const prepared = prepareBody(message.body, id => directory.users.find(person => person.id === id && person.status === "active"));
      if (!prepared) throw new Error("This message could not be formatted.");
      input = { ...message, body: prepared.html, plainText: prepared.plainText };
    }
    const result = await actions[operation](input).catch((error: ReadFailure) => {
      // These mutations can return the record saved before a response was lost.
      if ((operation !== "commitFile" && operation !== "sendMessage") || (error.status && error.status < 500)) throw error;
      return actions[operation](input);
    });
    if (operation !== "roomPresence") refreshListeners.forEach(refresh => refresh());
    return result;
  }, [operation]);
}

export function useAuth() {
  const bootstrap = useQuery<{ nativeAuth: { identityId: string } }>("bootstrap");
  return { identity: bootstrap ? { userId: bootstrap.nativeAuth.identityId } : null };
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
export const unfurlAction = (url: string) => client.actions.unfurl({ url });
export const storage = {
  async upload(blob: Blob) {
    const result = await client.files.attachmentChunks.upload(blob, { filename: "ember-chunk.bin" });
    return { id: result.id.toString(16).padStart(32, "0"), url: result.url, size: result.size };
  },
  async delete(id: string) {
    await client.files.attachmentChunks.delete(Number.parseInt(id, 16));
  },
};
