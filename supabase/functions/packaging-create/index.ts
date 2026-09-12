// packaging.create — same near-duplicate discipline as cut_names/variations. Unlike those two,
// packaging is NOT scoped to a category (it's shared across every species), so the duplicate check
// runs against the whole table, not a category slice.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "name", "name_en"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, name, name_en, override_duplicate_check = false, idempotency_key = null } = body;

    if (idempotency_key) {
      const [existing] = await sql`select * from packaging where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ created: true, packaging: existing, idempotent_replay: true });
    }

    const all = await sql`select * from packaging`;
    const exactDuplicate = all.find((p: any) => normalize(p.name) === normalize(name) || normalize(p.name_en) === normalize(name_en));
    const nearDuplicates = all.filter((p: any) => isNearDuplicate(normalize(p.name), normalize(name)) || isNearDuplicate(normalize(p.name_en), normalize(name_en)));

    if (exactDuplicate) return jsonResponse({ created: true, packaging: exactDuplicate, idempotent_replay: true });

    if (nearDuplicates.length && !override_duplicate_check) {
      return duplicateResponse({
        message: "A similarly-named packaging type already exists — confirm this is genuinely different before creating it.",
        near_duplicate_names: nearDuplicates,
      });
    }

    const packaging = await sql.begin(async (tx) => {
      const [packaging] = await tx`insert into packaging (name, name_en, idempotency_key) values (${name}, ${name_en}, ${idempotency_key}) returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "packaging", record_id: packaging.id, after: packaging });
      return packaging;
    });

    return jsonResponse({ created: true, packaging }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
