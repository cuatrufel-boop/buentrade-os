// purchaseOrders.setDeliveryDate — updates the real, working PU/delivery date after the order
// already exists. Real correction 2026-09-14: "la que me va a pedir el create order es la
// definitiva esa se puede ir ajustando hasta el final" — the date confirmed at Create Order
// (sent-offers-mark-won's confirmed_delivery_date) is NOT frozen like the price on the PO/SO
// documents; pickup schedules genuinely slip and the trader has to be able to correct the live
// date driving the transit/border-arrival math (and the day-before pickup reminder) right up until
// pickup actually happens. The already-sent PO/SO PDFs are untouched by this (see
// [[project_order_lifecycle_and_alerting_spec]] — "PO/SO are immutable once sent"); this only
// updates the live scheduling field both purchase_orders and sales_orders carry (kept in sync since
// it's one real operational fact, not a negotiated number). No insert here, so exempt from the
// idempotency-key rule (same shape as shipments-set-release-number).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "order_number", "delivery_date"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, order_number, delivery_date } = body;

    const [po] = await sql`select * from purchase_orders where order_number = ${order_number}`;
    if (!po) return jsonResponse({ error: "unknown order_number" }, 404);
    const [so] = await sql`select * from sales_orders where order_number = ${order_number}`;

    const result = await sql.begin(async (tx) => {
      const [updatedPo] = await tx`update purchase_orders set delivery_dates = ${tx.json([delivery_date])} where order_number = ${order_number} returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "purchase_orders", record_id: po.id, before: po, after: updatedPo });
      let updatedSo = so ?? null;
      if (so) {
        [updatedSo] = await tx`update sales_orders set delivery_dates = ${tx.json([delivery_date])} where order_number = ${order_number} returning *`;
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "sales_orders", record_id: so.id, before: so, after: updatedSo });
      }
      return { updatedPo, updatedSo };
    });

    return jsonResponse({ updated: true, purchase_order: result.updatedPo, sales_order: result.updatedSo });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
