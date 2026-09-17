// customer_products.update — the only writable fields today are the buying-cadence pair added
// 2026-09-16 (frequency_days, loads_per_cycle): what the trader is told on a call ("compro 3
// cargas por semana de este producto") and has nowhere else to go. Partial update, same shape as
// plant-products-update: only fields present in the body change.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const UPDATABLE_FIELDS = ["frequency_days", "loads_per_cycle", "last_known_order_date"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from customer_products where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown customer_product id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];

    const link = await sql.begin(async (tx) => {
      const [link] = await tx`
        update customer_products set
          frequency_days = ${merged.frequency_days}, loads_per_cycle = ${merged.loads_per_cycle},
          last_known_order_date = ${merged.last_known_order_date}
        where id = ${id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "customer_products", record_id: id, before: existing, after: link });
      return link;
    });

    return jsonResponse({ updated: true, link });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
