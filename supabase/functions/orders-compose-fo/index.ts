// orders.composeFO — read-only. Freight Confirmation (English, carrier-facing). A won order can
// have more than one freight_orders row (US leg + Mexican leg) — this returns one composed
// document per row for the order_number, matching production's one-PDF-per-leg behavior.
//
// The US leg (the one that collects at the plant) is composed from the same records as the Purchase Order, so the two never disagree:
//  - pick-up = the plant FACILITY with its street address and its own phone(s) (resolvePickup — when the quote did not carry it, or the street
//    address is not on file, nothing is guessed: 409 pickup_location_required and the screens ask the trader);
//  - delivery = the customs agency assigned to the customer (else the offer's) with its street address and phone;
//  - PU DATE = the order's confirmed pick-up date (purchase_orders.delivery_dates[0], the one the PO and the Status tab use — editing the date
//    updates it there), DELIVERY DATE = that date + 2 days at the border, a weekend rolling to Monday;
//  - TEMPERATURE SETTING = the product's own setpoint ("-10°F (Frozen)"); RELEASE # = the release number once the plant gave it, TBD before.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";
import { clean, pickupText, resolvePickup } from "../_shared/poDocument.ts";
import { loadPickupInput, pickupRefusal } from "../_shared/pickup.ts";
import { agencyBlock, agencyText, borderArrivalDate, facilityBlock, facilityPhones, temperatureSetting } from "../_shared/foDocument.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    if (!body.order_number) return jsonResponse({ error: "order_number is required" }, 400);
    const { order_number } = body;

    const freightOrders = await sql`select * from freight_orders where order_number = ${order_number}`;
    if (!freightOrders.length) return jsonResponse({ error: "no freight_orders for this order_number" }, 404);

    // The US leg is the one that collects at the plant (the Mexican leg starts at the border).
    const isUsLeg = (fo: any) => !["border", ""].includes(String(fo.origin ?? "").trim().toLowerCase());
    const [po] = await sql`select delivery_dates from purchase_orders where order_number = ${order_number}`;
    const [shipment] = await sql`select release_number from shipments where order_number = ${order_number}`;
    const puDate: string | null = Array.isArray(po?.delivery_dates) && po.delivery_dates[0] ? String(po.delivery_dates[0]) : null;

    let usLeg: { facility: any; phones: string | null; plantName: string; agency: any } | null = null;
    const firstUs = freightOrders.find(isUsLeg);
    if (firstUs?.sent_offer_id) {
      const [legOffer] = await sql`select o.plant_id, o.product_id, o.us_freight_rate_id, o.customer_id, o.customs_agency_provider_id, p.name as plant_name from sent_offers o join plants p on p.id = o.plant_id where o.id = ${firstUs.sent_offer_id}`;
      if (legOffer) {
        const input = await loadPickupInput(sql, { plantId: legOffer.plant_id, productId: legOffer.product_id, orderNumber: order_number, rateId: legOffer.us_freight_rate_id });
        const pickup = resolvePickup(input);
        const refusal = pickupRefusal(legOffer.plant_id, clean(legOffer.plant_name), pickup, order_number);
        if (refusal) return jsonResponse(refusal, 409);
        if (pickup.kind === "ready") {
          const [agency] = await sql`select a.* from providers a where a.id = coalesce((select customs_agency_provider_id from customers where id = ${legOffer.customer_id}), ${legOffer.customs_agency_provider_id})`;
          usLeg = { facility: pickup.facility, phones: facilityPhones(input.facilities as any[], pickup.facility as any), plantName: legOffer.plant_name, agency: agency ?? null };
        }
      }
    }

    const documents = [];
    for (const fo0 of freightOrders) {
      const us = !!usLeg && isUsLeg(fo0);
      const [offer] = fo0.sent_offer_id ? await sql`select * from sent_offers where id = ${fo0.sent_offer_id}` : [null];
      const [carrier] = fo0.carrier_provider_id ? await sql`select * from providers where id = ${fo0.carrier_provider_id}` : [null];
      const [prodTemp] = offer?.product_id ? await sql`select t.name_en as temperature, t.po_setpoint_f from products p join temperature t on t.id = p.temperature_id where p.id = ${offer.product_id}` : [];

      // "Border" is a placeholder meaning the carrier's own real crossing facility, not a literal
      // destination — resolved to the carrier's own city/state/country when the raw value says so.
      const resolveBorder = (v: string | null) =>
        v && v.toLowerCase() === "border" && carrier ? `${carrier.name} crossing facility, ${[carrier.city, carrier.country].filter(Boolean).join(", ")}` : v;

      // What the carrier reads, per leg. The US leg: the facility and the customs agency as blocks; any other leg keeps its own origin / destination text.
      const agency = us ? usLeg!.agency : null;
      const hasAgency = !!agency; // an agency with no street address on file still names where the load goes (name + city); the PO is the one that insists on the address
      const origin = us ? pickupText({ name: usLeg!.plantName }, usLeg!.facility) : fo0.origin;
      const destination = hasAgency ? agencyText(agency) : fo0.destination;
      const fo = { ...fo0, origin, destination };

      const doc = {
        order_number,
        freight_order_id: fo.id,
        is_us_leg: us,
        carrier: carrier ? { name: carrier.name, contact_name: carrier.contact_name, city: carrier.city, country: carrier.country, phone: carrier.phone, mc_number: carrier.mc_number, dot_number: carrier.dot_number } : null,
        client_broker: "BuenTrade LLC",
        pick_up_address: resolveBorder(origin),
        delivery_address: hasAgency ? destination : resolveBorder(destination),
        pick_up_lines: us ? facilityBlock(usLeg!.plantName, usLeg!.facility) : [resolveBorder(origin)].filter(Boolean),
        pick_up_phone: us ? usLeg!.phones : null,
        delivery_lines: hasAgency ? agencyBlock(agency) : [resolveBorder(destination)].filter(Boolean),
        delivery_phone: hasAgency ? clean(agency.phone) || null : null,
        pick_up_date: puDate,
        delivery_date: us ? borderArrivalDate(puDate) : null,
        release_number: clean(shipment?.release_number) || null,
        temperature_setting: temperatureSetting(prodTemp?.temperature, prodTemp?.po_setpoint_f),
        // Real ask 2026-09-14: "producto no esta completo debe ir FULL en cualquier orden" — this
        // showed only the short cut name (e.g. "Bellies #2"), never the full descriptive spec
        // (e.g. "Pork Skinless Bellies #2 Frozen, Box") that PO/SO already print. Same
        // spec-falls-back-to-name convention as orders-compose-po/so.
        product_name: offer?.product_spec || offer?.product_name || null,
        weight: offer?.weight || null,
        delivery_dates: Array.isArray(po?.delivery_dates) ? po.delivery_dates : (offer?.delivery_dates || null),
        rate: fo.actual_rate ?? fo.quoted_rate,
        customs_broker: agency ? agency.name : null,
      };

      const text = [
        `FREIGHT CONFIRMATION ${order_number}`,
        carrier ? `Vendor: ${carrier.name}${carrier.contact_name ? ` — ${carrier.contact_name}` : ""}${carrier.phone ? ` — ${carrier.phone}` : ""}` : null,
        `Client: ${doc.client_broker}`,
        ``,
        `Pick-up: ${doc.pick_up_address || "TBD"}${doc.pick_up_phone ? ` — T: ${doc.pick_up_phone}` : ""}`,
        `Delivery: ${doc.delivery_address || "TBD"}${doc.delivery_phone ? ` — T: ${doc.delivery_phone}` : ""}`,
        doc.pick_up_date ? `PU date: ${doc.pick_up_date}` : null,
        doc.delivery_date ? `Delivery date: ${doc.delivery_date}` : null,
        doc.temperature_setting ? `Temperature setting: ${doc.temperature_setting}` : null,
        doc.weight ? `Weight: ${doc.weight} lbs` : null,
        `Release #: ${doc.release_number || "TBD"}`,
        `Rate: $${doc.rate}`,
      ].filter((l) => l !== null).join("\n");

      // Raw fo/carrier rows alongside the composed document — offers.html's WhatsApp-card flow
      // needs the actual fo/carrier fields, not just the rendered text.
      documents.push({ document: doc, text, fo, carrier });
    }

    return jsonResponse({ documents });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
