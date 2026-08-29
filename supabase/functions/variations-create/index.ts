// variations.create — same near-duplicate discipline as every other closed catalog (brands,
// suppliers, plants). Requires BOTH languages — a variation with only one language is exactly the
// silent gap rule 9 (catalog-matching) exists to catch, not something to allow here and patch later.
// category_id is required (2026-08-29, same real gap as cut_names): a variation term is scoped to
// one species — "Boneless" for Chicken and "Boneless" for Pork are tracked as separate catalog
// rows so the dropdown never mixes categories, even when the word is identical.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "name_es", "name_en", "category_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, name_es, name_en, category_id, override_duplicate_check = false, idempotency_key = null } = body;

    if (idempotency_key) {
      const [existing] = await sql`select * from variations where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ created: true, variation: existing, idempotent_replay: true });
    }

    const [category] = await sql`select id from categories where id = ${category_id}`;
    if (!category) return jsonResponse({ error: "unknown category_id" }, 400);

    const sameCategory = await sql`select * from variations where category_id = ${category_id}`;
    const exactDuplicate = sameCategory.find((v: any) => normalize(v.name_es) === normalize(name_es) || normalize(v.name_en) === normalize(name_en));
    const nearDuplicates = sameCategory.filter((v: any) => isNearDuplicate(normalize(v.name_es), normalize(name_es)) || isNearDuplicate(normalize(v.name_en), normalize(name_en)));

    if (exactDuplicate) return jsonResponse({ created: true, variation: exactDuplicate, idempotent_replay: true });

    if (nearDuplicates.length && !override_duplicate_check) {
      return duplicateResponse({
        message: "A similarly-named variation already exists in this category — confirm this is genuinely different before creating it.",
        near_duplicate_names: nearDuplicates,
      });
    }

    const variation = await sql.begin(async (tx) => {
      const [variation] = await tx`insert into variations (name_es, name_en, category_id, idempotency_key) values (${name_es}, ${name_en}, ${category_id}, ${idempotency_key}) returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "variations", record_id: variation.id, after: variation });
      return variation;
    });

    return jsonResponse({ created: true, variation }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
