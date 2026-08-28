// orders.composePO — read-only. Composes the Purchase Order (English, plant-facing) as
// structured data + ready-to-send plain text. This is the business logic that used to live only
// in offers.html's buildPODoc() — moved here so every caller (the future frontend, a WhatsApp/
// email send, anything) gets the exact same document, computed once, not re-derived per screen.
//
// Incoterms rule (ported from the real app, confirmed via a full frontend audit 2026-08-26):
// FOB (no customs agency on the offer) -> "FCA – {plant location}", the plant IS the ship-from/
// pick-up point. Otherwise -> "DAP – {agency location}", delivered to the customs agency instead.
// Never guessed — read directly off sent_offers.customs_agency_provider_id, the same field the
// original logic keys off of.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });

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

    let shipTo = fmtAddress(plant?.name, plant?.address, plant?.city, plant?.state, plant?.country);
    let incoterms = `FCA – ${plant?.name || "plant"}, ${[plant?.city, plant?.state].filter(Boolean).join(", ")}`;
    let customsAgency = null;
    if (offer?.customs_agency_provider_id) {
      const [agency] = await sql`select * from providers where id = ${offer.customs_agency_provider_id}`;
      if (agency) {
        customsAgency = agency;
        shipTo = fmtAddress(agency.name, null, agency.city, null, agency.country);
        incoterms = `DAP – ${agency.name}, ${agency.city || ""}`;
      }
    }

    const trader = offer?.won_by ? offer.won_by.split("@")[0] : null;

    const doc = {
      order_number,
      date: po.created_at,
      pick_up_date: Array.isArray(po.delivery_dates) && po.delivery_dates[0] ? po.delivery_dates[0] : null,
      payment_terms: po.docs_on ? "Docs included" : "No docs",
      incoterms,
      country_of_origin: plant?.country || null,
      trader,
      vendor: fmtAddress(plant?.name, plant?.address, plant?.city, plant?.state, plant?.country),
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
      `Date: ${new Date(doc.date).toLocaleDateString()}`,
      doc.pick_up_date ? `Pick-up date: ${doc.pick_up_date}` : null,
      `Payment terms: ${doc.payment_terms}`,
      `Incoterms: ${doc.incoterms}`,
      doc.country_of_origin ? `Country of origin: ${doc.country_of_origin}` : null,
      doc.trader ? `Trader: ${doc.trader}` : null,
      ``,
      `VENDOR:`, doc.vendor,
      ``,
      `SHIP TO / PICK UP:`, doc.ship_to,
      ``,
      `ITEM: ${doc.line_item.description}`,
      `Weight: ${doc.line_item.weight} lbs`,
      `Price: $${doc.line_item.purchase_price}/lb`,
      `Total: $${doc.line_item.total_cost}`,
    ].filter((l) => l !== null).join("\n");

    return jsonResponse({ document: doc, text });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
