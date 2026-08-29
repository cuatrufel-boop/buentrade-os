// cut_names.search — read-only. Closed catalog for the base cut name (Lomo, Cabeza de lomo...) —
// one selection fills both EN and ES Product Name at once. Scoped by category_id when passed
// (2026-08-29: a cut name belongs to one species, same boundary as products/plants) — omitting it
// returns every category, still needed for the Remove-list management view.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const category_id = body.category_id || null;
    const results = category_id
      ? await sql`select * from cut_names where category_id = ${category_id} order by name_en`
      : await sql`select * from cut_names order by name_en`;
    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
