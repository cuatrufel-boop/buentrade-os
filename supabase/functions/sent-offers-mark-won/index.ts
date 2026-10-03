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
import { computeCustomerExposure, jsonResponse, writeAuditLog } from "../_shared/matching.ts";
import { clean, addressProblem, pickupText, resolvePickup } from "../_shared/poDocument.ts";
import { loadPickupInput, pickupRefusal } from "../_shared/pickup.ts";
import { applyPickupChoice, checkPickupChoice } from "../_shared/pickupWrite.ts";

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
      weight = null, us_freight_amount = null, won_idempotency_key = null,
      // Real correction 2026-09-14: "cuando escoges el precio de flete y el nombre del carrier
      // ese debe salir para crear la FO" — the trader already picks a real carrier + rate together
      // in one place, the freight rate dropdown (trading-tool.html's ttPickFreightRate, which shows
      // provider_name right next to each price) — the fix isn't a second, separate carrier picker,
      // it's making sure THAT selection actually reaches this endpoint. Same "last-minute snapshot"
      // reasoning as purchase_price/sale_per_lb above: the trader's live pick may never have been
      // saved via sent_offers.negotiate before Create Order was clicked, so this overrides
      // offer.us_freight_rate_id when passed instead of trusting a possibly-stale DB value.
      us_freight_rate_id_override = null,
      // Fallback only for when the dropdown resolved no real rate at all (a manual amount, or a
      // known city with no carrier rate on file yet) — trading-tool.html's required carrier-confirm
      // step only asks for this in that specific case, never when a real rate was already picked.
      carrier_provider_id = null,
      // Real ask 2026-09-14: "esa fecha no la puedo dejar al sistema... muy delicado" — the PU/
      // delivery date used to just be whatever sat on the offer from whenever it was quoted/priced,
      // copied straight into the PO/SO with nobody re-confirming it's still real. Required (not
      // defaulted to offer.delivery_dates) so no caller can silently skip asking — both real UI
      // entry points (trading-tool.html's Create Order, offers.html's quick "Ganada") now always
      // ask the trader first and always pass this.
      confirmed_delivery_date = null,
      // Real ask 2026-09-21: "el sistema nos pregunta como la queremos comprar si directa o por
      // factoring" — trading-tool.html's Create Order flow asks this right before calling here.
      // Defaults to 'direct' so offers.html's own quick "Ganada" button (same endpoint, no
      // negotiation panel / Summar numbers to choose from) keeps working unchanged.
      financing_method = "direct",
      // Real ask 2026-09-21: the future "Pay via Summar" QT breakdown re-shows the same Summar fee
      // estimate the trader saw here — snapshotting whatever Payment Days was on screen (trading-
      // tool.html's quickbar, no default assumed here) so that later screen never recomputes it
      // with a different number. Explicitly an estimate, never the real fee — the actual days
      // until the customer pays (and so the real Summar cost) is only known once they actually do.
      payment_days = null,
      // Real ask 2026-10-03: "el pu location viene desde el principio de quotes y desde el pricing... y si no viene preguntar antes de generar ordenes".
      // A FOB order is never created without the plant facility (and its street address) the truck collects from: it comes from the quote (freight
      // rate origin / the price's location); when it is not there the call is refused (pickup_location_required) and the screen asks the trader, who
      // sends the answer back as `pickup` ({pickup_location_id | new_location_name, address}). A delivered order (the plant delivers at the border)
      // is never created without the customs agency and its street address: refused (customs_agency_required) until `customs`
      // ({customs_agency_provider_id, address}) says it. dry_run runs these checks and writes nothing.
      pickup = null, customs = null, dry_run = false,
    } = body;

    if (!["direct", "summar"].includes(financing_method)) {
      return jsonResponse({ error: "invalid financing_method", valid_values: ["direct", "summar"] }, 400);
    }

    const [offer] = await sql`select * from sent_offers where id = ${sent_offer_id}`;
    if (!offer) return jsonResponse({ error: "unknown sent_offer_id" }, 404);

    // Closes the narrow race the status check below can't: two requests arriving close enough
    // together could both read status === 'sent' before either commits. A replay of the exact
    // same won-click (same key) returns the order that already exists instead of running the
    // whole PO/SO/freight/shipment cascade a second time.
    if (won_idempotency_key && offer.won_idempotency_key === won_idempotency_key) {
      const [purchaseOrder] = await sql`select * from purchase_orders where sent_offer_id = ${sent_offer_id}`;
      const [salesOrder] = await sql`select * from sales_orders where sent_offer_id = ${sent_offer_id}`;
      const [shipment] = await sql`select * from shipments where sent_offer_id = ${sent_offer_id}`;
      return jsonResponse({
        won: true, idempotent_replay: true, order_number: offer.order_number, offer,
        purchase_order: purchaseOrder ?? null, sales_order: salesOrder ?? null, shipment: shipment ?? null,
      });
    }

    if (offer.status !== "sent") {
      return jsonResponse({ error: "not_pending", message: `This offer is already '${offer.status}', not 'sent' — can't mark it won again.`, current_status: offer.status }, 409);
    }

    // Real ask 2026-09-14: "esa fecha no la puedo dejar al sistema... muy delicado" — enforced here,
    // not just trusted from the UI, so no future call site can silently skip asking.
    if (!confirmed_delivery_date) {
      return jsonResponse({ error: "missing required fields", missing: ["confirmed_delivery_date"], message: "The real, final PU/delivery date must be confirmed before an order can be created." }, 400);
    }
    const finalDeliveryDates = [confirmed_delivery_date];

    const finalPurchasePrice = purchase_price ?? offer.purchase_price;
    const finalSalePerLb = sale_per_lb ?? offer.sale_per_lb;
    const finalTotalCost = total_cost ?? offer.total_cost;
    const finalTotalSale = total_sale ?? offer.total_sale;
    const finalWeight = weight ?? offer.weight;
    const finalUsFreightAmount = us_freight_amount ?? offer.us_freight_amount;

    // Pickup (FOB) / customs agency (delivered) — decided BEFORE anything is created, never guessed, never printed from the plant's offices.
    const isFob = Number(finalUsFreightAmount) > 0;
    const [plantRow] = await sql`select name from plants where id = ${offer.plant_id}`;
    const plantName = clean(plantRow?.name || offer.plant_name);
    let pickupFacility: any = null;
    let pickupToApply: any = null;
    let customsAgencyId: string | null = null;
    let customsAddressToSave: string | null = null;
    if (isFob) {
      const resolution = resolvePickup(await loadPickupInput(sql, { plantId: offer.plant_id, productId: offer.product_id, orderNumber: null, rateId: us_freight_rate_id_override || offer.us_freight_rate_id }));
      if (resolution.kind === "ready") pickupFacility = resolution.facility;
      else {
        if (pickup && (pickup.pickup_location_id || pickup.new_location_name)) pickupToApply = pickup;
        else if (resolution.kind === "needs_address" && clean(pickup?.address)) pickupToApply = { pickup_location_id: resolution.facility.id, address: pickup.address };
        else return jsonResponse(pickupRefusal(offer.plant_id, plantName, resolution, null), 409);
        // Validated here, before the order number is taken (the numbering is consecutive and never skips).
        const bad = await checkPickupChoice(sql, offer.plant_id, pickupToApply);
        if (bad) return jsonResponse(bad, 400);
      }
    } else {
      const agencyId = customs?.customs_agency_provider_id || offer.customs_agency_provider_id
        || (offer.customer_id ? (await sql`select customs_agency_provider_id from customers where id = ${offer.customer_id}`)[0]?.customs_agency_provider_id : null);
      const [agency] = agencyId ? await sql`select id, name, address from providers where id = ${agencyId}` : [];
      const typed = clean(customs?.address);
      if (typed && addressProblem(typed)) return jsonResponse({ error: "invalid_address", message: addressProblem(typed) }, 400);
      if (!agency) {
        const options = await sql`select distinct p.id, p.name, p.address from providers p join provider_roles pr on pr.provider_id = p.id where pr.role = 'customs_broker' order by p.name`;
        return jsonResponse({ error: "customs_agency_required", need: "agency", message: "This order is delivered by the plant at the border: choose the customs agency it is delivered to.", options, agency: null }, 409);
      }
      if (!clean(agency.address) && !typed) {
        return jsonResponse({ error: "customs_agency_required", need: "address", message: `The street address of the customs agency ${clean(agency.name)} is not on file yet: type it, so the Purchase Order says where the load is delivered.`, options: [], agency: { id: agency.id, name: clean(agency.name) } }, 409);
      }
      customsAgencyId = agency.id;
      customsAddressToSave = clean(agency.address) ? null : typed;
    }
    if (dry_run) {
      return jsonResponse({ dry_run: true, would_create: true, pickup: isFob ? (pickupFacility ? { facility: pickupFacility } : { to_apply: pickupToApply }) : null, customs_agency_id: customsAgencyId });
    }

    // Credit-limit check — "si productos neza es hasta 100.000 usd no me puedo pasar de ese monto
    // hasta que pague." Never a block (same rule as everything else): the outstanding balance
    // (delivered-or-not, unpaid shipments) plus this new sale is compared against the customer's
    // credit_limit, and if it would exceed it, this returns a real number to confirm against
    // instead of refusing outright — override_credit_check proceeds anyway, same shape as every
    // other duplicate/limit check in this API. Uses the FINAL (possibly overridden) sale amount.
    if (offer.customer_id && finalTotalSale != null && !override_credit_check) {
      const exposure = await computeCustomerExposure(sql, offer.customer_id, confirmed_delivery_date);
      if (exposure) {
        const projected = exposure.outstanding + Number(finalTotalSale);
        if (projected > exposure.creditLimit) {
          return jsonResponse({
            error: "credit_limit_exceeded",
            message: `This customer's outstanding balance ($${exposure.outstanding.toLocaleString()}) plus this order ($${Number(finalTotalSale).toLocaleString()}) would exceed their credit limit ($${exposure.creditLimit.toLocaleString()}). Confirm to proceed anyway or wait for payment to free up credit.`,
            outstanding_balance: exposure.outstanding,
            order_amount: finalTotalSale,
            credit_limit: exposure.creditLimit,
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
          weight = ${finalWeight}, us_freight_amount = ${finalUsFreightAmount},
          delivery_dates = ${tx.json(finalDeliveryDates)},
          won_idempotency_key = ${won_idempotency_key}
        where id = ${sent_offer_id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "sent_offers", record_id: sent_offer_id, before: offer, after: updatedOffer });

      // The pickup facility / customs agency answered by the trader is stored first (on the plant's facility, on the offer, on the agency), so the
      // order is born with them fixed — "cuando creo orden ya numeros y involucrados deben quedar fijados".
      if (isFob && !pickupFacility) {
        const applied = await applyPickupChoice(tx, HMAC_SECRET, actor, offer.plant_id, pickupToApply);
        if ("error" in applied) throw Object.assign(new Error(applied.message), { refusal: { error: applied.error, message: applied.message } });
        pickupFacility = applied.facility;
      }
      if (!isFob && customsAgencyId) {
        if (customsAgencyId !== offer.customs_agency_provider_id) {
          const [offerWithAgency] = await tx`update sent_offers set customs_agency_provider_id = ${customsAgencyId} where id = ${sent_offer_id} returning *`;
          await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "sent_offers", record_id: sent_offer_id, before: updatedOffer, after: offerWithAgency });
        }
        if (customsAddressToSave) {
          const [agencyAfter] = await tx`update providers set address = ${customsAddressToSave}, updated_at = now() where id = ${customsAgencyId} returning *`;
          await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "providers", record_id: customsAgencyId, before: { address: null }, after: { address: agencyAfter.address } });
        }
      }

      const [purchaseOrder] = await tx`
        insert into purchase_orders (order_number, sent_offer_id, plant_id, plant_name, product_id, product_name, product_spec, purchase_price, weight, total_cost, docs_on, delivery_dates, status, financing_method, payment_days)
        values (${orderNumber}, ${sent_offer_id}, ${offer.plant_id}, ${offer.plant_name}, ${offer.product_id}, ${offer.product_name}, ${offer.product_spec}, ${finalPurchasePrice}, ${finalWeight}, ${finalTotalCost}, ${offer.docs_on}, ${tx.json(finalDeliveryDates)}, 'open', ${financing_method}, ${payment_days})
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "purchase_orders", record_id: purchaseOrder.id, after: purchaseOrder });

      const [salesOrder] = await tx`
        insert into sales_orders (order_number, sent_offer_id, customer_id, customer_name, product_id, product_name, product_spec, product_name_es, product_spec_es, sale_price, weight, total_sale, delivery_dates, status)
        values (${orderNumber}, ${sent_offer_id}, ${offer.customer_id}, ${offer.customer_name}, ${offer.product_id}, ${offer.product_name}, ${offer.product_spec}, ${offer.product_name_es}, ${offer.product_spec_es}, ${finalSalePerLb}, ${finalWeight}, ${finalTotalSale}, ${tx.json(finalDeliveryDates)}, 'open')
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "sales_orders", record_id: salesOrder.id, after: salesOrder });

      // Real correction 2026-09-06: "claro que debe crear el FO por que en ese momento es donde
      // pongo tambien el costo real" — the freight_orders row must ALWAYS exist whenever there's a
      // real US freight leg (FOB), whether that amount came from a matched catalog rate or was
      // typed directly into the calculator's freight box (the no-known-city AVERAGE fallback,
      // quotes.html rqAverageUsFreightRate — us_freight_rate_id is null for it, same as "Del
      // Border"). Previously the manual-amount case created no row at all, so the FO silently
      // never sent and Real Costs had nothing to attach a carrier to later (it can only update an
      // existing row, never create one).
      // Real correction 2026-09-14: "cuando creo orden ya numeros y involucrados deben quedar
      // fijados para continuar" — carrier_provider_id used to always start null whenever no
      // specific provider_rates row was behind the quote (a manual/average freight amount), left
      // for Real Costs to maybe fill in later, with nothing forcing that. trading-tool.html's
      // Create Order now requires the trader to confirm a real carrier up front whenever the deal
      // is FOB and passes it as carrier_provider_id — that explicit choice wins over whatever the
      // matched rate's own provider would have been, since the trader looked at it last.
      let freightOrder = null;
      if (finalUsFreightAmount > 0) {
        let provider_id: string | null = carrier_provider_id, origin: string | null = offer.plant_name, destination = "Border";
        let currency = "USD", currency_id: string | null = null;
        const effectiveRateId = us_freight_rate_id_override || offer.us_freight_rate_id;
        if (effectiveRateId) {
          const [rate] = await tx`select * from provider_rates where id = ${effectiveRateId}`;
          if (rate) {
            provider_id = carrier_provider_id || rate.provider_id;
            origin = rate.origin;
            destination = rate.destination;
            currency = rate.currency;
            currency_id = rate.currency_id;
          }
        }
        // quoted_rate is what was actually quoted for THIS deal (finalUsFreightAmount — may have
        // been negotiated away from the catalog's base rate.rate), not the generic lane rate;
        // actual_rate (filled in later via Real Costs) is what the carrier really charges.
        // The carrier is told to collect at the plant facility with its street address (never the plant's name alone or its offices).
        if (pickupFacility) origin = pickupText({ name: plantName }, pickupFacility);
        const [fo] = await tx`
          insert into freight_orders (order_number, sent_offer_id, carrier_provider_id, origin, destination, quoted_rate, currency, currency_id, status)
          values (${orderNumber}, ${sent_offer_id}, ${provider_id}, ${origin}, ${destination}, ${finalUsFreightAmount}, ${currency}, ${currency_id}, 'open')
          returning *
        `;
        freightOrder = fo;
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "freight_orders", record_id: fo.id, after: fo });
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
        insert into shipments (order_number, sent_offer_id, customer_id, sale_amount, carrier_provider_id, pickup_location_id)
        values (${orderNumber}, ${sent_offer_id}, ${offer.customer_id}, ${finalTotalSale}, ${freightOrder ? freightOrder.carrier_provider_id : null}, ${pickupFacility ? pickupFacility.id : null})
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
    const refusal = (err as { refusal?: { error: string; message: string } }).refusal;
    if (refusal) return jsonResponse(refusal, 400);
    return jsonResponse({ error: String(err) }, 500);
  }
});
