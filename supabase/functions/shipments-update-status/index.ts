// shipments.updateStatus — advances a load through scheduled → picked_up → in_transit →
// delivered. Every call logs a shipment_event (the tracking history), and can record that the
// customer was actually notified at this exact step — "en el transcurso del recorrido de la carga
// debemos notificar a los clientes cuando recoge, cuando va a llegar, y cuando la reciben," called
// out as the real differentiator. Reaching 'delivered' computes payment_due_date right here
// (delivered_at + customer.payment_days) — this is the first point that date can even be known.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const STATUS_ORDER = ["scheduled", "picked_up", "in_transit", "delivered"];
const EVENT_FOR_STATUS: Record<string, string> = {
  picked_up: "picked_up", in_transit: "in_transit_update", delivered: "delivered",
};
const VALID_CHANNELS = ["email", "whatsapp"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "shipment_id", "status"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const {
      actor, shipment_id, status, location = null, notes = null,
      customer_notified = false, notified_channel = null,
    } = body;

    if (!STATUS_ORDER.includes(status)) return jsonResponse({ error: "invalid status", valid_statuses: STATUS_ORDER }, 400);
    if (customer_notified && notified_channel && !VALID_CHANNELS.includes(notified_channel)) {
      return jsonResponse({ error: "invalid notified_channel", valid_channels: VALID_CHANNELS }, 400);
    }

    const [shipment] = await sql`select * from shipments where id = ${shipment_id}`;
    if (!shipment) return jsonResponse({ error: "unknown shipment_id" }, 404);

    const currentIdx = STATUS_ORDER.indexOf(shipment.status);
    const newIdx = STATUS_ORDER.indexOf(status);
    if (newIdx <= currentIdx) {
      return jsonResponse({ error: "not_forward", message: `Shipment is already '${shipment.status}' — can't move to '${status}'.`, current_status: shipment.status }, 409);
    }

    const result = await sql.begin(async (tx) => {
      let deliveredAt = shipment.delivered_at;
      let paymentDueDate = shipment.payment_due_date;
      let pickedUpAt = shipment.picked_up_at;

      if (status === "picked_up") pickedUpAt = new Date().toISOString();
      if (status === "delivered") {
        deliveredAt = new Date().toISOString();
        if (shipment.customer_id) {
          const [customer] = await tx`select payment_days from customers where id = ${shipment.customer_id}`;
          if (customer?.payment_days != null) {
            const due = new Date();
            due.setDate(due.getDate() + customer.payment_days);
            paymentDueDate = due.toISOString().slice(0, 10);
          }
        }
      }

      const [updatedShipment] = await tx`
        update shipments set status = ${status}, picked_up_at = ${pickedUpAt}, delivered_at = ${deliveredAt}, payment_due_date = ${paymentDueDate}, updated_at = now()
        where id = ${shipment_id} returning *
      `;

      const [event] = await tx`
        insert into shipment_events (shipment_id, event_type, location, notes, customer_notified, customer_notified_at, notified_channel)
        values (${shipment_id}, ${EVENT_FOR_STATUS[status] || status}, ${location}, ${notes}, ${customer_notified}, ${customer_notified ? new Date().toISOString() : null}, ${customer_notified ? notified_channel : null})
        returning *
      `;

      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: shipment_id, before: shipment, after: updatedShipment });

      return { shipment: updatedShipment, event };
    });

    return jsonResponse({ updated: true, shipment: result.shipment, event: result.event });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
