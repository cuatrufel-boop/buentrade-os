// plant_pending_matches.create — one row per email price line the deterministic matcher
// (products-match-from-plant-text) couldn't confidently resolve. Idempotent on idempotency_key so
// the same email line, reprocessed on a retry (a poll that re-reads an already-seen message), never
// creates a second open row for the trader to resolve twice.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const REQUIRED_FIELDS = ["actor", "plant_id", "raw_text"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = REQUIRED_FIELDS.filter((k) => body[k] == null || body[k] === "");
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, plant_id, raw_text, detected_price = null, candidate_product_ids = [], idempotency_key = null } = body;

    if (idempotency_key) {
      const [existing] = await sql`select * from plant_pending_matches where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ pending_match: existing, idempotent_replay: true });
    }

    const [plant] = await sql`select id from plants where id = ${plant_id}`;
    if (!plant) return jsonResponse({ error: "unknown plant_id" }, 400);

    const result = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into plant_pending_matches (plant_id, raw_text, detected_price, candidate_product_ids, idempotency_key)
        values (${plant_id}, ${raw_text}, ${detected_price}, ${tx.json(candidate_product_ids)}, ${idempotency_key})
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, {
        actor, action: "insert", table_name: "plant_pending_matches", record_id: row.id, after: { pending_match: row },
      });
      return row;
    });

    return jsonResponse({ pending_match: result }, 200);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
