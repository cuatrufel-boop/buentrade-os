// plant_pending_matches.search — read-only. Powers both the per-plant "Pending Matches" tab
// (plant_id passed) and the badge count on the plants list (no plant_id — every open row across
// every plant, grouped client-side by plant_id). Defaults to open (unresolved) rows only, since
// that's every real caller's actual question — pass unresolved_only:false to see resolved history.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { plant_id = null, unresolved_only = true, limit = 500 } = body;
    const results = plant_id
      ? (unresolved_only
        ? await sql`select * from plant_pending_matches where plant_id = ${plant_id} and resolved_at is null order by created_at desc limit ${limit}`
        : await sql`select * from plant_pending_matches where plant_id = ${plant_id} order by created_at desc limit ${limit}`)
      : (unresolved_only
        ? await sql`select * from plant_pending_matches where resolved_at is null order by created_at desc limit ${limit}`
        : await sql`select * from plant_pending_matches order by created_at desc limit ${limit}`);
    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
