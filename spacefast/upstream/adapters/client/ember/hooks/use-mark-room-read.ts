import { useMemo } from "react";
import { readAction } from "../../native-sdk";
import { mutateNative } from "../../native-transport";

export function useMarkRoomRead(roomId: string, personId: string) {
  return useMemo(() => {
    if (!readAction) return undefined;
    let confirmed = 0;
    let newest = 0;
    let sending = false;

    async function send() {
      sending = true;
      while (newest > confirmed) {
        const through = newest;
        try {
          await mutateNative("markRead", roomId, String(through), personId);
          confirmed = through;
        } catch {
          // A later view or reconnect can retry this cursor.
          if (newest === through) newest = confirmed;
        }
      }
      sending = false;
    }

    return (messageId: string) => {
      const through = Number(messageId);
      if (!Number.isSafeInteger(through) || through <= newest) return;
      newest = through;
      if (!sending) void send();
    };
  }, [roomId, personId]);
}
