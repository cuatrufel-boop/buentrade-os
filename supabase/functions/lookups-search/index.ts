// lookups.search — read-only. Bundles the small, rarely-changing reference tables (temperature,
// packaging, categories, countries, states, currencies) that most screens fetch separately on
// every page load into ONE Edge Function call, one Postgres connection.
//
// Real fix 2026-08-30: measured every Edge Function call taking ~1-1.5s regardless of query size —
// the cost is establishing the Postgres connection itself, not running the query. A page like
// plants.html was paying that fixed cost 6 separate times just for these six tables on every load.
// This never changes the data any of them return — same tables, same order, same shape — just one
// round trip carrying all six instead of six round trips carrying one each.
import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const [temperatures, packagings, categories, countries, states, currencies] = await Promise.all([
      sql`select * from temperature order by name`,
      sql`select * from packaging order by name`,
      sql`select * from categories order by name`,
      sql`select * from countries order by name_es`,
      sql`select * from states order by name_en`,
      sql`select * from currencies order by code`,
    ]);
    return jsonResponse({ temperatures, packagings, categories, countries, states, currencies });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
