let nodeRandomFill: ((buf: Uint8Array) => void) | undefined;

async function randomBytes(n: number): Promise<Uint8Array> {
  const buf = new Uint8Array(n);
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }).crypto;
  if (webCrypto?.getRandomValues) {
    webCrypto.getRandomValues(buf);
    return buf;
  }
  // Node 18 has no global `crypto` unless --experimental-global-webcrypto is set.
  if (!nodeRandomFill) {
    const nodeCrypto = await import('node:crypto');
    nodeRandomFill = (b) => nodeCrypto.randomFillSync(b);
  }
  nodeRandomFill(buf);
  return buf;
}

/**
 * Returns a new UUIDv7 (RFC 9562): 48-bit Unix milliseconds, then 74 random bits. Time-ordered
 * and unique, so it doubles as an idempotency key you can store before sending.
 */
export async function uuidv7(now: number = Date.now()): Promise<string> {
  const b = await randomBytes(16);
  const ms = Math.max(0, Math.floor(now));
  // 48-bit big-endian timestamp (split to stay within safe integer bit operations).
  const hi = Math.floor(ms / 2 ** 16);
  const lo = ms % 2 ** 16;
  b[0] = (hi >>> 24) & 0xff;
  b[1] = (hi >>> 16) & 0xff;
  b[2] = (hi >>> 8) & 0xff;
  b[3] = hi & 0xff;
  b[4] = (lo >>> 8) & 0xff;
  b[5] = lo & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70; // version 7
  b[8] = (b[8]! & 0x3f) | 0x80; // variant 10
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
