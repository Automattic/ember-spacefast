import { publicKey, sign } from './vendor/signer.mjs';

const endpoints = [
  ['https://fcm.googleapis.com', /^\/fcm\/send\/[A-Za-z0-9_:-]{16,2048}$/],
  ['https://updates.push.services.mozilla.com', /^\/wpush\/v2\/[A-Za-z0-9_-]{16,2048}$/],
  ['https://web.push.apple.com', /^\/[A-Za-z0-9_-]{16,2048}$/],
];

export function pushOrigin(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 2100 || endpoint !== endpoint.trim()) return null;
  // A literal authority and a single provider-specific token. No URL parser normalization.
  return endpoints.find(([origin, path]) => endpoint.startsWith(origin) && path.test(endpoint.slice(origin.length)))?.[0] ?? null;
}

const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function base64url(bytes) {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const value = (bytes[index] << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    encoded += base64Alphabet[value >>> 18] + base64Alphabet[(value >>> 12) & 63];
    if (index + 1 < bytes.length) encoded += base64Alphabet[(value >>> 6) & 63];
    if (index + 2 < bytes.length) encoded += base64Alphabet[value & 63];
  }
  return encoded;
}

export function vapidConfiguration(encodedKey, contact) {
  if (typeof encodedKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(encodedKey) || !validContact(contact)) return null;
  const key = new Uint8Array(32);
  for (let index = 0; index < key.length; index++) {
    const bit = index * 8;
    const start = Math.floor(bit / 6);
    const shift = 4 - (bit % 6);
    key[index] = ((base64Alphabet.indexOf(encodedKey[start]) << 6) | base64Alphabet.indexOf(encodedKey[start + 1])) >> shift;
  }
  if (base64url(key) !== encodedKey) return null;
  try {
    return { key, contact, publicKey: base64url(publicKey(key)) };
  } catch {
    return null;
  }
}

function validContact(contact) {
  if (typeof contact !== 'string' || contact.length > 512 || /[^!-~]|[\\]/.test(contact)) return false;
  if (/^mailto:[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/.test(contact)) return true;
  const https = /^https:\/\/((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?::([0-9]{1,5}))?(?:[/?#].*)?$/i.exec(contact);
  return Boolean(https
    && !/\.(?:localhost|local|internal|test|invalid|onion)$/i.test(https[1])
    && (!https[2] || Number(https[2]) > 0 && Number(https[2]) <= 65535));
}

const encodedHeader = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9';

export function activityPushRequest({ endpoint, key, contact, now = Date.now() }) {
  const origin = pushOrigin(endpoint);
  if (!origin) throw new Error('Unsupported browser push endpoint.');
  if (!validContact(contact)) {
    throw new Error('Configure a valid VAPID contact email or HTTPS page.');
  }
  if (!(key instanceof Uint8Array) || key.length !== 32 || !Number.isFinite(now) || now < 0) {
    throw new Error('Invalid Web Push signing configuration.');
  }

  const claims = JSON.stringify({ aud: origin, exp: Math.floor(now / 1000) + 3600, sub: contact });
  const signedPart = `${encodedHeader}.${base64url(Uint8Array.from(claims, character => character.charCodeAt(0)))}`;
  const signature = sign(Uint8Array.from(signedPart, character => character.charCodeAt(0)), key);
  return {
    url: endpoint,
    init: {
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      headers: {
        Authorization: `vapid t=${signedPart}.${base64url(signature)}, k=${base64url(publicKey(key))}`,
        TTL: '300',
        Topic: 'ember_activity',
      },
    },
  };
}
