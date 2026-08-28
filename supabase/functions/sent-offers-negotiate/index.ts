// sent_offers.negotiate — records one round of back-and-forth on a still-open offer (plant's
// counter, customer's counter, or the trader's own adjustment) and, when new prices are given,
// updates the working purchase_price/sale_per_lb/total_cost/total_sale on the offer itself — so
// the moment sent_offers.markWon fires, it snapshots whatever the LAST agreed numbers were, not
// the original first-quoted ones. Every round is appended to negotiation_log, never overwritten,
// so the back-and-forth history is never lost even though the "current" price is a single value.
// Only valid on an offer that's still 'sent' — nothing to negotiate on one already won or lost.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const VALID_SIDES = ["plant", "customer", "trader"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "sent_offer_id", "side"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const {
      actor, sent_offer_id, side, note = null,
      purchase_price = null, sale_per_lb = null, total_cost = null, total_sale = null,
    } = body;

    if (!VALID_SIDES.includes(side)) return jsonResponse({ error: "invalid side", valid_sides: VALID_SIDES }, 400);

    const [offer] = await sql`select * from sent_offers where id = ${sent_offer_id}`;
    if (!offer) return jsonResponse({ error: "unknown sent_offer_id" }, 404);
    if (offer.status !== "sent") {
      return jsonResponse({ error: "not_pending", message: `This offer is already '${offer.status}' — nothing left to negotiate.`, current_status: offer.status }, 409);
    }

    const updatedOffer = await sql.begin(async (tx) => {
      const log = Array.isArray(offer.negotiation_log) ? offer.negotiation_log : [];
      const round = {
        at: new Date().toISOString(), by: actor, side, note,
        purchase_price, sale_per_lb, total_cost, total_sale,
      };
      const newLog = [...log, round];

      const [updatedOffer] = await tx`
        update sent_offers set
          negotiation_log = ${tx.json(newLog)},
          purchase_price = ${purchase_price ?? offer.purchase_price},
          sale_per_lb = ${sale_per_lb ?? offer.sale_per_lb},
          total_cost = ${total_cost ?? offer.total_cost},
          total_sale = ${total_sale ?? offer.total_sale}
        where id = ${sent_offer_id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "sent_offers", record_id: sent_offer_id, before: offer, after: updatedOffer });
      return updatedOffer;
    });

    return jsonResponse({ negotiated: true, offer: updatedOffer });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
