import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import type { Order } from "./types.ts";

export interface RecordOrderInput {
  payment_id?: string | null;
  merchant_order_id?: string | null;
  items?: unknown;            // stored as JSON
  shipping_address?: unknown; // stored as JSON
  carrier?: string | null;
  tracking_number?: string | null;
}

export function recordOrder(input: RecordOrderInput): Order {
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    `INSERT INTO orders
       (id, payment_id, merchant_order_id, items, shipping_address, carrier, tracking_number, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.payment_id ?? null,
    input.merchant_order_id ?? null,
    input.items != null ? JSON.stringify(input.items) : null,
    input.shipping_address != null ? JSON.stringify(input.shipping_address) : null,
    input.carrier ?? null,
    input.tracking_number ?? null,
    createdAt,
  );
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as unknown as Order;
}

export function listOrders(limit: number): Order[] {
  return db
    .prepare("SELECT * FROM orders ORDER BY created_at DESC, rowid DESC LIMIT ?")
    .all(limit) as unknown as Order[];
}
