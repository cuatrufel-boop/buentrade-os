// plant_pending_matches.update — closes one open row, in exactly one of two ways: matched to the real catalog product a human picked,
// or dismissed by a human (nothing to match — an unreadable file, a line the plant gave no price for). Matching a price line also writes
// its alias here, in the same transaction, so a confirmation can never exist without the system remembering it. Deliberately does NOT
// itself write the price to plant_products — the caller applies the price first through plant-products-apply-match (the one write path
// Load Prices also uses), then calls this to close the row. Already-resolved is success (idempotent): a double-click must not fail.

import postgres from "npm:postgres@3.4.4";
import { canonicalPendingText, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const REQUIRED_FIELDS = ["actor", "id"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = REQUIRED_FIELDS.filter((k) => body[k] == null || body[k] === "");
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, id, product_id = null, dismiss = false } = body;
    // A row is closed in exactly one of two ways: matched to a catalog product, or dismissed by a person (nothing to match —
    // a file the system cannot read, a line with no price). Never both, never neither.
    if (!dismiss && !product_id) return jsonResponse({ error: "missing required fields", missing: ["product_id"] }, 400);
    if (dismiss && product_id) return jsonResponse({ error: "a row is either matched or dismissed, not both" }, 400);

    const [existing] = await sql`select * from plant_pending_matches where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown pending match id" }, 400);
    if (existing.resolved_at) return jsonResponse({ pending_match: existing, idempotent_replay: true });

    if (!dismiss) {
      const [product] = await sql`select id from products where id = ${product_id}`;
      if (!product) return jsonResponse({ error: "unknown product_id" }, 400);
    }
    if (!dismiss && existing.signal_type === "unread") return jsonResponse({ error: "an unread file or message has no product — dismiss it" }, 400);

    const result = await sql.begin(async (tx) => {
      const [row] = await tx`
        update plant_pending_matches
        set resolved_at = now(), resolved_product_id = ${dismiss ? null : product_id}, resolved_by = ${actor}
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
        const [c] = await tx`update plant_pending_matches set resolved_at = now(), resolved_product_id = ${dismiss ? null : product_id}, resolved_by = ${actor} where id = ${o.id} returning *`;
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "plant_pending_matches", record_id: c.id, before: { pending_match: o }, after: { pending_match: c } });
      }
      // Confirming a price line teaches its exact wording: the alias is written HERE, in the same transaction that closes the row,
      // so a confirmation can never exist without the system remembering it — whoever or whatever called this (the screen, a script).
      if (!dismiss && existing.signal_type === "price") {
        await tx`
          insert into plant_product_aliases (plant_id, product_id, raw_text)
          values (${existing.plant_id}, ${product_id}, ${normalize(existing.raw_text)})
          on conflict (plant_id, raw_text) do update set product_id = excluded.product_id
        `;
      }
      return { ...row, closed_duplicates: others.length };
    });

    return jsonResponse({ pending_match: result }, 200);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
