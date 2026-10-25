/** Password-protected notes: AES-GCM 256 with a key derived from the password by PBKDF2-SHA256. Everything runs locally. */

export const ENCRYPTED_MARK = "<!-- bmnotes:encrypted v1 -->";
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const VERSION = 1;

export function isEncrypted(content: string): boolean {
  return content.startsWith(ENCRYPTED_MARK) || content.startsWith("<!-- bm-notes:encrypted v1 -->");
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt as BufferSource, iterations: ITERATIONS, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** The file text for an encrypted note: a readable marker plus one line of base64 (version | salt | iv | ciphertext). */
export async function encryptText(plain: string, password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(password, salt);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plain)));
  const blob = new Uint8Array(1 + SALT_BYTES + IV_BYTES + ct.length);
  blob[0] = VERSION;
  blob.set(salt, 1);
  blob.set(iv, 1 + SALT_BYTES);
  blob.set(ct, 1 + SALT_BYTES + IV_BYTES);
  return `${ENCRYPTED_MARK}\nThis note is encrypted. Open it in bmnotes and enter the password to read it.\n\n${toB64(blob)}\n`;
}

/** Throws `Error("Wrong password or damaged note")` when the password is wrong or the text was altered. */
export async function decryptText(content: string, password: string): Promise<string> {
  const fail = () => new Error("Wrong password or damaged note");
  if (!isEncrypted(content)) throw new Error("This note is not encrypted");
  const line = content.trim().split("\n").pop() ?? "";
  let blob: Uint8Array;
  try {
    blob = fromB64(line.trim());
  } catch {
    throw fail();
  }
  if (blob.length < 1 + SALT_BYTES + IV_BYTES + 16 || blob[0] !== VERSION) throw fail();
  const salt = blob.slice(1, 1 + SALT_BYTES);
  const iv = blob.slice(1 + SALT_BYTES, 1 + SALT_BYTES + IV_BYTES);
  const ct = blob.slice(1 + SALT_BYTES + IV_BYTES);
  try {
    const key = await deriveKey(password, salt);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ct as BufferSource));
  } catch {
    throw fail();
  }
}
