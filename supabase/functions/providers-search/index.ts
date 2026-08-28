// providers.search — read-only. Matches provider name; optionally scoped to a role
// (carrier/freight_forwarder/customs_broker) so "find me a customs broker" doesn't also surface
// carriers with a similar-sounding name.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const VALID_ROLES = ["carrier", "freight_forwarder", "customs_broker"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    const q = (body.q || "").trim();
    const role = body.role || null;
    const id = body.id || null;
    const limit = Math.min(Number(body.limit) || 200, 500);

    if (role && !VALID_ROLES.includes(role)) return jsonResponse({ error: "invalid role", valid_roles: VALID_ROLES }, 400);
    const like = `%${q}%`;

    // Empty q means "everything" (a list-view load), not an error — a keyword search is just a
    // narrower case of the same query. id fetches one known provider directly (offers.html needs
    // to resolve a stored customs_agency_provider_id to its full row).
    const results = id
      ? await sql`select * from providers where id = ${id}`
      : role
      ? await sql`
          select distinct p.*
          from providers p join provider_roles pr on pr.provider_id = p.id
          where pr.role = ${role} and p.name ilike ${like}
          order by p.name limit ${limit}
        `
      : await sql`select * from providers where name ilike ${like} order by name limit ${limit}`;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
