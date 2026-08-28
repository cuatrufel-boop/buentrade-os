// customer_products.search — read-only. "What does this customer buy" — customer_products.add/
// remove existed with nothing to list what's actually linked, found only by wiring up
// customers.html for real.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { customer_id = null } = body;
    if (!customer_id) return jsonResponse({ error: "customer_id is required" }, 400);

    const results = await sql`
      select cp.*, p.name as product_name, p.name_en as product_name_en, p.brand
      from customer_products cp join products p on p.id = cp.product_id
      where cp.customer_id = ${customer_id}
      order by p.name
    `;
    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
