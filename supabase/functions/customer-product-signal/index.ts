// customer-product-signal — read-only. The "necesidad" signal (2026-09-16): for a customer and a
// list of products (whatever a quote is currently pricing), returns whichever of those products
// has something real to say — cadence due, price trend favorable, or credit exposure a trader
// should know before quoting. Never invents a reason: a product with nothing real returns nothing.

import postgres from "npm:postgres@3.4.4";
import { computeCustomerProductSignal, jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const { customer_id, product_ids } = body;
    if (!customer_id || !Array.isArray(product_ids) || !product_ids.length) {
      return jsonResponse({ error: "customer_id and a non-empty product_ids array are required" }, 400);
    }

    const signals = [];
    for (const productId of product_ids) {
      const signal = await computeCustomerProductSignal(sql, customer_id, productId);
      if (signal) signals.push({ product_id: productId, ...signal });
    }

    return jsonResponse({ signals });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
