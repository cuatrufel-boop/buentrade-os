// freight_orders.update — partial update by row id. Real Costs (trading-tool.html) uses this for
// exactly two fields once a load is won: actual_rate (what the carrier really charged, vs.
// quoted_rate from the offer) and carrier_provider_id (the carrier actually booked, which can
// differ from whoever the rate was quoted from).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const UPDATABLE_FIELDS = ["carrier_provider_id", "origin", "destination", "quoted_rate", "actual_rate", "currency", "currency_id", "status"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from freight_orders where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown freight_order id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];

    const freightOrder = await sql.begin(async (tx) => {
      const [freightOrder] = await tx`
        update freight_orders set
          carrier_provider_id = ${merged.carrier_provider_id}, origin = ${merged.origin}, destination = ${merged.destination},
          quoted_rate = ${merged.quoted_rate}, actual_rate = ${merged.actual_rate},
          currency = ${merged.currency}, currency_id = ${merged.currency_id}, status = ${merged.status}
        where id = ${id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "freight_orders", record_id: id, before: existing, after: freightOrder });
      return freightOrder;
    });

    return jsonResponse({ updated: true, freight_order: freightOrder });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
