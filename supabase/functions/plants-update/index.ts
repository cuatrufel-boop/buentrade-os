// plants.update — partial update, same duplicate discipline as plants.create (near-duplicate name
// scoped to the same supplier), row excluded from its own comparison.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const UPDATABLE_FIELDS = [
  "name", "category_id", "country_id", "city_id", "state_id", "state", "address", "internal_code",
  "contact_name", "email", "email_cc", "phone", "whatsapp", "whatsapp_cc",
  "docs_included", "payment_terms", "required_documentation", "website", "notes", "internal_notes",
  "logo_url", "logo_url_dark",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, id, override_duplicate_check = false } = body;
    const [existing] = await sql`select * from plants where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown plant id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];

    if (merged.category_id) {
      const [category] = await sql`select id from categories where id = ${merged.category_id}`;
      if (!category) return jsonResponse({ error: "unknown category_id" }, 400);
    }

    const siblings = (await sql`select * from plants where supplier_id = ${existing.supplier_id}`)
      .filter((p: any) => p.id !== id);
    const exactDuplicate = siblings.find((p: any) => normalize(p.name) === normalize(merged.name));
    const nearDuplicates = siblings.filter((p: any) => isNearDuplicate(normalize(p.name), normalize(merged.name)));

    if ((exactDuplicate || nearDuplicates.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "This edit would make it identical to another plant under the same supplier — confirm to see it or override to save anyway."
          : "This supplier has a similarly-named plant already — confirm this is genuinely different before saving.",
        exact_match: exactDuplicate || null,
        near_duplicate_names: nearDuplicates,
      });
    }

    const plant = await sql.begin(async (tx) => {
      const [plant] = await tx`
        update plants set
          name = ${merged.name}, category_id = ${merged.category_id}, country_id = ${merged.country_id}, city_id = ${merged.city_id},
          state_id = ${merged.state_id}, state = ${merged.state}, address = ${merged.address}, internal_code = ${merged.internal_code},
          contact_name = ${merged.contact_name}, email = ${merged.email}, email_cc = ${merged.email_cc},
          phone = ${merged.phone}, whatsapp = ${merged.whatsapp}, whatsapp_cc = ${merged.whatsapp_cc},
          docs_included = ${merged.docs_included},
          payment_terms = ${merged.payment_terms}, required_documentation = ${merged.required_documentation},
          website = ${merged.website}, notes = ${merged.notes}, internal_notes = ${merged.internal_notes},
          logo_url = ${merged.logo_url}, logo_url_dark = ${merged.logo_url_dark},
          updated_at = now()
        where id = ${id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "plants", record_id: id, before: existing, after: plant });
      return plant;
    });

    return jsonResponse({ updated: true, plant });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
