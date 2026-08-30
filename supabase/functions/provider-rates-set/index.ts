// provider_rates.set — creates or updates a provider's rate for one (service_type, origin,
// destination) combination. A silent upsert, not a duplicate-confirmation flow — unlike a
// product/customer/supplier name, a rate for the exact same lane genuinely IS meant to be
// overwritten when it changes (freight/customs pricing moves often); `unique(provider_id,
// service_type, origin, destination)` is what makes "the same lane again" identifiable at all.
// `plant_id` is deliberately NOT part of that uniqueness — confirmed real design: multiple plants
// in the same city share one real-world freight rate to the border, so a new plant in an existing
// city updates/notes the same row rather than forking a duplicate one.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const VALID_SERVICE_TYPES = [
  "us_freight", "mexican_freight", "customs", "tramite_aduanal", "bodega_americana", "lumper_fee", "inbond_release",
];

const REQUIRED_FIELDS = ["actor", "provider_id", "service_type", "rate"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = REQUIRED_FIELDS.filter((k) => body[k] == null || body[k] === "");
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const {
      actor, provider_id, plant_id = null, service_type,
      origin = "", destination = "", rate, currency_id = null, notes = null, location_id = null,
    } = body;

    if (!VALID_SERVICE_TYPES.includes(service_type)) {
      return jsonResponse({ error: "invalid service_type", valid_service_types: VALID_SERVICE_TYPES }, 400);
    }

    const [provider] = await sql`select id from providers where id = ${provider_id}`;
    if (!provider) return jsonResponse({ error: "unknown provider_id" }, 400);

    // currency_id is the real FK; `currency` is the older text column every other read path
    // (provider-rates-search included) still displays — keep both in sync.
    let currencyCode = null;
    if (currency_id) {
      const [c] = await sql`select code from currencies where id = ${currency_id}`;
      currencyCode = c?.code ?? null;
    }

    const providerRate = await sql.begin(async (tx) => {
      const [providerRate] = await tx`
        insert into provider_rates (provider_id, plant_id, service_type, origin, destination, rate, currency, currency_id, notes, location_id)
        values (${provider_id}, ${plant_id}, ${service_type}, ${origin}, ${destination}, ${rate}, ${currencyCode ?? 'USD'}, ${currency_id}, ${notes}, ${location_id})
        on conflict (provider_id, service_type, origin, destination) do update set
          rate = excluded.rate,
          currency = case when excluded.currency_id is not null then excluded.currency else provider_rates.currency end,
          currency_id = coalesce(excluded.currency_id, provider_rates.currency_id),
          plant_id = coalesce(excluded.plant_id, provider_rates.plant_id),
          notes = excluded.notes,
          location_id = coalesce(excluded.location_id, provider_rates.location_id),
          updated_at = now()
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "provider_rates", record_id: providerRate.id, after: providerRate });
      return providerRate;
    });

    return jsonResponse({ applied: true, provider_rate: providerRate }, 200);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
