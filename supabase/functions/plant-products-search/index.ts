// plant_products.search — read-only. "Everything this plant sells, with its price" (plants.html's
// Products & Prices tab) — or, given a product_id instead, every plant carrying that one product
// (the Coverage view in quotes.html).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { plant_id = null, product_id = null } = body;
    if (!plant_id && !product_id) return jsonResponse({ error: "plant_id or product_id is required" }, 400);
    const limit = Math.min(Number(body.limit) || 200, 1000);

    const results = await sql`
      select pp.*, pr.name_en as product_name_en, pr.name as product_name_es, pl.name as plant_name
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
