// plant_locations.create — a pickup/shipping location for a plant. Not master-data-duplicate-
// sensitive the way products/customers are (a plant can have several real locations with similar
// names on purpose), so no near-duplicate confirmation flow — just requires a real plant_id.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "plant_id", "location_name"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const {
      actor, plant_id, location_name, protein = null, freight_to_border_usd = null,
      delivered_by_plant = null, contact_name = null, phone = null, email = null, notes = null,
      idempotency_key = null,
    } = body;

    const [plant] = await sql`select id from plants where id = ${plant_id}`;
    if (!plant) return jsonResponse({ error: "unknown plant_id" }, 400);

    if (idempotency_key) {
      const [existing] = await sql`select * from plant_locations where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ created: true, location: existing, idempotent_replay: true });
    }

    const location = await sql.begin(async (tx) => {
      const [location] = await tx`
        insert into plant_locations (plant_id, location_name, protein, freight_to_border_usd, delivered_by_plant, contact_name, phone, email, notes, idempotency_key)
        values (${plant_id}, ${location_name}, ${protein}, ${freight_to_border_usd}, ${delivered_by_plant}, ${contact_name}, ${phone}, ${email}, ${notes}, ${idempotency_key})
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "plant_locations", record_id: location.id, after: location });
      return location;
    });

    return jsonResponse({ created: true, location }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
