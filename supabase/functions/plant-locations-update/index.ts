// plant_locations.update — partial update, no duplicate discipline (see create for why).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const UPDATABLE_FIELDS = ["location_name", "protein", "freight_to_border_usd", "delivered_by_plant", "contact_name", "phone", "email", "notes"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from plant_locations where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown plant_location id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];

    const location = await sql.begin(async (tx) => {
      const [location] = await tx`
        update plant_locations set
          location_name = ${merged.location_name}, protein = ${merged.protein},
          freight_to_border_usd = ${merged.freight_to_border_usd}, delivered_by_plant = ${merged.delivered_by_plant},
          contact_name = ${merged.contact_name}, phone = ${merged.phone}, email = ${merged.email}, notes = ${merged.notes},
          updated_at = now()
        where id = ${id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "plant_locations", record_id: id, before: existing, after: location });
      return location;
    });

    return jsonResponse({ updated: true, location });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
