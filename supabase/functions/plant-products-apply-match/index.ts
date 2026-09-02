// plant_products.applyMatch — the ONLY way a price gets attached to a plant+product, and the
// ONLY way plant_product_aliases learns how a plant writes something. The actual write logic now
// lives in _shared/applyPlantProductMatch.ts, so plant-price-emails-poll can call it in-process,
// sharing one Postgres connection, instead of a fresh HTTP call (and fresh connection) per line of
// a real email — see that shared file's own header. This file is now just the HTTP wrapper: same
// request/response shape as before, for Load Prices and anything else that calls it over HTTP.
//
// This is the write half of the loop products.matchFromPlantText starts: that function only ever
// proposes (it never writes anything), and NOTHING becomes a saved alias or a saved price until
// this is called — which only happens once a human (or the email-automation actor, having
// resolved a confident match) has confirmed it.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";
import { applyPlantProductMatch } from "../_shared/applyPlantProductMatch.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const result = await applyPlantProductMatch(sql, HMAC_SECRET, body);
    if ("error" in result) {
      const status = result.error === "unknown plant_id" || result.error === "unknown product_id" ? 400 : 400;
      return jsonResponse(result, status);
    }
    return jsonResponse(result, 200);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
