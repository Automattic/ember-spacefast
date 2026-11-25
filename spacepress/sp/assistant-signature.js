// The checked JavaScript runtime exposes byte arrays for the provider's binary HMAC key.
export async function signWebhook(secret, body) {
  const decoded = atob(secret.slice(6));
  const key = new Uint8Array(Array.from(decoded, byte => byte.charCodeAt(0)));
  const block = key.length > 64 ? new Uint8Array(await crypto.subtle.digest("SHA-256", key)) : key;
  const inner = [];
  const outer = [];
  for (let i = 0; i < 64; i++) {
    const byte = block[i] ?? 0;
    inner.push(byte ^ 0x36);
    outer.push(byte ^ 0x5c);
  }
  const bytes = new TextEncoder().encode(body);
  const content = new Uint8Array([...inner, ...bytes]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
  const signed = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...outer, ...digest])));
  let binary = "";
  for (const byte of signed) binary += String.fromCharCode(byte);
  return "v1," + btoa(binary);
}
