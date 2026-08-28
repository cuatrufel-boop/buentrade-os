// products.delete — matches production's confirm-then-delete, which explicitly warns it cascades
// (removes every plant's price/alias for this product too, DB-side ON DELETE CASCADE). Replicated
// as-is: the warning belongs in the caller UI, this endpoint just performs the delete + audit.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from products where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown product id" }, 404);

    const [{ count: linkedPlants }] = await sql`select count(*)::int as count from plant_products where product_id = ${id}`;

    await sql.begin(async (tx) => {
      await tx`delete from products where id = ${id}`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "products", record_id: id, before: existing });
    });

    return jsonResponse({ deleted: true, id, cascaded_plant_links_removed: linkedPlants });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
