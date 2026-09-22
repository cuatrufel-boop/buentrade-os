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
    const [temperatures, packagings, categories, countries, states, currencies, [seq]] = await Promise.all([
      sql`select * from temperature order by name`,
      sql`select * from packaging order by name`,
      sql`select * from categories order by name`,
      sql`select * from countries order by name_es`,
      sql`select * from states order by name_en`,
      sql`select * from currencies order by code`,
      // Real ask 2026-09-21: "deberia decir cual es el siguiente consecutivo" on trading-tool.html's
      // Create Order confirm — a non-consuming peek at order_number_seq (last_value bumped by 1
      // only when is_called, matching what the next real next_order_number() call would return).
      // Piggybacked on this already-existing bundle instead of a new Edge Function: the project was
      // already at the 100-function deploy cap (see project_supabase_function_cap). Display-only —
      // the real number is still assigned transactionally by next_order_number() at creation time,
      // so a concurrent order between this peek and the real create can make it stale; acceptable
      // for a single-operator preview, never used as the actual assigned number.
      sql`select last_value + (case when is_called then 1 else 0 end) as next_val from order_number_seq`,
    ]);
    const next_order_number_preview = `${new Date().getUTCFullYear()}-${seq.next_val}`;
    return jsonResponse({ temperatures, packagings, categories, countries, states, currencies, next_order_number_preview });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
