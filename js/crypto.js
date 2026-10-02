// Web Crypto helpers. Folder password -> PBKDF2-SHA256 (600k iterations) -> AES-GCM-256 key.
// Keys are created non-extractable and only ever live in memory while a folder is unlocked.
const te = new TextEncoder();
const td = new TextDecoder();

export const PBKDF2_ITERATIONS = 600000;

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(password, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', te.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Returns {iv, ct} (both Uint8Array). A fresh random 96-bit IV for every encryption.
export async function encryptBytes(key, bytes, aad) {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, bytes));
  return { iv, ct };
}

export async function decryptBytes(key, box, aad) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: box.iv, additionalData: aad }, key, box.ct));
}

export async function encryptJSON(key, obj, aad) {
  return encryptBytes(key, te.encode(JSON.stringify(obj)), aad);
}

export async function decryptJSON(key, box, aad) {
  return JSON.parse(td.decode(await decryptBytes(key, box, aad)));
}
