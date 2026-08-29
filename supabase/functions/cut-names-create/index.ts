// cut_names.create — same near-duplicate discipline as variations/brands. Requires both
// languages, same reasoning as variations.create. category_id is required (2026-08-29, real gap:
// Chicken products started going in and the Cut Name dropdown showed Pork cuts mixed in) — a cut
// name is scoped to one species, same as products/plants, so duplicate-checking and the dropdown
// itself both need to know which category a name belongs to.

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
      const [existing] = await sql`select * from cut_names where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ created: true, cut_name: existing, idempotent_replay: true });
    }

    const [category] = await sql`select id from categories where id = ${category_id}`;
    if (!category) return jsonResponse({ error: "unknown category_id" }, 400);

    const sameCategory = await sql`select * from cut_names where category_id = ${category_id}`;
    const exactDuplicate = sameCategory.find((c: any) => normalize(c.name_es) === normalize(name_es) || normalize(c.name_en) === normalize(name_en));
    const nearDuplicates = sameCategory.filter((c: any) => isNearDuplicate(normalize(c.name_es), normalize(name_es)) || isNearDuplicate(normalize(c.name_en), normalize(name_en)));

    if (exactDuplicate) return jsonResponse({ created: true, cut_name: exactDuplicate, idempotent_replay: true });

    if (nearDuplicates.length && !override_duplicate_check) {
      return duplicateResponse({
        message: "A similarly-named cut already exists in this category — confirm this is genuinely different before creating it.",
        near_duplicate_names: nearDuplicates,
      });
    }

    const cutName = await sql.begin(async (tx) => {
      const [cutName] = await tx`insert into cut_names (name_es, name_en, category_id, idempotency_key) values (${name_es}, ${name_en}, ${category_id}, ${idempotency_key}) returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "cut_names", record_id: cutName.id, after: cutName });
      return cutName;
    });

    return jsonResponse({ created: true, cut_name: cutName }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
