// plant_pending_matches.update — marks one open row resolved once a human has picked the real
// product for it. Deliberately does NOT itself write the price to plant_products — the caller
// applies the price first through the existing plant-products-apply-match endpoint (same write
// path Load Prices already uses, never duplicated here), then calls this only to close the row out
// of the pending queue. Already-resolved is treated as success (idempotent), not an error — a
// double-click on "Match" shouldn't fail the second time.

import postgres from "npm:postgres@3.4.4";
import { canonicalPendingText, jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const REQUIRED_FIELDS = ["actor", "id", "product_id"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = REQUIRED_FIELDS.filter((k) => body[k] == null || body[k] === "");
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, id, product_id } = body;

    const [existing] = await sql`select * from plant_pending_matches where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown pending match id" }, 400);
    if (existing.resolved_at) return jsonResponse({ pending_match: existing, idempotent_replay: true });

    const [product] = await sql`select id from products where id = ${product_id}`;
    if (!product) return jsonResponse({ error: "unknown product_id" }, 400);

    const result = await sql.begin(async (tx) => {
      const [row] = await tx`
        update plant_pending_matches
        set resolved_at = now(), resolved_product_id = ${product_id}, resolved_by = ${actor}
        where id = ${id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, {
        actor, action: "update", table_name: "plant_pending_matches", record_id: row.id, before: { pending_match: existing }, after: { pending_match: row },
      });
      // One decision per product: every other open row of this same plant + same product line (same signal, same canonical text)
      // closes with it, so the trader never has to match the same product again for older copies of it.
      const key = canonicalPendingText(existing.raw_text);
      const others = (await tx`select * from plant_pending_matches where plant_id = ${existing.plant_id} and signal_type = ${existing.signal_type} and resolved_at is null and id <> ${id}`)
        .filter((r: any) => canonicalPendingText(r.raw_text) === key);
      for (const o of others) {
        const [c] = await tx`update plant_pending_matches set resolved_at = now(), resolved_product_id = ${product_id}, resolved_by = ${actor} where id = ${o.id} returning *`;
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "plant_pending_matches", record_id: c.id, before: { pending_match: o }, after: { pending_match: c } });
      }
      return { ...row, closed_duplicates: others.length };
    });

    return jsonResponse({ pending_match: result }, 200);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
