// plant_pending_locations.search — read-only. Powers the "new pickup location?" Yes/No window in
// plants.html: called with plant_id when a plant is opened (or right after Load Prices' own Apply)
// to check for any pickup location a price mentioned that isn't on this plant's own Locations list
// yet. Defaults to open (unresolved) rows only, since that's every real caller's actual question.

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
        ? await sql`select * from plant_pending_locations where plant_id = ${plant_id} and resolved_at is null order by created_at`
        : await sql`select * from plant_pending_locations where plant_id = ${plant_id} order by created_at desc limit ${limit}`)
      : (unresolved_only
        ? await sql`select * from plant_pending_locations where resolved_at is null order by created_at`
        : await sql`select * from plant_pending_locations order by created_at desc limit ${limit}`);
    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
