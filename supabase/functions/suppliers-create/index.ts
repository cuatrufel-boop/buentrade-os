// suppliers.create — the only way a new supplier row gets inserted. Same discipline as
// products.create, generalized: [[feedback_never_duplicate_master_data]] states this explicitly
// covers customers/products/plants — suppliers are the same category of master data and get the
// same treatment (near-duplicate name check, never a dead-end block, override required to proceed
// past a real warning, every write hash-chained into audit_log).
//
// No category/temperature/packaging dimension here (that's product-specific) — a supplier is
// disambiguated by name plus, when given, country/city, so a near-duplicate name in a different
// country still gets flagged (a name collision is worth a human's eyes regardless of location),
// just without location bumping up the match to a hard flag on its own.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "name"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const {
      actor, name, country_id = null, city_id = null, state = null,
      contact_name = null, email = null, phone = null, website = null, notes = null,
      avg_response_time = null, payment_terms = null, required_documentation = null,
      override_duplicate_check = false, idempotency_key = null,
    } = body;

    if (idempotency_key) {
      const [existing] = await sql`select * from suppliers where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ created: true, supplier: existing, idempotent_replay: true });
    }

    const allSuppliers = await sql`select * from suppliers`;

    const exactDuplicate = allSuppliers.find((s: any) => normalize(s.name) === normalize(name));
    const nearDuplicates = allSuppliers.filter((s: any) => isNearDuplicate(normalize(s.name), normalize(name)));

    if ((exactDuplicate || nearDuplicates.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "A supplier with this exact name already exists — confirm to see it or override to create a separate row anyway."
          : "Similar supplier names already exist — confirm this is genuinely different before creating it.",
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

    const supplier = await sql.begin(async (tx) => {
      const [supplier] = await tx`
        insert into suppliers (
          name, country, state, city, country_id, city_id,
          contact_name, email, phone, website, notes,
          avg_response_time, payment_terms, required_documentation, idempotency_key
        ) values (
          ${name}, null, ${state}, null, ${country_id}, ${city_id},
          ${contact_name}, ${email}, ${phone}, ${website}, ${notes},
          ${avg_response_time}, ${payment_terms}, ${required_documentation}, ${idempotency_key}
        ) returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "suppliers", record_id: supplier.id, after: supplier });
      return supplier;
    });

    return jsonResponse({ created: true, supplier }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
