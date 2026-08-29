// brands.create — same near-duplicate discipline as every other closed catalog in this system
// (suppliers/customers/plants). A brand picker still needs a way to add a genuinely new brand —
// this just makes sure "Tyson" and "Tysone" don't end up as two separate rows.

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
    const { actor, name, override_duplicate_check = false, idempotency_key = null } = body;

    if (idempotency_key) {
      const [existing] = await sql`select * from brands where idempotency_key = ${idempotency_key}`;
      if (existing) return jsonResponse({ created: true, brand: existing, idempotent_replay: true });
    }

    const allBrands = await sql`select * from brands`;
    const exactDuplicate = allBrands.find((b: any) => normalize(b.name) === normalize(name));
    const nearDuplicates = allBrands.filter((b: any) => isNearDuplicate(normalize(b.name), normalize(name)));

    if (exactDuplicate) return jsonResponse({ created: true, brand: exactDuplicate, idempotent_replay: true });

    if (nearDuplicates.length && !override_duplicate_check) {
      return duplicateResponse({
        message: "A similarly-named brand already exists — confirm this is genuinely different before creating it.",
        near_duplicate_names: nearDuplicates,
      });
    }

    const brand = await sql.begin(async (tx) => {
      const [brand] = await tx`insert into brands (name, idempotency_key) values (${name}, ${idempotency_key}) returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "brands", record_id: brand.id, after: brand });
      return brand;
    });

    return jsonResponse({ created: true, brand }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
