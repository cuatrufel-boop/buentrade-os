// sent_offers.markWon — the moment a quote becomes a real deal. One transaction: assigns the next
// order number (BT-0001…), flips the offer to 'won', and creates the purchase_order + sales_order,
// a freight_order for the US leg (when a US freight rate was part of the offer), a SECOND
// freight_order for the Mexican leg (when a Mexican destination rate was part of the offer — both
// legs, matching production's full markWon(), not just the US-only leg trading-tool.html used to
// do on its own), and order_extra_costs rows for tramite aduanal / bodega americana when either
// was actually charged. Every write happens together or none do — a "won" offer with missing
// downstream orders/costs, or an order with no offer behind it, would both be real data corruption.
// Re-calling this on an already-won offer is rejected below (not_pending, 409) rather than
// re-running the cascade — that 409 is this endpoint's idempotency guard, not a separate key.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "sent_offer_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const {
      actor, sent_offer_id, override_credit_check = false,
      // Optional last-minute overrides — the Trading Tool's own negotiation/calculator panel can
      // have edited these live without saving them via sent_offers.negotiate first; winning has to
      // snapshot whatever's actually on screen at that moment, not the last-saved values.
      purchase_price = null, sale_per_lb = null, total_cost = null, total_sale = null,
      weight = null, us_freight_amount = null,
    } = body;

    const [offer] = await sql`select * from sent_offers where id = ${sent_offer_id}`;
    if (!offer) return jsonResponse({ error: "unknown sent_offer_id" }, 404);
    if (offer.status !== "sent") {
      return jsonResponse({ error: "not_pending", message: `This offer is already '${offer.status}', not 'sent' — can't mark it won again.`, current_status: offer.status }, 409);
    }

    const finalPurchasePrice = purchase_price ?? offer.purchase_price;
    const finalSalePerLb = sale_per_lb ?? offer.sale_per_lb;
    const finalTotalCost = total_cost ?? offer.total_cost;
    const finalTotalSale = total_sale ?? offer.total_sale;
    const finalWeight = weight ?? offer.weight;
    const finalUsFreightAmount = us_freight_amount ?? offer.us_freight_amount;

    // Credit-limit check — "si productos neza es hasta 100.000 usd no me puedo pasar de ese monto
    // hasta que pague." Never a block (same rule as everything else): the outstanding balance
    // (delivered-or-not, unpaid shipments) plus this new sale is compared against the customer's
    // credit_limit, and if it would exceed it, this returns a real number to confirm against
    // instead of refusing outright — override_credit_check proceeds anyway, same shape as every
    // other duplicate/limit check in this API. Uses the FINAL (possibly overridden) sale amount.
    if (offer.customer_id && finalTotalSale != null && !override_credit_check) {
      const [customer] = await sql`select credit_limit from customers where id = ${offer.customer_id}`;
      if (customer?.credit_limit != null) {
        const [{ outstanding }] = await sql`
          select coalesce(sum(sale_amount), 0) as outstanding from shipments
          where customer_id = ${offer.customer_id} and paid_at is null
        `;
        const projected = Number(outstanding) + Number(finalTotalSale);
        if (projected > Number(customer.credit_limit)) {
          return jsonResponse({
            error: "credit_limit_exceeded",
            message: `This customer's outstanding balance ($${Number(outstanding).toLocaleString()}) plus this order ($${Number(finalTotalSale).toLocaleString()}) would exceed their credit limit ($${Number(customer.credit_limit).toLocaleString()}). Confirm to proceed anyway or wait for payment to free up credit.`,
            outstanding_balance: outstanding,
            order_amount: finalTotalSale,
            credit_limit: customer.credit_limit,
            projected_total: projected,
          }, 409);
        }
      }
    }

    const result = await sql.begin(async (tx) => {
      const [{ next_order_number: orderNumber }] = await tx`select next_order_number()`;

      const [updatedOffer] = await tx`
        update sent_offers set
          status = 'won', order_number = ${orderNumber}, won_at = now(), won_by = ${actor},
          purchase_price = ${finalPurchasePrice}, sale_per_lb = ${finalSalePerLb},
          total_cost = ${finalTotalCost}, total_sale = ${finalTotalSale},
          weight = ${finalWeight}, us_freight_amount = ${finalUsFreightAmount}
        where id = ${sent_offer_id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "sent_offers", record_id: sent_offer_id, before: offer, after: updatedOffer });

      const [purchaseOrder] = await tx`
        insert into purchase_orders (order_number, sent_offer_id, plant_id, plant_name, product_id, product_name, product_spec, purchase_price, weight, total_cost, docs_on, delivery_dates, status)
        values (${orderNumber}, ${sent_offer_id}, ${offer.plant_id}, ${offer.plant_name}, ${offer.product_id}, ${offer.product_name}, ${offer.product_spec}, ${finalPurchasePrice}, ${finalWeight}, ${finalTotalCost}, ${offer.docs_on}, ${tx.json(offer.delivery_dates)}, 'open')
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "purchase_orders", record_id: purchaseOrder.id, after: purchaseOrder });

      const [salesOrder] = await tx`
        insert into sales_orders (order_number, sent_offer_id, customer_id, customer_name, product_id, product_name, product_spec, product_name_es, product_spec_es, sale_price, weight, total_sale, delivery_dates, status)
        values (${orderNumber}, ${sent_offer_id}, ${offer.customer_id}, ${offer.customer_name}, ${offer.product_id}, ${offer.product_name}, ${offer.product_spec}, ${offer.product_name_es}, ${offer.product_spec_es}, ${finalSalePerLb}, ${finalWeight}, ${finalTotalSale}, ${tx.json(offer.delivery_dates)}, 'open')
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "sales_orders", record_id: salesOrder.id, after: salesOrder });

      let freightOrder = null;
      if (offer.us_freight_rate_id) {
        const [rate] = await tx`select * from provider_rates where id = ${offer.us_freight_rate_id}`;
        if (rate) {
          // quoted_rate is what was actually quoted for THIS deal (finalUsFreightAmount — may
          // have been negotiated away from the catalog's base rate.rate), not the generic lane
          // rate; actual_rate (filled in later via Real Costs) is what the carrier really charges.
          const [fo] = await tx`
            insert into freight_orders (order_number, sent_offer_id, carrier_provider_id, origin, destination, quoted_rate, currency, currency_id, status)
            values (${orderNumber}, ${sent_offer_id}, ${rate.provider_id}, ${rate.origin}, ${rate.destination}, ${finalUsFreightAmount ?? rate.rate}, ${rate.currency}, ${rate.currency_id}, 'open')
            returning *
          `;
          freightOrder = fo;
          await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "freight_orders", record_id: fo.id, after: fo });
        }
      }

      // The Mexican leg (border → destino) — a second, separate freight_orders row on the same
      // order_number. Production's markWon() always carried both legs; this used to be the one
      // place trading-tool.html's own local implementation quietly diverged from it by only ever
      // handling the US leg.
      let mexicanFreightOrder = null;
      if (offer.mexican_dest_rate_id) {
        const [mxRate] = await tx`select * from provider_rates where id = ${offer.mexican_dest_rate_id}`;
        if (mxRate) {
          const [mfo] = await tx`
            insert into freight_orders (order_number, sent_offer_id, carrier_provider_id, origin, destination, quoted_rate, currency, currency_id, status)
            values (${orderNumber}, ${sent_offer_id}, ${mxRate.provider_id}, ${mxRate.origin}, ${mxRate.destination}, ${offer.mexican_freight_mxn ?? mxRate.rate}, ${mxRate.currency}, ${mxRate.currency_id}, 'open')
            returning *
          `;
          mexicanFreightOrder = mfo;
          await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "freight_orders", record_id: mfo.id, after: mfo });
        }
      }

      // Customs costs actually charged on this offer — carried forward into order_extra_costs so
      // Real Costs (trading-tool.html) shows them from the moment the order is won, not only once
      // someone remembers to add them by hand afterward.
      const agencyName = offer.customs_agency_provider_id
        ? (await tx`select name from providers where id = ${offer.customs_agency_provider_id}`)[0]?.name
        : null;
      const extraCosts = [];
      if (offer.tramite_aduanal_amount > 0) {
        const [c] = await tx`
          insert into order_extra_costs (order_number, sent_offer_id, cost_type, amount, notes)
          values (${orderNumber}, ${sent_offer_id}, 'tramite_aduanal', ${offer.tramite_aduanal_amount}, ${agencyName ? `Customs agency: ${agencyName}` : null})
          returning *
        `;
        extraCosts.push(c);
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "order_extra_costs", record_id: c.id, after: c });
      }
      if (offer.bodega_americana_amount > 0) {
        const [c] = await tx`
          insert into order_extra_costs (order_number, sent_offer_id, cost_type, amount, notes)
          values (${orderNumber}, ${sent_offer_id}, 'bodega_americana', ${offer.bodega_americana_amount}, ${agencyName ? `Customs agency: ${agencyName}` : null})
          returning *
        `;
        extraCosts.push(c);
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "order_extra_costs", record_id: c.id, after: c });
      }

      // Tracking starts the moment the load exists — production kept load-status fields directly
      // on the same order row, so a won order was always trackable with no separate step. Staging
      // splits tracking into its own table, so that same "always trackable from the moment it's
      // won" behavior has to be recreated here: one shipments row per won order, carrier defaulted
      // to whichever leg actually picks up from the plant (the US leg).
      const [shipment] = await tx`
        insert into shipments (order_number, sent_offer_id, customer_id, sale_amount, carrier_provider_id)
        values (${orderNumber}, ${sent_offer_id}, ${offer.customer_id}, ${finalTotalSale}, ${freightOrder ? freightOrder.carrier_provider_id : null})
        returning *
      `;
      await tx`insert into shipment_events (shipment_id, event_type) values (${shipment.id}, 'scheduled')`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "shipments", record_id: shipment.id, after: shipment });

      return { offer: updatedOffer, purchaseOrder, salesOrder, freightOrder, mexicanFreightOrder, extraCosts, shipment };
    });

    return jsonResponse({
      won: true,
      order_number: result.offer.order_number,
      offer: result.offer,
      purchase_order: result.purchaseOrder,
      sales_order: result.salesOrder,
      freight_order: result.freightOrder,
      mexican_freight_order: result.mexicanFreightOrder,
      extra_costs: result.extraCosts,
      shipment: result.shipment,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
