// products.matchFromPlantText — the ONLY place this matching logic is allowed to live. The actual
// rules now live in _shared/productMatcher.ts (matchProductFromPlantText), so plant-price-emails-
// poll can call the exact same logic in-process, sharing one Postgres connection, instead of
// opening a fresh one per HTTP call (a real problem at real volume — see that shared file's own
// header). This file is now just the HTTP wrapper: same request/response shape as before, for the
// frontend and anything else that calls it over HTTP.
//
// Read-only: never inserts, updates, or deletes anything. Its job is to answer one question —
// "does this line from a plant's price list match an existing product, or not?" — and hand back
// either a confident single match or a real list of candidates. It NEVER creates a product and
// NEVER silently picks between two plausible candidates; that decision belongs to the trader,
// made through a separate, explicit call (products.create / an "apply" endpoint), not here.
//
// Connects directly to Postgres as `api_service` (RLS-forced role, no bypass) — never through
// Supabase's PostgREST/anon/service_role path.
//
// Encodes rules from the permanent business-rules memory (feedback-catalog-matching-is-the-
// core-system) — see productMatcher.ts for the full rule-by-rule citations.

import postgres from "npm:postgres@3.4.4";
import { matchProductFromPlantText } from "../_shared/productMatcher.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { plant_id, raw_text, name_en, name_es, extra_term_aliases } = await req.json();
    const result = await matchProductFromPlantText(sql, { plant_id, raw_text, name_en, name_es, extra_term_aliases });

    if ("error" in result) {
      const status = result.error === "unknown plant_id" ? 404 : 400;
      return new Response(JSON.stringify(result), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(result), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
