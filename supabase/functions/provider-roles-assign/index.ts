// provider_roles.assign — gives a provider one of its real roles (carrier / freight_forwarder /
// customs_broker). A provider can legitimately hold more than one role (e.g. a company that's
// both a carrier and a customs broker), so this is additive, not a single-value field on
// providers itself. No duplicate-confirmation flow needed here — `role` is a closed catalog value
// (enforced by the DB's own CHECK constraint, not free text) and `unique(provider_id, role)`
// already makes assigning the same role twice a no-op, reported plainly, never a dead end either.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const VALID_ROLES = ["carrier", "freight_forwarder", "customs_broker"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "provider_id", "role"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, provider_id, role } = body;
    if (!VALID_ROLES.includes(role)) {
      return jsonResponse({ error: "invalid role", valid_roles: VALID_ROLES }, 400);
    }

    const [provider] = await sql`select id from providers where id = ${provider_id}`;
    if (!provider) return jsonResponse({ error: "unknown provider_id" }, 400);

    const [existing] = await sql`select * from provider_roles where provider_id = ${provider_id} and role = ${role}`;
    if (existing) {
      return jsonResponse({ already_assigned: true, provider_role: existing }, 200);
    }

    const providerRole = await sql.begin(async (tx) => {
      const [providerRole] = await tx`
        insert into provider_roles (provider_id, role) values (${provider_id}, ${role}) returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "provider_roles", record_id: providerRole.id, after: providerRole });
      return providerRole;
    });

    return jsonResponse({ created: true, provider_role: providerRole }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
