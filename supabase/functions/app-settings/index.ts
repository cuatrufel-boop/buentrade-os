// app.settings — get/set, one function for both (kept under Supabase's 100-function project cap,
// already hit once). First real use: "la tasa queda como un valor configurable, no fija en el
// codigo" — the Collections interest rate (default 15% annual, validated against market A/R
// financing rates). Generic key/value on purpose — the next global setting this app needs reuses
// this instead of another one-off column somewhere.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "get") {
      const { key } = body;
      if (!key) return jsonResponse({ error: "missing required fields", missing: ["key"] }, 400);
      const [row] = await sql`select * from app_settings where key = ${key}`;
      return jsonResponse({ setting: row ?? null });
    }

    if (action === "list") {
      const rows = await sql`select * from app_settings order by key`;
      return jsonResponse({ settings: rows });
    }

    if (action === "set") {
      const { actor, key, value } = body;
      const missing = ["actor", "key", "value"].filter((k) => body[k] == null);
      if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
      const [before] = await sql`select * from app_settings where key = ${key}`;
      const [after] = await sql`
        insert into app_settings (key, value, updated_by) values (${key}, ${String(value)}, ${actor})
        on conflict (key) do update set value = ${String(value)}, updated_at = now(), updated_by = ${actor}
        returning *
      `;
      await writeAuditLog(sql, HMAC_SECRET, { actor, action: before ? "update" : "insert", table_name: "app_settings", record_id: key, before: before ?? undefined, after });
      return jsonResponse({ setting: after });
    }

    return jsonResponse({ error: "invalid action", valid_actions: ["get", "list", "set"] }, 400);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
