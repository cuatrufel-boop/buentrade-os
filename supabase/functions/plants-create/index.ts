// plants.create — the only way a new plant row gets inserted. Same duplicate discipline as
// suppliers.create/products.create. `category_id` is REQUIRED here (not just nullable-and-fill-
// in-later) — this is rule 15's actual enforcement point ("cada planta tiene una especie fija, el
// sistema no adivina línea por línea"): a plant with no fixed species would leave every future
// products.matchFromPlantText call for it matching against every category instead of a real
// boundary, silently reopening the exact cross-species risk rule 2/10 exists to close.
//
// Near-duplicate name check is scoped to the SAME supplier — two different suppliers legitimately
// can have similarly-named plants/locations; the same supplier having two near-identical plant
// names is what's actually suspicious.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const REQUIRED_FIELDS = ["actor", "supplier_id", "name", "category_id"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = REQUIRED_FIELDS.filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const {
      actor, supplier_id, name, category_id, country_id = null, city_id = null,
      address = null, internal_code = null, contact_name = null, email = null, email_cc = null,
      phone = null, whatsapp = null, whatsapp_cc = null, business_hours = null,
      avg_loading_time = null, avg_response_time = null, document_cost = null,
      avg_freight_to_border = null, docs_included = null, payment_terms = null,
      required_documentation = null, website = null, notes = null, internal_notes = null,
      override_duplicate_check = false,
    } = body;

    const [supplier] = await sql`select id from suppliers where id = ${supplier_id}`;
    if (!supplier) return jsonResponse({ error: "unknown supplier_id" }, 400);

    const [category] = await sql`select id from categories where id = ${category_id}`;
    if (!category) return jsonResponse({ error: "unknown category_id" }, 400);

    const siblingPlants = await sql`select * from plants where supplier_id = ${supplier_id}`;

    const exactDuplicate = siblingPlants.find((p: any) => normalize(p.name) === normalize(name));
    const nearDuplicates = siblingPlants.filter((p: any) => isNearDuplicate(normalize(p.name), normalize(name)));

    if ((exactDuplicate || nearDuplicates.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "This supplier already has a plant with this exact name — confirm to see it or override to create a separate row anyway."
          : "This supplier has a similarly-named plant already — confirm this is genuinely different before creating it.",
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

    const plant = await sql.begin(async (tx) => {
      const [plant] = await tx`
        insert into plants (
          supplier_id, name, category_id, country_id, city_id, address, internal_code,
          contact_name, email, email_cc, phone, whatsapp, whatsapp_cc, business_hours,
          avg_loading_time, avg_response_time, document_cost, avg_freight_to_border,
          docs_included, payment_terms, required_documentation, website, notes, internal_notes
        ) values (
          ${supplier_id}, ${name}, ${category_id}, ${country_id}, ${city_id}, ${address}, ${internal_code},
          ${contact_name}, ${email}, ${email_cc}, ${phone}, ${whatsapp}, ${whatsapp_cc}, ${business_hours},
          ${avg_loading_time}, ${avg_response_time}, ${document_cost}, ${avg_freight_to_border},
          ${docs_included}, ${payment_terms}, ${required_documentation}, ${website}, ${notes}, ${internal_notes}
        ) returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "plants", record_id: plant.id, after: plant });
      return plant;
    });

    return jsonResponse({ created: true, plant }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
