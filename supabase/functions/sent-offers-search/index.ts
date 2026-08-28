// sent_offers.search — read-only. Powers the Offers screen: every offer ever sent, whichever path
// it came from (fresh Quotes price or a chased Pending one — both land in the same sent_offers
// table by design, see plant_products.requestPrice / sent_offers.create). Ordered by customer then
// product by default, per the trader's own words (2026-08-25): "se ordenan por cliente y por
// producto" — pass order_by: "product" to flip to product-then-customer instead.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const VALID_STATUSES = ["sent", "won", "lost"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    const { customer_id = null, product_id = null, status = null, order_by = "customer" } = body;
    const limit = Math.min(Number(body.limit) || 100, 500);

    if (status && !VALID_STATUSES.includes(status)) {
      return jsonResponse({ error: "invalid status", valid_statuses: VALID_STATUSES }, 400);
    }

    const orderClause = order_by === "product"
      ? sql`order by product_name, customer_name, sent_at desc`
      : sql`order by customer_name, product_name, sent_at desc`;

    const results = await sql`
      select * from sent_offers
      where (${customer_id}::uuid is null or customer_id = ${customer_id})
        and (${product_id}::uuid is null or product_id = ${product_id})
        and (${status}::text is null or status = ${status})
      ${orderClause}
      limit ${limit}
    `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
