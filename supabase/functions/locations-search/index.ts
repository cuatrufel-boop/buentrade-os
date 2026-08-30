// locations.search — read-only. The real, closed catalog of pickup/delivery cities (see
// 20260830040000_create_locations_catalog.sql for why this exists) — every carrier's US Freight
// rate and every plant's pickup location is expected to eventually resolve to one of these rows,
// never a free-text string typed independently on each side.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const results = await sql`select * from locations order by state, city`;
    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
