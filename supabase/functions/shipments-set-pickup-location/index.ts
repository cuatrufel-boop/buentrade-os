// shipments.setPickupLocation — records the trader's manual pickup-location pick for an order whose
// price never named a real ship-from city (see plant_locations.region / the 2026-09-12 Smithfield
// ask). Only ever called at Confirm Load, the "decidir al final" moment — never earlier, and never
// for an order that already resolves a location automatically from its own freight rate (see the
// pickup_location subquery in shipments-search). Mirrors shipments-set-release-number's shape
// exactly (simple update-and-audit-log, no insert, so exempt from the idempotency-key rule).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "order_number", "pickup_location_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, order_number, pickup_location_id } = body;

    const [existing] = await sql`select * from shipments where order_number = ${order_number}`;
    if (!existing) return jsonResponse({ error: "unknown order_number" }, 404);

    const [location] = await sql`select id from plant_locations where id = ${pickup_location_id}`;
    if (!location) return jsonResponse({ error: "unknown pickup_location_id" }, 400);

    const shipment = await sql.begin(async (tx) => {
      const [updated] = await tx`update shipments set pickup_location_id = ${pickup_location_id} where order_number = ${order_number} returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: existing.id, before: existing, after: updated });
      return updated;
    });

    return jsonResponse({ updated: true, shipment });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
