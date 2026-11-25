import { createHash, randomBytes } from "node:crypto";

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

type Point = { x: bigint; y: bigint; z: bigint };

function mod(a: bigint, n: bigint) {
  const r = a % n;
  return r < 0n ? r + n : r;
}

function inverse(value: bigint, n: bigint) {
  let x = 0n;
  let next = 1n;
  let a = n;
  let b = mod(value, n);
  while (b !== 0n) {
    const q = a / b;
    const remainder = a % b;
    a = b;
    b = remainder;
    const coefficient = x - q * next;
    x = next;
    next = coefficient;
  }
  return mod(x, n);
}

function double(p: Point): Point {
  const prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const zz = mod(p.z * p.z, prime);
  const yy = mod(p.y * p.y, prime);
  const beta = mod(p.x * yy, prime);
  const alpha = mod(3n * (p.x - zz) * (p.x + zz), prime);
  const x = mod(alpha * alpha - 8n * beta, prime);
  const y = mod(alpha * (4n * beta - x) - 8n * yy * yy, prime);
  return { x, y, z: mod(2n * p.y * p.z, prime) };
}

function addGenerator(p: Point): Point {
  const prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  const gx = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
  const gy = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;
  if (!p.z) return { x: gx, y: gy, z: 1n };
  const zz = mod(p.z * p.z, prime);
  const h = mod(gx * zz - p.x, prime);
  const r = mod(gy * p.z * zz - p.y, prime);
  if (h === 0n) return r === 0n ? double(p) : { x: 0n, y: 1n, z: 0n };
  const hh = mod(h * h, prime);
  const hhh = mod(hh * h, prime);
  const v = mod(p.x * hh, prime);
  const x = mod(r * r - hhh - 2n * v, prime);
  const y = mod(r * (v - x) - p.y * hhh, prime);
  return { x, y, z: mod(p.z * h, prime) };
}

function multiplyGenerator(scalar: bigint): Point {
  const prime = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
  let result: Point = { x: 0n, y: 1n, z: 0n };
  for (let bit = 255; bit >= 0; bit--) {
    result = double(result);
    if ((scalar >> BigInt(bit)) & 1n) result = addGenerator(result);
  }
  const z = inverse(result.z, prime);
  return { x: mod(result.x * z * z, prime), y: mod(result.y * z * z * z, prime), z: 1n };
}

function bytesBase64(bytes: number[]) {
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const value = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    encoded += (alphabet[value >>> 18] ?? "") + (alphabet[(value >>> 12) & 63] ?? "");
    if (i + 1 < bytes.length) encoded += alphabet[(value >>> 6) & 63] ?? "";
    if (i + 2 < bytes.length) encoded += alphabet[value & 63] ?? "";
  }
  return encoded;
}

function scalarBytes(value: bigint) {
  const bytes: number[] = [];
  for (let shift = 248n; shift >= 0n; shift -= 8n) bytes.push(Number((value >> shift) & 255n));
  return bytes;
}

function privateScalar(key: string) {
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return 0n;
  let value = 0n;
  for (const char of key) value = (value << 6n) | BigInt(alphabet.indexOf(char));
  if ((value & 3n) !== 0n) return 0n;
  value >>= 2n;
  return value > 0n && value < order ? value : 0n;
}

export function vapidPublicKey(key: string) {
  const value = privateScalar(key);
  if (!value) return "";
  const point = multiplyGenerator(value);
  return bytesBase64([4, ...scalarBytes(point.x), ...scalarBytes(point.y)]);
}

function signingBytes(value: string) {
  // JWT claims here are printable ASCII, including the configured VAPID contact.
  const ascii = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`" + "abcdefghijklmnopqrstuvwxyz{|}~";
  const bytes: number[] = [];
  for (const character of value) bytes.push(ascii.indexOf(character) + 32);
  return bytesBase64(bytes);
}

export function vapidToken(key: string, origin: string, contact: string, now: number) {
  const order = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const value = privateScalar(key);
  if (!value) return "";
  const data = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9." + signingBytes(JSON.stringify({
    aud: origin, exp: Math.floor(now / 1000) + 3600, sub: contact,
  }));
  const hash = BigInt("0x" + createHash("sha256").update(data).digest("hex"));
  for (let attempt = 0; attempt < 8; attempt++) {
    const k = BigInt("0x" + randomBytes(32).toString("hex"));
    if (!k || k >= order) continue;
    const r = mod(multiplyGenerator(k).x, order);
    const s = mod(inverse(k, order) * (hash + r * value), order);
    if (r && s) return data + "." + bytesBase64([...scalarBytes(r), ...scalarBytes(s)]);
  }
  return "";
}
