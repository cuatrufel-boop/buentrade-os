// provider_rates.create — a genuine plain INSERT, distinct from provider_rates.set (which
// upserts by lane and would silently collapse two blank/in-progress rows into one). Needed for
// the real "+ Add a blank row, fill it in after" pattern the rates table UI uses — found only by
// actually wiring the frontend to the API, not something the earlier design anticipated.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const VALID_SERVICE_TYPES = ["us_freight", "mexican_freight", "customs", "tramite_aduanal", "bodega_americana", "lumper_fee", "inbond_release"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "provider_id", "service_type"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, provider_id, service_type, origin = "", destination = "", rate = 0, currency_id = null, plant_id = null, notes = null } = body;

    if (!VALID_SERVICE_TYPES.includes(service_type)) return jsonResponse({ error: "invalid service_type", valid_service_types: VALID_SERVICE_TYPES }, 400);
    const [provider] = await sql`select id from providers where id = ${provider_id}`;
    if (!provider) return jsonResponse({ error: "unknown provider_id" }, 400);

    // currency_id is the real FK; `currency` is the older text column every other read path
    // (provider-rates-search included) still displays — keep both in sync rather than letting
    // the text column silently freeze at its 'USD' default while currency_id says otherwise.
    let currencyCode = null;
    if (currency_id) {
      const [c] = await sql`select code from currencies where id = ${currency_id}`;
      currencyCode = c?.code ?? null;
    }

    const rateRow = await sql.begin(async (tx) => {
      const [rateRow] = await tx`
        insert into provider_rates (provider_id, service_type, origin, destination, rate, currency, currency_id, plant_id, notes)
        values (${provider_id}, ${service_type}, ${origin}, ${destination}, ${rate}, ${currencyCode ?? 'USD'}, ${currency_id}, ${plant_id}, ${notes})
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "provider_rates", record_id: rateRow.id, after: rateRow });
      return rateRow;
    });

    return jsonResponse({ created: true, rate: rateRow }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
