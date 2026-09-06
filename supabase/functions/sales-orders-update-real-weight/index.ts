// sales_orders.updateRealWeight — the ONE field Real Costs (trading-tool.html) writes on the sales
// side, mirroring freight_orders.actual_rate: weight (the quote, PO/SO's own number) never
// changes; real_weight (the customs pedimento's real figure) is what the Invoice uses once set.
// By order_number, same as freight-orders-search/order-extra-costs — Real Costs only ever knows
// the order_number, not the sales_orders row id.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "order_number"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, order_number, real_weight = null } = body;

    const [existing] = await sql`select * from sales_orders where order_number = ${order_number}`;
    if (!existing) return jsonResponse({ error: "unknown order_number" }, 404);

    const salesOrder = await sql.begin(async (tx) => {
      const [updated] = await tx`update sales_orders set real_weight = ${real_weight} where order_number = ${order_number} returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "sales_orders", record_id: existing.id, before: existing, after: updated });
      return updated;
    });

    return jsonResponse({ updated: true, sales_order: salesOrder });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
