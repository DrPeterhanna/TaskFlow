
let lastMs = 0;
let counter = 0;

/**
 * UUID v7 (time-ordered, strictly increasing within this process): 48-bit ms timestamp, 12-bit counter
 * for ids created in the same millisecond, 62 random bits. The server derives op-id age from the timestamp.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  let ms = Math.max(nowMs, lastMs);
  if (ms === lastMs) {
    counter++;
    if (counter > 0xfff) { ms++; counter = 0; }
  } else {
    counter = 0;
  }
  lastMs = ms;
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);   // Node, browsers; React Native via expo-crypto polyfill (see index.ts)
  const ts = BigInt(ms);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = 0x70 | (counter >> 8);
  b[7] = counter & 0xff;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
