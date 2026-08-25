// sent_offers.markWon — the moment a quote becomes a real deal. One transaction: assigns the next
// order number (BT-0001…), flips the offer to 'won', and creates the purchase_order + sales_order
// (and a freight_order, when a US freight rate was actually part of the offer) that carry that
// same order number forward. All four writes happen together or none do — a "won" offer with no
// resulting orders, or an order with no offer behind it, would both be real data corruption.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "sent_offer_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, sent_offer_id } = body;

    const [offer] = await sql`select * from sent_offers where id = ${sent_offer_id}`;
    if (!offer) return jsonResponse({ error: "unknown sent_offer_id" }, 404);
    if (offer.status !== "sent") {
      return jsonResponse({ error: "not_pending", message: `This offer is already '${offer.status}', not 'sent' — can't mark it won again.`, current_status: offer.status }, 409);
    }

    const result = await sql.begin(async (tx) => {
      const [{ next_order_number: orderNumber }] = await tx`select next_order_number()`;

      const [updatedOffer] = await tx`
        update sent_offers set status = 'won', order_number = ${orderNumber}, won_at = now(), won_by = ${actor}
        where id = ${sent_offer_id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "sent_offers", record_id: sent_offer_id, before: offer, after: updatedOffer });

      const [purchaseOrder] = await tx`
        insert into purchase_orders (order_number, sent_offer_id, plant_id, plant_name, product_id, product_name, product_spec, purchase_price, weight, total_cost, docs_on, delivery_dates, status)
        values (${orderNumber}, ${sent_offer_id}, ${offer.plant_id}, ${offer.plant_name}, ${offer.product_id}, ${offer.product_name}, ${offer.product_spec}, ${offer.purchase_price}, ${offer.weight}, ${offer.total_cost}, ${offer.docs_on}, ${tx.json(offer.delivery_dates)}, 'open')
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "purchase_orders", record_id: purchaseOrder.id, after: purchaseOrder });

      const [salesOrder] = await tx`
        insert into sales_orders (order_number, sent_offer_id, customer_id, customer_name, product_id, product_name, product_spec, product_name_es, product_spec_es, sale_price, weight, total_sale, delivery_dates, status)
        values (${orderNumber}, ${sent_offer_id}, ${offer.customer_id}, ${offer.customer_name}, ${offer.product_id}, ${offer.product_name}, ${offer.product_spec}, ${offer.product_name_es}, ${offer.product_spec_es}, ${offer.sale_per_lb}, ${offer.weight}, ${offer.total_sale}, ${tx.json(offer.delivery_dates)}, 'open')
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "sales_orders", record_id: salesOrder.id, after: salesOrder });

      let freightOrder = null;
      if (offer.us_freight_rate_id) {
        const [rate] = await tx`select * from provider_rates where id = ${offer.us_freight_rate_id}`;
        if (rate) {
          const [fo] = await tx`
            insert into freight_orders (order_number, sent_offer_id, carrier_provider_id, origin, destination, quoted_rate, currency_id, status)
            values (${orderNumber}, ${sent_offer_id}, ${rate.provider_id}, ${rate.origin}, ${rate.destination}, ${rate.rate}, ${rate.currency_id}, 'open')
            returning *
          `;
          freightOrder = fo;
          await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "freight_orders", record_id: fo.id, after: fo });
        }
      }

      return { offer: updatedOffer, purchaseOrder, salesOrder, freightOrder };
    });

    return jsonResponse({
      won: true,
      order_number: result.offer.order_number,
      offer: result.offer,
      purchase_order: result.purchaseOrder,
      sales_order: result.salesOrder,
      freight_order: result.freightOrder,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
