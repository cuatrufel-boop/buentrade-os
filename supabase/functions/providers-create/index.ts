// providers.create — carriers, freight forwarders, customs brokers. Same master-data discipline
// as suppliers/customers/plants ([[feedback_never_duplicate_master_data]]): near-duplicate name
// check, never a dead-end block, override required to proceed, every write hash-chained.
// A provider's actual role(s) (carrier/freight_forwarder/customs_broker) are assigned separately
// via provider_roles.assign — a provider can hold more than one role, so it doesn't belong here.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "name"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const {
      actor, name, country = null, city = null, country_id = null, city_id = null, phone = null,
      contact_name = null, email = null, email_cc = null, whatsapp_cc = null, notes = null,
      mc_number = null, dot_number = null,
      override_duplicate_check = false,
    } = body;

    const allProviders = await sql`select * from providers`;

    const exactDuplicate = allProviders.find((p: any) => normalize(p.name) === normalize(name));
    const nearDuplicates = allProviders.filter((p: any) => isNearDuplicate(normalize(p.name), normalize(name)));

    if ((exactDuplicate || nearDuplicates.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "A provider with this exact name already exists — confirm to see it or override to create a separate row anyway."
          : "Similar provider names already exist — confirm this is genuinely different before creating it.",
        exact_match: exactDuplicate || null,
        near_duplicate_names: nearDuplicates,
      });
    }

    if (country_id) {
      const [country] = await sql`select id from countries where id = ${country_id}`;
      if (!country) return jsonResponse({ error: "unknown country_id" }, 400);
    }
    if (city_id) {
      const [city] = await sql`select id from cities where id = ${city_id}`;
      if (!city) return jsonResponse({ error: "unknown city_id" }, 400);
    }

    const provider = await sql.begin(async (tx) => {
      const [provider] = await tx`
        insert into providers (name, country, city, country_id, city_id, phone, contact_name, email, email_cc, whatsapp_cc, notes, mc_number, dot_number)
        values (${name}, ${country}, ${city}, ${country_id}, ${city_id}, ${phone}, ${contact_name}, ${email}, ${email_cc}, ${whatsapp_cc}, ${notes}, ${mc_number}, ${dot_number})
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "providers", record_id: provider.id, after: provider });
      return provider;
    });

    return jsonResponse({ created: true, provider }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
