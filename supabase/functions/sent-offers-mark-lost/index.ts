// sent_offers.markLost — the other side of markWon. No orders get created (there's nothing to
// fulfill), just a status flip plus the audit trail of who marked it and why.

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
    const { actor, sent_offer_id, reason = null } = body;

    const [offer] = await sql`select * from sent_offers where id = ${sent_offer_id}`;
    if (!offer) return jsonResponse({ error: "unknown sent_offer_id" }, 404);
    if (offer.status !== "sent") {
      return jsonResponse({ error: "not_pending", message: `This offer is already '${offer.status}', not 'sent' — can't mark it lost again.`, current_status: offer.status }, 409);
    }

    const updatedOffer = await sql.begin(async (tx) => {
      const log = Array.isArray(offer.negotiation_log) ? offer.negotiation_log : [];
      const newLog = reason ? [...log, { at: new Date().toISOString(), by: actor, event: "lost", reason }] : log;

      const [updatedOffer] = await tx`
        update sent_offers set status = 'lost', negotiation_log = ${tx.json(newLog)}
        where id = ${sent_offer_id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "sent_offers", record_id: sent_offer_id, before: offer, after: updatedOffer });
      return updatedOffer;
    });

    return jsonResponse({ lost: true, offer: updatedOffer });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
