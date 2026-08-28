// freight_orders.search — read-only. A won order can carry up to two rows (US leg + Mexican
// leg) — this returns whichever exist for the order_number, joined with the carrier's name so
// Real Costs (trading-tool.html) never needs a second lookup per row.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { order_number = null, sent_offer_id = null } = body;
    if (!order_number && !sent_offer_id) return jsonResponse({ error: "order_number or sent_offer_id is required" }, 400);
    const limit = Math.min(Number(body.limit) || 50, 200);

    const results = await sql`
      select fo.*, p.name as carrier_name
      from freight_orders fo
      left join providers p on p.id = fo.carrier_provider_id
      where (${order_number}::text is null or fo.order_number = ${order_number})
        and (${sent_offer_id}::uuid is null or fo.sent_offer_id = ${sent_offer_id})
      order by fo.created_at
      limit ${limit}
    `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
