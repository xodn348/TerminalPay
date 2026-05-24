import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set env vars before any db-dependent module is loaded (ESM caches on first load)
const testDbPath = join(tmpdir(), `termpay-orders-${randomBytes(4).toString("hex")}.sqlite`);
process.env["TERMPAY_DB_PATH"] = testDbPath;
process.env["TERMPAY_VAULT_KEY"] = randomBytes(32).toString("hex");

const { recordOrder, listOrders } = await import("./orders.ts");
const { db } = await import("./db.ts");

after(() => {
  try { db.close(); } catch { /* ignore */ }
  if (existsSync(testDbPath)) unlinkSync(testDbPath);
});

test("recordOrder inserts an order and retrieves it", () => {
  const order = recordOrder({
    merchant_order_id: "TEST-ORDER-123",
    items: [{ name: "API Credits", qty: 1, price: 5.00 }],
  });

  assert.ok(order.id, "order should have an id");
  assert.equal(order.merchant_order_id, "TEST-ORDER-123");
  assert.ok(order.items?.includes("API Credits"), "items should be serialised JSON");
  assert.equal(order.payment_id, null);
  assert.equal(order.carrier, null);
  assert.equal(order.tracking_number, null);
});

test("recordOrder stores shipping_address as JSON", () => {
  const addr = { street: "123 Main St", city: "Austin", country: "US" };
  const order = recordOrder({
    merchant_order_id: "TEST-ORDER-456",
    shipping_address: addr,
    carrier: "UPS",
    tracking_number: "1Z999AA10123456784",
  });

  assert.ok(order.shipping_address?.includes("Austin"), "address should be JSON");
  assert.equal(order.carrier, "UPS");
  assert.equal(order.tracking_number, "1Z999AA10123456784");
});

test("listOrders returns rows newest-first", () => {
  const o1 = recordOrder({ merchant_order_id: "LIST-ORD-1" });
  const o2 = recordOrder({ merchant_order_id: "LIST-ORD-2" });

  const orders = listOrders(50);
  assert.ok(orders.length >= 2, "should have at least two orders");

  const ids = orders.map(o => o.id);
  assert.ok(ids.includes(o1.id), "o1 should be in list");
  assert.ok(ids.includes(o2.id), "o2 should be in list");

  // Newest first
  const o2Idx = ids.indexOf(o2.id);
  const o1Idx = ids.indexOf(o1.id);
  assert.ok(o2Idx < o1Idx, "newer order should appear before older order");
});
