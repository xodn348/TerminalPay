import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { CardPlain } from "./types.ts";

const SERVICE = "termpay";
const ACCOUNT = "vault-key-v1";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * Get the AES-256-GCM key for the vault, creating it on first use.
 *
 * macOS only: backed by the system Keychain via `security`. The key is 32
 * random bytes encoded as hex. Returns the raw 32-byte key.
 *
 * @returns 32-byte Buffer holding the vault key.
 * @throws if `security` fails for any reason other than "item not found".
 *
 * @example
 *   const key = getOrCreateKey();
 */
export function getOrCreateKey(): Buffer {
  try {
    const hex = execFileSync(
      "security",
      ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"],
      { encoding: "utf8" },
    ).trim();
    return Buffer.from(hex, "hex");
  } catch {
    const key = randomBytes(KEY_LEN);
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-s", SERVICE, "-a", ACCOUNT,
        "-w", key.toString("hex"),
        "-T", "",
      ],
      { stdio: "ignore" },
    );
    return key;
  }
}

/**
 * Encrypt a card with AES-256-GCM.
 *
 * Output layout: IV (12 bytes) || ciphertext || tag (16 bytes).
 *
 * @param plain - The card to encrypt. CVV is NEVER part of CardPlain.
 * @returns Encrypted blob suitable for `settings.encrypted_card`.
 */
export function encryptCard(plain: CardPlain, key?: Buffer): Uint8Array {
  const k = key ?? getOrCreateKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const json = Buffer.from(JSON.stringify(plain), "utf8");
  const enc = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, enc, tag]));
}

/**
 * Decrypt a card blob produced by {@link encryptCard}.
 */
export function decryptCard(blob: Uint8Array, key?: Buffer): CardPlain {
  const k = key ?? getOrCreateKey();
  const buf = Buffer.from(blob);
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const enc = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", k, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8")) as CardPlain;
}
