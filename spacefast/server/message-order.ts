/** Keep same-millisecond messages in numeric ID order in the database time indexes. */
export function messageTimeKey(sentAt: string, id: string): string {
  return sentAt + '|' + (/^(?:0|[1-9]\d*)$/.test(id) ? id.padStart(20, '0') : id);
}
