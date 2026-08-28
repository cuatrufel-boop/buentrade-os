// provider_rates.search — read-only. Lists a provider's rates, or every rate for a service_type,
// or both — powers the rates table view (per-provider tab, or "every US freight rate on file").

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json().catch(() => ({}));
    const { provider_id = null, service_type = null } = body;
    const limit = Math.min(Number(body.limit) || 200, 1000);

    const results = await sql`
      select r.*, p.name as provider_name from provider_rates r join providers p on p.id = r.provider_id
      where (${provider_id}::uuid is null or r.provider_id = ${provider_id})
        and (${service_type}::text is null or r.service_type = ${service_type})
      order by p.name, r.service_type, r.origin
      limit ${limit}
    `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
