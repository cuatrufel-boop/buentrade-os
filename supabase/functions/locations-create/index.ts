// locations.create — adds a real city to the closed catalog (see
// 20260830040000_create_locations_catalog.sql). Rare on purpose: the 24-city seed already covers
// every real pickup point on file as of 2026-08-30, so this is the escape hatch for the day a
// plant or carrier mentions somewhere genuinely new, not a routine action.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "city", "state"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, city, state, idempotency_key = null } = body;

    // A retried/double-clicked identical request replays the exact same row it already created —
    // same pattern as products-create/cut-names-create, checked BEFORE the semantic duplicate
    // check below (a real retry isn't a "different real city that looks similar," it's the same
    // request landing twice).
    if (idempotency_key) {
      const [existing] = await sql`select * from locations where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ created: true, location: existing });
    }

    // Case-insensitive check against the real unique constraint — never a silent duplicate city
    // under slightly different casing, same "cuidar la data" rule as everywhere else in the
    // catalog. Real options, never silence: names the exact existing row instead of just failing.
    const [existing] = await sql`select * from locations where lower(city) = lower(${city}) and upper(state) = upper(${state})`;
    if (existing) {
      return jsonResponse({ error: "possible_duplicate", message: `${existing.city} ${existing.state} is already in the catalog.`, location: existing }, 409);
    }

    const location = await sql.begin(async (tx) => {
      const [location] = await tx`insert into locations (city, state, idempotency_key) values (${city}, ${state.toUpperCase()}, ${idempotency_key}) returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "locations", record_id: location.id, after: location });
      return location;
    });

    return jsonResponse({ created: true, location });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
