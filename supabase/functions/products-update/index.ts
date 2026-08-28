// products.update — the ONLY way an existing product row can be changed. Real incident this
// closes (rule 1, [[feedback_catalog_matching_is_the_core_system]]): the duplicate check used to
// only run on create, so editing an existing row's name/temp/pack to collide with ANOTHER existing
// row was completely unguarded. Same checks as products.create — exact/near/subcategory-typo
// duplicate, never a dead-end block — run here too, with the row being edited excluded from its
// own comparison set (or every edit would "match itself" and never be allowed to save).
//
// Partial update: only fields actually present in the body get changed; everything else keeps its
// current value. `id` is the only field always required, plus `actor` for the audit trail.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, normalizeLoose, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const UPDATABLE_FIELDS = [
  "name", "name_en", "category_id", "subcategory", "subcategory_en",
  "temperature_id", "packaging_id", "full_name_en", "full_name_es", "brand",
  "unit_id", "standard_weight", "presentation", "origin",
  "documents_included", "documents_excluded", "commercial_notes", "photo_url", "spec_url",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, id, override_duplicate_check = false } = body;

    const [existing] = await sql`select * from products where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown product id" }, 404);

    // Merge: only keys actually present in the body override the current row's value.
    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];

    if (merged.category_id) {
      const [category] = await sql`select id from categories where id = ${merged.category_id}`;
      if (!category) return jsonResponse({ error: "unknown category_id" }, 400);
    }
    if (merged.temperature_id) {
      const [t] = await sql`select id from temperature where id = ${merged.temperature_id}`;
      if (!t) return jsonResponse({ error: "unknown temperature_id" }, 400);
    }
    if (merged.packaging_id) {
      const [p] = await sql`select id from packaging where id = ${merged.packaging_id}`;
      if (!p) return jsonResponse({ error: "unknown packaging_id" }, 400);
    }

    // Same-category siblings, excluding the row being edited — without this exclusion, every edit
    // would collide with itself and never be allowed to save.
    const siblings = (await sql`select * from products where category_id = ${merged.category_id}`)
      .filter((p: any) => p.id !== id);

    const exactDuplicate = siblings.find((p: any) =>
      normalizeLoose(p.name_en) === normalizeLoose(merged.name_en) &&
      p.temperature_id === merged.temperature_id &&
      p.packaging_id === merged.packaging_id &&
      normalize(p.subcategory_en) === normalize(merged.subcategory_en)
    );

    const sameSpecDifferentSubcat = siblings.filter((p: any) =>
      normalizeLoose(p.name_en) === normalizeLoose(merged.name_en) &&
      p.temperature_id === merged.temperature_id &&
      p.packaging_id === merged.packaging_id
    );

    const nearDuplicates = siblings.filter((p: any) =>
      isNearDuplicate(normalizeLoose(p.name_en), normalizeLoose(merged.name_en)) ||
      isNearDuplicate(normalize(p.name), normalize(merged.name))
    );

    const subcategorySiblings = siblings.filter((p: any) =>
      normalizeLoose(p.name_en) === normalizeLoose(merged.name_en) && p.subcategory_en
    );
    const subcategoryTypoConflicts = merged.subcategory_en
      ? subcategorySiblings.filter((p: any) =>
          p.subcategory_en !== merged.subcategory_en && (
            normalize(p.subcategory_en) === normalize(merged.subcategory_en) ||
            isNearDuplicate(normalize(p.subcategory_en), normalize(merged.subcategory_en))
          )
        )
      : [];

    if ((exactDuplicate || sameSpecDifferentSubcat.length || nearDuplicates.length || subcategoryTypoConflicts.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "This edit would make it identical to another existing product — confirm to see it or override to save anyway."
          : "This edit would make it similar to other existing products — confirm this is genuinely different before saving.",
        exact_match: exactDuplicate || null,
        same_spec_different_subcategory: sameSpecDifferentSubcat,
        near_duplicate_names: nearDuplicates,
        subcategory_typo_conflicts: subcategoryTypoConflicts,
      });
    }

    const product = await sql.begin(async (tx) => {
      const [product] = await tx`
        update products set
          name = ${merged.name}, name_en = ${merged.name_en},
          category = (select name from categories where id = ${merged.category_id}), category_id = ${merged.category_id},
          subcategory = ${merged.subcategory}, subcategory_en = ${merged.subcategory_en},
          temperature_id = ${merged.temperature_id}, packaging_id = ${merged.packaging_id},
          full_name_en = ${merged.full_name_en}, full_name_es = ${merged.full_name_es}, brand = ${merged.brand},
          unit_id = ${merged.unit_id}, standard_weight = ${merged.standard_weight}, presentation = ${merged.presentation}, origin = ${merged.origin},
          documents_included = ${merged.documents_included}, documents_excluded = ${merged.documents_excluded},
          commercial_notes = ${merged.commercial_notes}, photo_url = ${merged.photo_url}, spec_url = ${merged.spec_url},
          updated_at = now()
        where id = ${id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "products", record_id: id, before: existing, after: product });
      return product;
    });

    return jsonResponse({ updated: true, product });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
