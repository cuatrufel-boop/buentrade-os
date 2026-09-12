// packaging.delete — unlike cut_names/variations (pure suggestion lists, no FK), products.packaging_id
// is a REAL foreign key into packaging(id) with no ON DELETE clause, so the database itself would
// refuse this delete if any product still uses it. Checked up front here so the UI gets a clear
// "N products use this" message instead of a raw Postgres FK-violation error.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from packaging where id = ${id}`;
    if (!existing) return jsonResponse({ deleted: true, id, already_deleted: true });

    const [{ count }] = await sql`select count(*)::int as count from products where packaging_id = ${id}`;
    if (count > 0) return jsonResponse({ error: "in_use", message: `${count} product(s) still use this packaging type — reassign or remove them first.`, count }, 409);

    await sql.begin(async (tx) => {
      await tx`delete from packaging where id = ${id}`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "packaging", record_id: id, before: existing });
    });

    return jsonResponse({ deleted: true, id });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
