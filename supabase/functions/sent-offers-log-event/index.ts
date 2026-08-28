// sent_offers.logEvent — appends one {to, price, at} round to negotiation_log. Distinct from
// sent_offers.negotiate (which records a full {side, note, purchase_price, sale_per_lb...} round
// and updates the offer's working prices): this is the simpler quick-counter log the Trading Tool
// uses when the trader just clicks "counter to plant" / "counter to customer" with a single price,
// with no separate note or four-field price breakdown to capture. Both write into the same
// negotiation_log array — negoRenderLog() in trading-tool.html already reads either shape.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const VALID_TO = ["plant", "customer"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "sent_offer_id", "to", "price"].filter((k) => body[k] == null);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, sent_offer_id, to, price } = body;

    if (!VALID_TO.includes(to)) return jsonResponse({ error: "invalid to", valid_to: VALID_TO }, 400);

    const [offer] = await sql`select * from sent_offers where id = ${sent_offer_id}`;
    if (!offer) return jsonResponse({ error: "unknown sent_offer_id" }, 404);
    if (offer.status !== "sent") {
      return jsonResponse({ error: "not_pending", message: `This offer is already '${offer.status}' — nothing left to negotiate.`, current_status: offer.status }, 409);
    }

    const updatedOffer = await sql.begin(async (tx) => {
      const log = Array.isArray(offer.negotiation_log) ? offer.negotiation_log : [];
      const newLog = [...log, { to, price, at: new Date().toISOString() }];
      const [updatedOffer] = await tx`
        update sent_offers set negotiation_log = ${tx.json(newLog)} where id = ${sent_offer_id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "sent_offers", record_id: sent_offer_id, before: offer, after: updatedOffer });
      return updatedOffer;
    });

    return jsonResponse({ logged: true, offer: updatedOffer });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
