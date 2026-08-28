// customer_products.search — read-only. "What does this customer buy" (pass customer_id), or the
// reverse — "which customers buy any of these products" (pass product_ids, an array) — quotes.html
// needs the reverse to find who to offer a just-matched product to.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { customer_id = null, product_ids = null } = body;
    if (!customer_id && !(Array.isArray(product_ids) && product_ids.length)) {
      return jsonResponse({ error: "customer_id or product_ids (non-empty array) is required" }, 400);
    }

    const results = customer_id
      ? await sql`
          select cp.*, p.name as product_name, p.name_en as product_name_en, p.brand
          from customer_products cp join products p on p.id = cp.product_id
          where cp.customer_id = ${customer_id}
          order by p.name
        `
      : await sql`
          select cp.*, p.name as product_name, p.name_en as product_name_en, p.brand
          from customer_products cp join products p on p.id = cp.product_id
          where cp.product_id = any(${product_ids})
          order by p.name
        `;
    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
