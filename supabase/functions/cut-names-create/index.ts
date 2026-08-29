// cut_names.create — same near-duplicate discipline as variations/brands. Requires both
// languages, same reasoning as variations.create.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "name_es", "name_en"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, name_es, name_en, override_duplicate_check = false, idempotency_key = null } = body;

    if (idempotency_key) {
      const [existing] = await sql`select * from cut_names where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ created: true, cut_name: existing, idempotent_replay: true });
    }

    const all = await sql`select * from cut_names`;
    const exactDuplicate = all.find((c: any) => normalize(c.name_es) === normalize(name_es) || normalize(c.name_en) === normalize(name_en));
    const nearDuplicates = all.filter((c: any) => isNearDuplicate(normalize(c.name_es), normalize(name_es)) || isNearDuplicate(normalize(c.name_en), normalize(name_en)));

    if (exactDuplicate) return jsonResponse({ created: true, cut_name: exactDuplicate, idempotent_replay: true });

    if (nearDuplicates.length && !override_duplicate_check) {
      return duplicateResponse({
        message: "A similarly-named cut already exists — confirm this is genuinely different before creating it.",
        near_duplicate_names: nearDuplicates,
      });
    }

    const cutName = await sql.begin(async (tx) => {
      const [cutName] = await tx`insert into cut_names (name_es, name_en, idempotency_key) values (${name_es}, ${name_en}, ${idempotency_key}) returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "cut_names", record_id: cutName.id, after: cutName });
      return cutName;
    });

    return jsonResponse({ created: true, cut_name: cutName }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
