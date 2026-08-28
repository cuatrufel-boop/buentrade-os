// provider_roles.search — read-only. Lists a provider's roles, or every provider holding a role.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { provider_id = null, role = null } = body;

    const results = await sql`
      select pr.*, p.name as provider_name from provider_roles pr join providers p on p.id = pr.provider_id
      where (${provider_id}::uuid is null or pr.provider_id = ${provider_id})
        and (${role}::text is null or pr.role = ${role})
      order by p.name, pr.role
    `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
