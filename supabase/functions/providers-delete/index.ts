// providers.delete — matches production's 3-step cascade (rates, then roles, then the provider
// itself), but as ONE transaction instead of 3 sequential calls — production's version has no
// transaction, so a failure partway through leaves orphaned rate/role rows; that gap is closed
// here, not reproduced.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from providers where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown provider id" }, 404);

    await sql.begin(async (tx) => {
      const deletedRates = await tx`delete from provider_rates where provider_id = ${id} returning *`;
      const deletedRoles = await tx`delete from provider_roles where provider_id = ${id} returning *`;
      await tx`delete from providers where id = ${id}`;
      await writeAuditLog(tx, HMAC_SECRET, {
        actor, action: "delete", table_name: "providers", record_id: id,
        before: { provider: existing, cascaded_rates: deletedRates, cascaded_roles: deletedRoles },
      });
    });

    return jsonResponse({ deleted: true, id });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
