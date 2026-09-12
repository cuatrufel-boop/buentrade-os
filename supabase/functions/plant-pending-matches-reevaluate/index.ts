// plant-pending-matches-reevaluate — one-time (re-runnable) reconciliation, NOT wired to any UI
// button. Real gap found live 2026-09-10: fixing a real bug in the shared matcher
// (_shared/productMatcher.ts) only changes what happens to a NEW incoming email line — every
// pending_matches row already sitting in the queue from BEFORE the fix keeps whatever
// candidate_product_ids/candidates_conflicted it was given at the moment it was first created,
// forever, since nothing ever re-runs the matcher against an existing row. A fix landing for
// Seaboard's own emails looked like it never reached Tyson's (or anyone else's) OLDER pending
// rows — not because the fix was scoped to one plant, but because old DATA doesn't retroactively
// benefit from a NEWER function. This re-runs the CURRENT matcher against every still-open,
// non-declined pending row, across every plant, and either:
//   - auto-applies it (exact same write path Load Prices/the email poll already use) and marks it
//     resolved, if the current matcher now confidently matches it, or
//   - refreshes its candidate_product_ids/candidates_conflicted in place to what the matcher says
//     today, if it's still not confident — so the review screen shows today's best guess, not a
//     stale one from whenever the row happened to be created.
// Never touches signal_type='declined' rows — those always need an explicit human decision,
// never auto-applied, same rule the email poll itself already follows.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";
import { matchProductFromPlantText } from "../_shared/productMatcher.ts";
import { applyPlantProductMatch } from "../_shared/applyPlantProductMatch.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const RECONCILE_ACTOR = "matcher-reconcile@buentradegroup.com";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const plant_id = body.plant_id || null;

    const [{ id: usdCurrencyId }] = await sql`select id from currencies where code = 'USD'`;
    const today = new Date().toISOString().slice(0, 10);

    const rows = plant_id
      ? await sql`select * from plant_pending_matches where plant_id = ${plant_id} and resolved_at is null and (signal_type is null or signal_type = 'price') order by created_at`
      : await sql`select * from plant_pending_matches where resolved_at is null and (signal_type is null or signal_type = 'price') order by created_at`;

    const results = { applied: 0, refreshed: 0, unchanged: 0, errors: [] as string[] };

    for (const row of rows) {
      try {
        const matchRes = await matchProductFromPlantText(sql, { plant_id: row.plant_id, raw_text: row.raw_text });
        if ("error" in matchRes) { results.errors.push(`${row.id}: ${matchRes.error}`); continue; }

        if (matchRes.matched) {
          await applyPlantProductMatch(sql, HMAC_SECRET, {
            actor: RECONCILE_ACTOR, plant_id: row.plant_id, product_id: matchRes.product.id,
            raw_text: row.raw_text, price: Number(row.detected_price),
            price_currency_id: usdCurrencyId, price_date: today,
          });
          await sql.begin(async (tx) => {
            const [updated] = await tx`
              update plant_pending_matches set resolved_at = now(), resolved_product_id = ${matchRes.product.id}, resolved_by = ${RECONCILE_ACTOR}
              where id = ${row.id} returning *
            `;
            await writeAuditLog(tx, HMAC_SECRET, { actor: RECONCILE_ACTOR, action: "update", table_name: "plant_pending_matches", record_id: row.id, before: { pending_match: row }, after: { pending_match: updated } });
          });
          results.applied++;
        } else {
          const newIds = matchRes.candidates.map((p: any) => p.id).sort();
          const oldIds = (Array.isArray(row.candidate_product_ids) ? row.candidate_product_ids : []).slice().sort();
          const sameIds = newIds.length === oldIds.length && newIds.every((id: string, i: number) => id === oldIds[i]);
          const sameConflict = !!row.candidates_conflicted === (matchRes.conflicted === true);
          if (sameIds && sameConflict) { results.unchanged++; continue; }
          await sql`
            update plant_pending_matches set candidate_product_ids = ${newIds}, candidates_conflicted = ${matchRes.conflicted === true}
            where id = ${row.id}
          `;
          results.refreshed++;
        }
      } catch (e) {
        results.errors.push(`${row.id}: ${e}`);
      }
    }

    return jsonResponse({ scanned: rows.length, ...results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
