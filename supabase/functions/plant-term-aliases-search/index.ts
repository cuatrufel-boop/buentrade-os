// plant_term_aliases.search — read-only. Every abbreviation a trader has taught the system for
// one plant ("STL" -> St Louis cut, "FZ" -> Frozen). Used client-side only as a hint/pre-fill
// heuristic (e.g. suggesting temperature/packaging when opening the "create new product" form
// from a price-list row) — the actual match decision always goes through
// products.matchFromPlantText, which re-queries this same table server-side on every call, so
// there's no staleness risk in the authoritative path, only in this local hint.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { plant_id = null } = body;
    if (!plant_id) return jsonResponse({ error: "plant_id is required" }, 400);
    const results = await sql`select * from plant_term_aliases where plant_id = ${plant_id}`;
    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
