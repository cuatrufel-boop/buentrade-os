// plant_pending_matches.create — one row per email price line the deterministic matcher
// (products-match-from-plant-text) couldn't confidently resolve. The actual write logic now lives
// in _shared/pendingMatch.ts, so plant-price-emails-poll can call it in-process, sharing one
// Postgres connection. This file is the HTTP wrapper, same request/response shape as before.
// Idempotent on idempotency_key so the same email line, reprocessed on a retry, never creates a
// second open row for the trader to resolve twice.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";
import { createPendingMatch } from "../_shared/pendingMatch.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const result = await createPendingMatch(sql, HMAC_SECRET, body);
    if ("error" in result) return jsonResponse(result, 400);
    return jsonResponse(result, 200);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
