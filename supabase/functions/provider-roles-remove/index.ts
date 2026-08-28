// provider_roles.remove — unassigns one role from a provider. Idempotent (removing a role that
// isn't assigned returns not_assigned, not an error) — same spirit as assign's already_assigned.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "provider_id", "role"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, provider_id, role } = body;

    const [existing] = await sql`select * from provider_roles where provider_id = ${provider_id} and role = ${role}`;
    if (!existing) return jsonResponse({ not_assigned: true });

    await sql.begin(async (tx) => {
      await tx`delete from provider_roles where id = ${existing.id}`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "provider_roles", record_id: existing.id, before: existing });
    });

    return jsonResponse({ removed: true });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
