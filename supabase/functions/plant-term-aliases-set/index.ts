// plant_term_aliases.set — the trader teaches the system a plant-specific abbreviation
// ("STL" means St Louis cut, "FZ" means Frozen). Upserts on (plant_id, term, meaning_type), so
// re-teaching the same word just corrects it. Accepts a batch (array of {term, meaning_type,
// meaning_id}) since a review session can teach several at once, all confirmed together on
// "Apply All", same single-confirm point as everything else on that screen.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const VALID_MEANING_TYPES = ["temperature", "packaging"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "plant_id", "aliases"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, plant_id, aliases } = body;

    if (!Array.isArray(aliases) || !aliases.length) return jsonResponse({ error: "aliases must be a non-empty array" }, 400);
    for (const a of aliases) {
      if (!a.term || !VALID_MEANING_TYPES.includes(a.meaning_type) || !a.meaning_id) {
        return jsonResponse({ error: "each alias needs term, meaning_type (temperature|packaging), and meaning_id", bad_entry: a }, 400);
      }
    }

    const [plant] = await sql`select id from plants where id = ${plant_id}`;
    if (!plant) return jsonResponse({ error: "unknown plant_id" }, 400);

    const saved = await sql.begin(async (tx) => {
      const rows = [];
      for (const a of aliases) {
        const [row] = await tx`
          insert into plant_term_aliases (plant_id, term, meaning_type, meaning_id)
          values (${plant_id}, ${a.term}, ${a.meaning_type}, ${a.meaning_id})
          on conflict (plant_id, term, meaning_type) do update set meaning_id = excluded.meaning_id
          returning *
        `;
        rows.push(row);
      }
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "plant_term_aliases", record_id: plant_id, after: rows });
      return rows;
    });

    return jsonResponse({ saved: true, aliases: saved });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
