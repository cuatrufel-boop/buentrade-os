// plant_products.requestPrice — the "Ask Price" / "Update Price" action from Pending Quotes.
// Stamps last_requested_at on a plant_products row so the Pending list can sort by how recently
// it was actually chased (see quotes.html's loadPendingPrices — a row nobody's asked about looks
// different from one that was asked today and is just waiting). Does NOT touch current_price/
// price_date — this only records that a human asked, not that an answer came back; an actual
// price still arrives through plant_products.applyMatch.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "plant_id", "product_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, plant_id, product_id } = body;

    const [existing] = await sql`select * from plant_products where plant_id = ${plant_id} and product_id = ${product_id}`;
    if (!existing) return jsonResponse({ error: "no plant_products row for this plant_id + product_id" }, 404);

    const plantProduct = await sql.begin(async (tx) => {
      const [plantProduct] = await tx`
        update plant_products set last_requested_at = now()
        where plant_id = ${plant_id} and product_id = ${product_id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "plant_products", record_id: plantProduct.id, before: existing, after: plantProduct });
      return plantProduct;
    });

    return jsonResponse({ requested: true, plant_product: plantProduct });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
