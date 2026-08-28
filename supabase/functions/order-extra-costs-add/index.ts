// order_extra_costs.add — a line-item extra cost on a won order (e.g. an unexpected inbond fee),
// added from the Real Costs panel. No update endpoint exists in production either — delete +
// re-add is the real edit path there, replicated here on purpose, not an oversight.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "order_number", "cost_type", "amount"].filter((k) => body[k] == null || body[k] === "");
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, order_number, sent_offer_id = null, cost_type, amount, notes = null } = body;

    const cost = await sql.begin(async (tx) => {
      const [cost] = await tx`
        insert into order_extra_costs (order_number, sent_offer_id, cost_type, amount, notes)
        values (${order_number}, ${sent_offer_id}, ${cost_type}, ${amount}, ${notes})
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "order_extra_costs", record_id: cost.id, after: cost });
      return cost;
    });

    return jsonResponse({ created: true, cost }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
