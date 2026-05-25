import { test } from "node:test";
import assert from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["TERMPAY_COOKIES_DIR"] = mkdtempSync(join(tmpdir(), "termpay-cookies-test-"));
process.env["TERMPAY_VAULT_KEY"] =
  process.env["TERMPAY_VAULT_KEY"] ??
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const { saveCookies, loadCookies, deleteCookies, listSavedMerchants } =
  await import("./cookies.ts");

test("save → load round-trip preserves cookies", () => {
  const merchant = `m-${randomUUID()}.com`;
  const cookies = [
    {
      name: "session",
      value: "abc123",
      domain: merchant,
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax" as const,
    },
    { name: "lang", value: "en-US", domain: merchant, path: "/" },
  ];
  saveCookies(merchant, cookies);
  const out = loadCookies(merchant);
  assert.deepEqual(out, cookies);
});

test("load returns null when no cookies stored", () => {
  assert.equal(loadCookies(`absent-${randomUUID()}.com`), null);
});

test("delete returns true once, false on second call", () => {
  const merchant = `del-${randomUUID()}.com`;
  saveCookies(merchant, [{ name: "x", value: "y", domain: merchant, path: "/" }]);
  assert.equal(deleteCookies(merchant), true);
  assert.equal(deleteCookies(merchant), false);
  assert.equal(loadCookies(merchant), null);
});

test("filesystem-unsafe merchant names are sanitized", () => {
  const merchant = "evil/../escape.com";
  saveCookies(merchant, [{ name: "x", value: "y", domain: "evil.com", path: "/" }]);
  // No throw, no escape — the sanitized name maps to a single file in TERMPAY_COOKIES_DIR.
  const out = loadCookies(merchant);
  assert.ok(out);
  assert.equal(out?.[0]?.value, "y");
});

test("listSavedMerchants returns the persisted merchants", () => {
  const a = `list-a-${randomUUID()}.com`;
  const b = `list-b-${randomUUID()}.com`;
  saveCookies(a, [{ name: "x", value: "1", domain: a, path: "/" }]);
  saveCookies(b, [{ name: "x", value: "2", domain: b, path: "/" }]);
  const all = listSavedMerchants();
  assert.ok(all.includes(a));
  assert.ok(all.includes(b));
});

test("decrypt with wrong vault key fails", async () => {
  const merchant = `wrongkey-${randomUUID()}.com`;
  saveCookies(merchant, [{ name: "x", value: "y", domain: merchant, path: "/" }]);

  const prev = process.env["TERMPAY_VAULT_KEY"];
  process.env["TERMPAY_VAULT_KEY"] =
    "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

  // Re-import after key change so vault.ts re-reads env (it doesn't cache; this is defensive).
  const reimported = await import(`./cookies.ts?bust=${randomUUID()}`);
  assert.throws(() => reimported.loadCookies(merchant));

  process.env["TERMPAY_VAULT_KEY"] = prev;
});
