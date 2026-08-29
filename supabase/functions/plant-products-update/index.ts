// plant_products.update — edits the per-plant attributes of an existing plant+product link:
// brand, photo, spec sheet. Never touches the shared product row (name/category/temperature/
// packaging) — that stays products.update's job. Partial update: only fields present in the body
// change.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const UPDATABLE_FIELDS = ["brand_id", "photo_url", "spec_url", "notes"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from plant_products where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown plant_product id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];

    const link = await sql.begin(async (tx) => {
      const [link] = await tx`
        update plant_products set
          brand_id = ${merged.brand_id}, photo_url = ${merged.photo_url}, spec_url = ${merged.spec_url}, notes = ${merged.notes},
          updated_at = now()
        where id = ${id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "plant_products", record_id: id, before: existing, after: link });
      return link;
    });

    return jsonResponse({ updated: true, plant_product: link });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
