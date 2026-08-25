// products.create — the ONLY way a new product row can ever be inserted. Enforces rules 1, 5, 6,
// 9, 13, 14, 16 from the permanent business-rules memory (feedback-catalog-matching-is-the-core-
// system): never auto-create without an explicit override once a real or near-duplicate is found,
// NEVER a dead-end block even for the most obvious case-only duplicate, a typo check on both name
// and subcategory (never built before — this is where it finally lives), never auto-correct (a
// near-duplicate is reported, never silently renamed/merged), a product must arrive as a complete
// profile (category/temperature/packaging/full names all required, subcategory must be an
// explicit choice — null is allowed, omission is not), and correctness enforced here, at the
// write boundary, not patched later.
//
// Every successful insert writes one hash-chained row to audit_log in the SAME transaction — a
// product that exists but has no audit trail, or an audit entry with no product, are both
// impossible by construction, not by convention.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, normalizeLoose, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const REQUIRED_FIELDS = [
  "actor", "name", "name_en", "category_id", "temperature_id", "packaging_id",
  "full_name_en", "full_name_es",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();

    // Rule 14 — a product is a complete profile or it doesn't get created at all. subcategory is
    // required as an explicit key (null is a real answer — "genuinely no subcategory" — omission
    // is not, since that's usually just a caller that forgot to ask).
    const missing = REQUIRED_FIELDS.filter((k) => body[k] == null || body[k] === "");
    if (!("subcategory" in body)) missing.push("subcategory (pass null explicitly if there is none)");
    if (!("subcategory_en" in body)) missing.push("subcategory_en (pass null explicitly if there is none)");
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const {
      actor, name, name_en, category_id, subcategory, subcategory_en,
      temperature_id, packaging_id, full_name_en, full_name_es,
      brand = null, unit_id = null, standard_weight = null, presentation = null, origin = null,
      documents_included = null, documents_excluded = null, commercial_notes = null,
      photo_url = null, spec_url = null,
      override_duplicate_check = false,
    } = body;

    const [category] = await sql`select id from categories where id = ${category_id}`;
    if (!category) return jsonResponse({ error: "unknown category_id" }, 400);

    const sameCategoryProducts = await sql`select * from products where category_id = ${category_id}`;

    // Rule 5 — NEVER a dead-end block, not even for the most obvious case (identical in every
    // field). An earlier version of this refused unconditionally here, with no override — caught
    // live (2026-08-25): "bloquear, preguntar y confirmar con los productos que se le parece eso
    // es distinto" (blocking, and asking-with-real-options, are not the same thing — never the
    // first one). Every duplicate case below — exact or near — goes through the SAME path: show
    // what already exists, require an explicit override to proceed anyway.
    const exactDuplicate = sameCategoryProducts.find((p: any) =>
      normalizeLoose(p.name_en) === normalizeLoose(name_en) &&
      p.temperature_id === temperature_id &&
      p.packaging_id === packaging_id &&
      normalize(p.subcategory_en) === normalize(subcategory_en)
    );

    const sameSpecDifferentSubcat = sameCategoryProducts.filter((p: any) =>
      normalizeLoose(p.name_en) === normalizeLoose(name_en) &&
      p.temperature_id === temperature_id &&
      p.packaging_id === packaging_id
    );

    const nearDuplicates = sameCategoryProducts.filter((p: any) =>
      isNearDuplicate(normalizeLoose(p.name_en), normalizeLoose(name_en)) ||
      isNearDuplicate(normalize(p.name), normalize(name))
    );

    // Rule 13 — subcategory gets the exact same typo/duplicate scrutiny as the name, scoped to
    // the SAME base cut (same loose name + category) — a subcategory value is only suspicious
    // relative to its own product family.
    const subcategorySiblings = sameCategoryProducts.filter((p: any) =>
      normalizeLoose(p.name_en) === normalizeLoose(name_en) && p.subcategory_en
    );
    const subcategoryTypoConflicts = subcategory_en
      ? subcategorySiblings.filter((p: any) =>
          p.subcategory_en !== subcategory_en && (
            normalize(p.subcategory_en) === normalize(subcategory_en) ||
            isNearDuplicate(normalize(p.subcategory_en), normalize(subcategory_en))
          )
        )
      : [];

    if ((exactDuplicate || sameSpecDifferentSubcat.length || nearDuplicates.length || subcategoryTypoConflicts.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "This exact product already exists — almost certainly the same one, confirm to see it or override to create a separate row anyway."
          : "Similar products already exist — confirm this is genuinely different before creating it.",
        exact_match: exactDuplicate || null,
        same_spec_different_subcategory: sameSpecDifferentSubcat,
        near_duplicate_names: nearDuplicates,
        subcategory_typo_conflicts: subcategoryTypoConflicts,
      });
    }

    const [temperature] = await sql`select id from temperature where id = ${temperature_id}`;
    const [packaging] = await sql`select id from packaging where id = ${packaging_id}`;
    if (!temperature || !packaging) return jsonResponse({ error: "unknown temperature_id or packaging_id" }, 400);

    const product = await sql.begin(async (tx) => {
      const [product] = await tx`
        insert into products (
          category, category_id, name, name_en, subcategory, subcategory_en,
          temperature_id, packaging_id, full_name_en, full_name_es, brand,
          unit_id, standard_weight, presentation, origin,
          documents_included, documents_excluded, commercial_notes, photo_url, spec_url
        ) values (
          (select name from categories where id = ${category_id}), ${category_id}, ${name}, ${name_en}, ${subcategory}, ${subcategory_en},
          ${temperature_id}, ${packaging_id}, ${full_name_en}, ${full_name_es}, ${brand},
          ${unit_id}, ${standard_weight}, ${presentation}, ${origin},
          ${documents_included}, ${documents_excluded}, ${commercial_notes}, ${photo_url}, ${spec_url}
        ) returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "products", record_id: product.id, after: product });
      return product;
    });

    return jsonResponse({ created: true, product }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
