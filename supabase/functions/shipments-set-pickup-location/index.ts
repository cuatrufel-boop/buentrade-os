// shipments.setPickupLocation — records which facility of the plant a load is collected from, and its street address, for an order whose quote did
// not carry it (the freight rate had no origin, the plant's price named no location) or whose facility has no address on file yet. Called when a
// Purchase Order / Freight Order is composed for such an order (orders-compose-po / orders-compose-fo refuse and the screen asks the trader —
// 2026-10-03) and at Confirm Load; new orders already get it fixed when they are created (sent-offers-mark-won). The answer is one of:
//   pickup_location_id        an existing facility of this plant (+ address, saved on the facility, when it has none or it changed)
//   new_location_name+address a facility not registered yet ("City, ST" + street address) — created for the plant, so it is found next time
// It is stored on the shipment (the PO, the Freight Order, the Status tab and the release-number request all read it) and the US leg's pick-up text
// of the Freight Order follows. Simple update-and-audit-log (no new order row), so exempt from the idempotency-key rule.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";
import { applyPickupChoice, checkPickupChoice, setUsLegOrigin } from "../_shared/pickupWrite.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "order_number"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    if (!body.pickup_location_id && !body.new_location_name) return jsonResponse({ error: "missing required fields", missing: ["pickup_location_id or new_location_name"] }, 400);
    const { actor, order_number } = body;

    const [existing] = await sql`select * from shipments where order_number = ${order_number}`;
    if (!existing) return jsonResponse({ error: "unknown order_number" }, 404);
    // A load is only ever collected at a facility of the plant it was bought from.
    const [order] = await sql`select o.plant_id, p.name as plant_name from sent_offers o join plants p on p.id = o.plant_id where o.id = ${existing.sent_offer_id}`;
    if (!order) return jsonResponse({ error: "unknown plant for this order" }, 404);

    const bad = await checkPickupChoice(sql, order.plant_id, { pickup_location_id: body.pickup_location_id, new_location_name: body.new_location_name, address: body.address });
    if (bad) return jsonResponse(bad, 400);

    const outcome = await sql.begin(async (tx) => {
      const applied = await applyPickupChoice(tx, HMAC_SECRET, actor, order.plant_id, { pickup_location_id: body.pickup_location_id, new_location_name: body.new_location_name, address: body.address });
      if ("error" in applied) return applied;
      const [updated] = await tx`update shipments set pickup_location_id = ${applied.facility.id} where order_number = ${order_number} returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: existing.id, before: existing, after: updated });
      await setUsLegOrigin(tx, HMAC_SECRET, actor, order_number, { name: order.plant_name }, applied.facility);
      return { shipment: updated, facility: applied.facility };
    });
    if ("error" in outcome) return jsonResponse({ error: outcome.error, message: outcome.message }, 400);

    return jsonResponse({ updated: true, shipment: outcome.shipment, facility: outcome.facility });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
