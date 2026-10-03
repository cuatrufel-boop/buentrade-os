// orders.composePO — read-only. Composes the Purchase Order (English, plant-facing) as
// structured data + ready-to-send plain text. This is the business logic that used to live only
// in offers.html's buildPODoc() — moved here so every caller (the future frontend, a WhatsApp/
// email send, anything) gets the exact same document, computed once, not re-derived per screen.
//
// Incoterms rule (re-verified directly against offers.html's real buildPODoc() source, 2026-08-28
// — an earlier pass had this keyed off customs_agency_provider_id, which was wrong): FOB (a US
// freight rate is on the offer — BuenTrade booked the truck) -> "FCA – {plant location}", the
// plant IS the ship-from/pick-up point. Otherwise (the plant delivers on its own truck, no freight
// leg booked) -> "DAP – {agency location}", delivered to the customer's customs agency instead.
// Read off sent_offers.us_freight_rate_id, the actual field the original logic keys off of.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, traderDisplayName } from "../_shared/matching.ts";
import { agencyAddressLines, agencyIncoterm, clean, countryOfOrigin, fmtAmount, fmtDate, fmtUnitCost, fmtWeight, facilityIncoterm, facilityLines, plantAddressLines, plantIncoterm, poNotes, resolvePickup } from "../_shared/poDocument.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

