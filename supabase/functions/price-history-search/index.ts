// price-history-search — read-only. Every real price ever recorded for a product (price_history,
// filled automatically since 2026-09-16 — see applyPlantProductMatch/plant-products-update), plus
// the same market-trend signal (today's best vs the prior-30-day average) already used to build
// the "Price X% better/worse" line in the customer-product signal. Returns null trend, not a
// fabricated one, until there's genuinely a prior day to compare against.

import postgres from "npm:postgres@3.4.4";
import { computeProductPriceSignal, jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const { product_id } = body;
    if (!product_id) return jsonResponse({ error: "product_id is required" }, 400);

    const results = await sql`
      select ph.price, ph.price_date, ph.created_at, pl.name as plant_name
      from price_history ph
      join plants pl on pl.id = ph.plant_id
      where ph.product_id = ${product_id}
      order by ph.price_date desc, ph.created_at desc
      limit 200
    `;

    const trend = await computeProductPriceSignal(sql, product_id);

    return jsonResponse({ results, trend });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
