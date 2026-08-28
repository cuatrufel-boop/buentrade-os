// provider_rates.update — partial update by row id (matches production's per-cell inline-edit
// pattern in providers.html). No app-level collision guard beyond the DB's own
// unique(provider_id, service_type, origin, destination) — an edit that would collide with
// another real rate fails with a clear Postgres error instead of silently overwriting it.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const UPDATABLE_FIELDS = ["service_type", "origin", "destination", "rate", "currency_id", "currency", "plant_id", "notes"];
const VALID_SERVICE_TYPES = ["us_freight", "mexican_freight", "customs", "tramite_aduanal", "bodega_americana", "lumper_fee", "inbond_release"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    if (body.service_type && !VALID_SERVICE_TYPES.includes(body.service_type)) {
      return jsonResponse({ error: "invalid service_type", valid_service_types: VALID_SERVICE_TYPES }, 400);
    }

    const [existing] = await sql`select * from provider_rates where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown provider_rate id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];
    // currency_id changing without an explicit currency override — resolve the text code from the
    // FK so the legacy `currency` column (every other read path still displays it) doesn't go
    // stale relative to the real reference.
    if ("currency_id" in body && !("currency" in body)) {
      const [c] = await sql`select code from currencies where id = ${merged.currency_id}`;
      merged.currency = c?.code ?? merged.currency;
    }

    const rate = await sql.begin(async (tx) => {
      const [rate] = await tx`
        update provider_rates set
          service_type = ${merged.service_type}, origin = ${merged.origin}, destination = ${merged.destination},
          rate = ${merged.rate}, currency = ${merged.currency}, currency_id = ${merged.currency_id}, plant_id = ${merged.plant_id}, notes = ${merged.notes},
          updated_at = now()
        where id = ${id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "provider_rates", record_id: id, before: existing, after: rate });
      return rate;
    });

    return jsonResponse({ updated: true, rate });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