function fmtAddress(name: string, address: string | null, city: string | null, state: string | null, country: string | null) {
  return [name, address, [city, state].filter(Boolean).join(", "), country].filter(Boolean).join("\n");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    if (!body.order_number) return jsonResponse({ error: "order_number is required" }, 400);
    const { order_number } = body;

    const [po] = await sql`select * from purchase_orders where order_number = ${order_number}`;
    if (!po) return jsonResponse({ error: "unknown order_number" }, 404);
    const [offer] = await sql`select * from sent_offers where id = ${po.sent_offer_id}`;
    const [plant] = await sql`select * from plants where id = ${po.plant_id}`;
    // Country and state are read from their own tables (the plants.country / plants.state text columns are empty for every plant).
    const [geo] = await sql`
      select c.name_en as country_name, c.iso2, s.name_en as state_name, s.code as state_code
      from plants p left join countries c on c.id = p.country_id left join states s on s.id = p.state_id where p.id = ${po.plant_id}`;

    // us_freight_amount, not us_freight_rate_id — a quote using the no-known-city AVERAGE fallback
    // (see quotes.html rqAverageUsFreightRate, 2026-08-30) still charges real freight, it just has
    // no single provider_rates row to point at, so us_freight_rate_id is null for it too. The
    // amount actually being > 0 is the real "was a freight leg charged" signal in both cases.
    const isFob = Number(offer?.us_freight_amount) > 0;
    const vendorBlock = plantAddressLines(plant || {}, geo || {}).join("\n");

    // PICK-UP LOCATION = the plant FACILITY where this load is collected (never the offices, which are the VENDOR block). Resolved from what the
    // system recorded (see resolvePickup); when it cannot be known the PO is not issued — the screens ask the trader which facility and save it
    // on the shipment, so the PO, the Status tab and the release-number request all agree.
    const facilities = await sql`
      select pl.id, pl.location_id, pl.location_name, pl.address, l.city, l.state
      from plant_locations pl left join locations l on l.id = pl.location_id
      where pl.plant_id = ${po.plant_id} order by pl.location_name, pl.created_at`;
    const [shipment] = await sql`select pickup_location_id from shipments where order_number = ${order_number}`;
    const [rate] = offer?.us_freight_rate_id ? await sql`select r.location_id, l.city, l.state from provider_rates r left join locations l on l.id = r.location_id where r.id = ${offer.us_freight_rate_id}` : [];
    const [productPlace] = await sql`select pp.location_id, l.city, l.state from plant_products pp left join locations l on l.id = pp.location_id where pp.plant_id = ${po.plant_id} and pp.product_id = ${po.product_id}`;
    const pickup = resolvePickup({
      facilities, manualId: shipment?.pickup_location_id ?? null,
      rateLocationId: rate?.location_id ?? null, rateLocation: rate ? { city: rate.city, state: rate.state } : null,
      productLocationId: productPlace?.location_id ?? null, productLocation: productPlace ? { city: productPlace.city, state: productPlace.state } : null,
    });

    let shipTo = "";
    let incoterms = "";
    if (isFob) {
      if (pickup.kind === "needs_pick") {
        return jsonResponse({
          error: "pickup_location_required",
          message: `The pickup location of this load is not recorded: choose which ${clean(plant?.name) || "plant"} location the truck collects it from.`,
          order_number, plant_id: po.plant_id, plant_name: clean(plant?.name),
          options: pickup.options.map((f) => ({ id: f.id, location_name: clean(f.location_name) || [clean(f.city), clean(f.state)].filter(Boolean).join(", "), address: clean(f.address) || null })),
        }, 409);
      }
      if (pickup.kind === "plant") { shipTo = vendorBlock; incoterms = plantIncoterm(plant || {}, geo || {}); }
      else { shipTo = facilityLines(plant || {}, pickup.facility, geo || {}).join("\n"); incoterms = facilityIncoterm(plant || {}, pickup.facility); }
    }

    // A delivered order (no US freight leg booked by BuenTrade) is delivered to the customer's customs agency at the border: the offer's agency,
    // else the agency assigned to the customer (the same fallback the quote uses).
    let customsAgency = null;
    if (!isFob) {
      const [agency] = await sql`
        select a.*, c.name_en as country_name from providers a left join countries c on c.id = a.country_id
        where a.id = coalesce(${offer?.customs_agency_provider_id ?? null}, (select customs_agency_provider_id from customers where id = ${offer?.customer_id ?? null}))`;
      if (!agency) {
        return jsonResponse({ error: "customs_agency_required", message: "This delivered order has no customs agency (neither on the offer nor on the customer): assign one to the customer, so the PO says where the load is delivered.", order_number }, 409);
      }
      customsAgency = agency;
      shipTo = agencyAddressLines(agency, agency.country_name).join("\n");
      incoterms = agencyIncoterm(agency);
    }

    // The temperature to hold the load at comes from the product's own temperature (Fresh / Frozen) and its setpoint.
    const [prodTemp] = await sql`select t.name_en as temperature, t.po_setpoint_f from products p join temperature t on t.id = p.temperature_id where p.id = ${po.product_id}`;
    const notes = poNotes({ temperature: prodTemp?.temperature, setpointF: prodTemp?.po_setpoint_f, docsOn: !!po.docs_on });

    const trader = traderDisplayName(offer?.won_by);

    const doc = {
      order_number,
      date: po.created_at,
      pick_up_date: Array.isArray(po.delivery_dates) && po.delivery_dates[0] ? po.delivery_dates[0] : null,
      // Two separate real fields, previously conflated into one here: PAYMENT TERMS is the
      // plant's own on-file terms text; the docs_on note is shown separately, matching the real
      // "NOTES: Docs included by vendor." / "...buyer to arrange." line in buildPODoc().
      payment_terms: plant?.payment_terms || null,
      docs_note: notes[notes.length - 1],
      notes,
      incoterms,
      country_of_origin: countryOfOrigin(plant || {}, geo || {}),
      trader,
      vendor: vendorBlock,
      ship_to: shipTo,
      customs_agency: customsAgency,
      line_item: {
        description: po.product_spec || po.product_name,
        weight: po.weight,
        purchase_price: po.purchase_price,
        total_cost: po.total_cost,
      },
      docs_on: po.docs_on,
    };

    const text = [
      `PURCHASE ORDER ${order_number}`,
      `Date: ${fmtDate(doc.date)}`,
      doc.pick_up_date ? `Pick-up date: ${doc.pick_up_date}` : null,
      doc.payment_terms ? `Payment terms: ${doc.payment_terms}` : null,
      `Incoterms: ${doc.incoterms}`,
      doc.country_of_origin ? `Country of origin: ${doc.country_of_origin}` : null,
      doc.trader ? `Trader: ${doc.trader}` : null,
      ``,
      `VENDOR:`, doc.vendor,
      ``,
      `SHIP TO / PICK UP:`, doc.ship_to,
      ``,
      `ITEM: ${doc.line_item.description}`,
      `Weight: ${fmtWeight(doc.line_item.weight)} lbs`,
      `Price: ${fmtUnitCost(doc.line_item.purchase_price)}/lb`,
      `Total: ${fmtAmount(doc.line_item.total_cost)}`,
      ``,
      `NOTES:`, ...doc.notes,
    ].filter((l) => l !== null).join("\n");

    // Raw rows alongside the composed document — offers.html's WhatsApp-card and email-send flows
    // need the actual po/plant fields (whatsapp, phone, email, email_cc…), not just the rendered
    // text, so one call here serves every consumer instead of needing a second endpoint.
    return jsonResponse({ document: doc, text, po, plant, offer });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
