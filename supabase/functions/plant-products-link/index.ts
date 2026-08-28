// plant_products.link — links a plant to a product with no price yet ("+ Add New Product" for a
// plant, before any price list has priced it). Distinct from plant_products.applyMatch, which
// always carries a real price + the plant's raw wording as an alias — this is the bare link only.
// Idempotent: linking an already-linked pair returns already_linked, not an error.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "plant_id", "product_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, plant_id, product_id } = body;

    const [plant] = await sql`select id from plants where id = ${plant_id}`;
    if (!plant) return jsonResponse({ error: "unknown plant_id" }, 400);
    const [product] = await sql`select id from products where id = ${product_id}`;
    if (!product) return jsonResponse({ error: "unknown product_id" }, 400);

    const [existing] = await sql`select * from plant_products where plant_id = ${plant_id} and product_id = ${product_id}`;
    if (existing) return jsonResponse({ already_linked: true, plant_product: existing });

    const link = await sql.begin(async (tx) => {
      const [link] = await tx`insert into plant_products (plant_id, product_id) values (${plant_id}, ${product_id}) returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "plant_products", record_id: link.id, after: link });
      return link;
    });

    return jsonResponse({ created: true, plant_product: link }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
