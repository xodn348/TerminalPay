import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { CardPlain } from "./types.ts";

const SERVICE = "termpay";
const ACCOUNT = "vault-key-v1";
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

// Returns the 32-byte AES-256-GCM vault key.
// Headless envs: set TERMPAY_VAULT_KEY to a 64-char hex string.
// macOS: backed by the system Keychain via `security`.
export function getOrCreateKey(): Buffer {
  const envKey = process.env["TERMPAY_VAULT_KEY"];
  if (envKey) {
    return Buffer.from(envKey, "hex");
  }
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

// Encrypt a CardPlain with AES-256-GCM.
// Output layout: IV (12 bytes) || ciphertext || GCM tag (16 bytes).
export function encryptCard(plain: CardPlain, key?: Buffer): Uint8Array {
  const k = key ?? getOrCreateKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const json = Buffer.from(JSON.stringify(plain), "utf8");
  const enc = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  return new Uint8Array(Buffer.concat([iv, enc, tag]));
}

// Decrypt a blob produced by encryptCard.
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
