// orders.composeFO — read-only. Freight Confirmation (English, carrier-facing). A won order can
// have more than one freight_orders row (US leg + Mexican leg) — this returns one composed
// document per row for the order_number, matching production's one-PDF-per-leg behavior.
// Temperature is parsed off the product spec's leading word, same heuristic as the original.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });

function temperatureFromSpec(spec: string | null): string | null {
  if (!spec) return null;
  const first = spec.trim().split(/\s+/)[0]?.toLowerCase();
  if (first === "frozen" || first === "congelado") return "Frozen";
  if (first === "fresh" || first === "fresco") return "Fresh";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    if (!body.order_number) return jsonResponse({ error: "order_number is required" }, 400);
    const { order_number } = body;

    const freightOrders = await sql`select * from freight_orders where order_number = ${order_number}`;
    if (!freightOrders.length) return jsonResponse({ error: "no freight_orders for this order_number" }, 404);

    const documents = [];
    for (const fo of freightOrders) {
      const [offer] = fo.sent_offer_id ? await sql`select * from sent_offers where id = ${fo.sent_offer_id}` : [null];
      const [carrier] = fo.carrier_provider_id ? await sql`select * from providers where id = ${fo.carrier_provider_id}` : [null];
      let customsAgency = null;
      if (offer?.customs_agency_provider_id) {
        [customsAgency] = await sql`select * from providers where id = ${offer.customs_agency_provider_id}`;
      }

      // "Border" is a placeholder meaning the carrier's own real crossing facility, not a literal
      // destination — resolved to the carrier's own city/state/country when the raw value says so.
      const resolveBorder = (v: string | null) =>
        v && v.toLowerCase() === "border" && carrier ? `${carrier.name} crossing facility, ${[carrier.city, carrier.country].filter(Boolean).join(", ")}` : v;

      const doc = {
        order_number,
        freight_order_id: fo.id,
        carrier: carrier ? { name: carrier.name, city: carrier.city, country: carrier.country, phone: carrier.phone, mc_number: carrier.mc_number, dot_number: carrier.dot_number } : null,
        client_broker: "BuenTrade LLC",
        pick_up_address: resolveBorder(fo.origin),
        delivery_address: resolveBorder(fo.destination),
        temperature_setting: temperatureFromSpec(offer?.product_spec),
        weight: offer?.weight || null,
        delivery_dates: offer?.delivery_dates || null,
        rate: fo.actual_rate ?? fo.quoted_rate,
        customs_broker: customsAgency ? customsAgency.name : null,
      };

      const text = [
        `FREIGHT CONFIRMATION ${order_number}`,
        carrier ? `Carrier: ${carrier.name} (${[carrier.city, carrier.country].filter(Boolean).join(", ")})` : null,
        carrier?.mc_number ? `MC#: ${carrier.mc_number}` : null,
        carrier?.dot_number ? `DOT#: ${carrier.dot_number}` : null,
        `Client (Broker): ${doc.client_broker}`,
        ``,
        `Pick-up: ${doc.pick_up_address || "TBD"}`,
        `Delivery: ${doc.delivery_address || "TBD"}`,
        doc.temperature_setting ? `Temperature setting: ${doc.temperature_setting}` : null,
        doc.weight ? `Weight: ${doc.weight} lbs` : null,
        `Rate: $${doc.rate}`,
        doc.customs_broker ? `Customs broker: ${doc.customs_broker}` : null,
      ].filter((l) => l !== null).join("\n");

      documents.push({ document: doc, text });
    }

    return jsonResponse({ documents });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
