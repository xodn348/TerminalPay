import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { getOrCreateKey } from "./vault.ts";

const IV_LEN = 12;
const TAG_LEN = 16;

// Subset of Patchright/Playwright's Cookie shape that we persist.
// Re-importable into BrowserContext.addCookies({ ... }) verbatim.
export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

function cookieDir(): string {
  const override = process.env["TERMPAY_COOKIES_DIR"];
  const dir = override ?? join(homedir(), ".termpay", "cookies");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Sanitize a merchant hostname for safe filesystem use.
function cookiePath(merchant: string): string {
  const safe = merchant.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (safe.length === 0) throw new Error("Invalid merchant name");
  return join(cookieDir(), `${safe}.enc`);
}

export function saveCookies(merchant: string, cookies: CookieRecord[]): void {
  const key = getOrCreateKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const json = Buffer.from(JSON.stringify(cookies), "utf8");
  const enc = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();
  writeFileSync(cookiePath(merchant), Buffer.concat([iv, enc, tag]));
}

export function loadCookies(merchant: string): CookieRecord[] | null {
  const p = cookiePath(merchant);
  if (!existsSync(p)) return null;
  const key = getOrCreateKey();
  const blob = readFileSync(p);
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const enc = blob.subarray(IV_LEN, blob.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(dec.toString("utf8")) as CookieRecord[];
}

export function deleteCookies(merchant: string): boolean {
  const p = cookiePath(merchant);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function listSavedMerchants(): string[] {
  const dir = cookieDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".enc"))
    .map((f) => f.slice(0, -".enc".length));
}
