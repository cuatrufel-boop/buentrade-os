// sent_offers.expireStale — runs daily (pg_cron, see 20260908110000_expire_stale_offers.sql).
// Real ask 2026-09-08: "mas de una semana ya son obsoletas... en que momento las vamos borrando" ->
// approved: "que se expiren las ofertas en 10 dias." Never deletes a row — the real negotiation
// history stays queryable forever, it just moves out of the daily Pending view once it's genuinely
// dead: still 'sent', completely untouched (negotiation_log empty — a real bid/counter means an
// active negotiation, never auto-expired no matter how old), and sent 10+ days ago.
//
// 'expired' is its own status, kept separate from 'lost' on purpose — see the migration's own
// comment: folding "nobody replied" into "we lost the bid" would quietly skew offers.html's
// win-rate stat (renderStats() only counts won/lost).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const STALE_DAYS = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const stale = await sql`
      select * from sent_offers
      where status = 'sent'
        and jsonb_array_length(negotiation_log) = 0
        and sent_at < now() - (${STALE_DAYS} || ' days')::interval
    `;

    let expiredCount = 0;
    for (const offer of stale) {
      await sql.begin(async (tx) => {
        const [updatedOffer] = await tx`
          update sent_offers set status = 'expired' where id = ${offer.id} returning *
        `;
        await writeAuditLog(tx, HMAC_SECRET, { actor: "system", action: "update", table_name: "sent_offers", record_id: offer.id, before: offer, after: updatedOffer });
      });
      expiredCount++;
    }

    return jsonResponse({ expired_count: expiredCount, stale_days: STALE_DAYS });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
