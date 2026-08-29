// plants.delete — same confirm-then-delete discipline as products.delete/customers.delete/
// providers.delete (the other 3 master-data screens already have this; plants.html never did).
// Cascades DB-side: plant_products, plant_product_aliases, plant_term_aliases, and plant_locations
// are wiped with the plant (its whole price list and pickup addresses go with it). sent_offers and
// purchase_orders keep their history — plant_id just goes null there, real financial records are
// never destroyed by deleting a plant.

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

    const [existing] = await sql`select * from plants where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown plant id" }, 404);

    const [{ count: linkedProducts }] = await sql`select count(*)::int as count from plant_products where plant_id = ${id}`;
    const [{ count: linkedLocations }] = await sql`select count(*)::int as count from plant_locations where plant_id = ${id}`;
    const [{ count: historicalOffers }] = await sql`select count(*)::int as count from sent_offers where plant_id = ${id}`;

    let supplierAlsoDeleted = false;
    await sql.begin(async (tx) => {
      await tx`delete from plants where id = ${id}`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "plants", record_id: id, before: existing });

      // Every plant auto-creates its own supplier row (plants.html's "+ New Plant" flow) — with
      // that plant gone, an orphaned supplier with zero plants left behind would silently block
      // recreating a plant under the same name later (suppliers-create's own duplicate check would
      // find it). Same reasoning as suppliers-delete's own guard, just applied automatically here.
      const [{ count: remainingSiblingPlants }] = await tx`select count(*)::int as count from plants where supplier_id = ${existing.supplier_id}`;
      if (remainingSiblingPlants === 0) {
        const [supplier] = await tx`select * from suppliers where id = ${existing.supplier_id}`;
        if (supplier) {
          await tx`delete from suppliers where id = ${existing.supplier_id}`;
          await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "suppliers", record_id: existing.supplier_id, before: supplier });
          supplierAlsoDeleted = true;
        }
      }
    });

    return jsonResponse({
      deleted: true, id,
      cascaded_plant_products_removed: linkedProducts,
      cascaded_locations_removed: linkedLocations,
      historical_offers_unlinked: historicalOffers,
      supplier_also_deleted: supplierAlsoDeleted,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
