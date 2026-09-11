// plant_pending_matches.update — marks one open row resolved once a human has either picked the
// real product for it (product_id) or looked at the real candidates and decided none of them is
// this line item (ignore: true — real ask 2026-09-11, "si uno no quiere ponerlo uno puede poner no
// anadir o ignorar"). Deliberately does NOT itself write the price to plant_products — the caller
// applies the price first through the existing plant-products-apply-match endpoint (same write
// path Load Prices already uses, never duplicated here), then calls this only to close the row out
// of the pending queue. Already-resolved is treated as success (idempotent), not an error — a
// double-click on "Match" (or "Don't Add") shouldn't fail the second time.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const REQUIRED_FIELDS = ["actor", "id"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = REQUIRED_FIELDS.filter((k) => body[k] == null || body[k] === "");
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, id, product_id, ignore } = body;
    if (!product_id && !ignore) return jsonResponse({ error: "must provide either product_id or ignore: true" }, 400);
    if (product_id && ignore) return jsonResponse({ error: "cannot provide both product_id and ignore" }, 400);

    const [existing] = await sql`select * from plant_pending_matches where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown pending match id" }, 400);
    if (existing.resolved_at) return jsonResponse({ pending_match: existing, idempotent_replay: true });

    let resolvedProductId = null;
    if (product_id) {
      const [product] = await sql`select id from products where id = ${product_id}`;
      if (!product) return jsonResponse({ error: "unknown product_id" }, 400);
      resolvedProductId = product_id;
    }

    const result = await sql.begin(async (tx) => {
      const [row] = await tx`
        update plant_pending_matches
        set resolved_at = now(), resolved_product_id = ${resolvedProductId}, resolved_by = ${actor}
        where id = ${id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, {
        actor, action: "update", table_name: "plant_pending_matches", record_id: row.id, before: { pending_match: existing }, after: { pending_match: row },
      });
      return row;
    });

    return jsonResponse({ pending_match: result }, 200);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
