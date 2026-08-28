// customer_products.add — links a customer to a product they buy. Idempotent (already-linked
// returns already_linked, not an error) — the DB's own unique(customer_id, product_id) backs this.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "customer_id", "product_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, customer_id, product_id } = body;

    const [customer] = await sql`select id from customers where id = ${customer_id}`;
    if (!customer) return jsonResponse({ error: "unknown customer_id" }, 400);
    const [product] = await sql`select id from products where id = ${product_id}`;
    if (!product) return jsonResponse({ error: "unknown product_id" }, 400);

    const [existing] = await sql`select * from customer_products where customer_id = ${customer_id} and product_id = ${product_id}`;
    if (existing) return jsonResponse({ already_linked: true, link: existing });

    const link = await sql.begin(async (tx) => {
      const [link] = await tx`insert into customer_products (customer_id, product_id) values (${customer_id}, ${product_id}) returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "customer_products", record_id: link.id, after: link });
      return link;
    });

    return jsonResponse({ created: true, link }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
