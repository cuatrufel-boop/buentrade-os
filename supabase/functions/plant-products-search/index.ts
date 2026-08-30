// plant_products.search — read-only. "Everything this plant sells, with its price" (plants.html's
// Products & Prices tab), every plant carrying one product (the Coverage view in quotes.html), or
// — with no filter at all — every plant_products row with its product's category attached, which
// is what plants.html's plant-list badges and the price-list category pre-fill need (both plant_id
// and product_id are optional now; empty means "everything," same rule as the other .search
// functions).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { plant_id = null, product_id = null } = body;
    const limit = Math.min(Number(body.limit) || 500, 2000);

    const results = await sql`
      select
        pp.id, pp.plant_id, pp.product_id, pp.current_price, pp.price_currency, pp.price_currency_id,
        pp.price_date, pp.availability, pp.docs_included, pp.notes, pp.last_requested_at,
        pp.brand_id, pp.photo_url, pp.spec_url, pp.location_id, pp.freight_included,
        pp.created_at, pp.updated_at,
        pl.name as plant_name,
        to_jsonb(pr.*) as product
      from plant_products pp
      join products pr on pr.id = pp.product_id
      join plants pl on pl.id = pp.plant_id
      where (${plant_id}::uuid is null or pp.plant_id = ${plant_id})
        and (${product_id}::uuid is null or pp.product_id = ${product_id})
      order by pr.name_en
      limit ${limit}
    `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
