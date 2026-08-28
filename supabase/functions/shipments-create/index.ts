// shipments.create — a won offer becomes a load to actually track. Pulls customer_id and the sale
// amount straight from the sales_order that markWon already created (same order_number), so the
// shipment never has to be told numbers that already exist elsewhere. payment_due_date is computed
// right here from the customer's own payment_days ("deben contar 30 días después de que se
// entrega para cobrar") — but only once delivered_at is actually known (see markDelivered in
// shipments.updateStatus), not at creation time when there's nothing to count 30 days from yet.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "sent_offer_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, sent_offer_id, carrier_provider_id = null, pickup_date = null, border_delivery_date = null, notes = null } = body;

    const [offer] = await sql`select * from sent_offers where id = ${sent_offer_id}`;
    if (!offer) return jsonResponse({ error: "unknown sent_offer_id" }, 404);
    if (offer.status !== "won" || !offer.order_number) {
      return jsonResponse({ error: "not_won", message: "This offer hasn't been marked won yet — nothing to ship." }, 409);
    }

    const [existing] = await sql`select * from shipments where sent_offer_id = ${sent_offer_id}`;
    if (existing) return jsonResponse({ already_exists: true, shipment: existing }, 200);

    const [salesOrder] = await sql`select * from sales_orders where sent_offer_id = ${sent_offer_id}`;

    const shipment = await sql.begin(async (tx) => {
      const [shipment] = await tx`
        insert into shipments (order_number, sent_offer_id, customer_id, sale_amount, carrier_provider_id, pickup_date, border_delivery_date, notes)
        values (${offer.order_number}, ${sent_offer_id}, ${offer.customer_id}, ${salesOrder?.total_sale ?? null}, ${carrier_provider_id}, ${pickup_date}, ${border_delivery_date}, ${notes})
        returning *
      `;
      await tx`
        insert into shipment_events (shipment_id, event_type, notes) values (${shipment.id}, 'scheduled', ${notes})
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "shipments", record_id: shipment.id, after: shipment });
      return shipment;
    });

    return jsonResponse({ created: true, shipment }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
