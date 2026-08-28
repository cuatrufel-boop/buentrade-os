// providers.update — partial update, same duplicate discipline as providers.create, row excluded
// from its own comparison.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const UPDATABLE_FIELDS = [
  "name", "country", "city", "country_id", "city_id", "phone", "contact_name", "email", "email_cc", "whatsapp_cc", "notes",
  "mc_number", "dot_number",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, id, override_duplicate_check = false } = body;
    const [existing] = await sql`select * from providers where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown provider id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];

    const others = (await sql`select * from providers`).filter((p: any) => p.id !== id);
    const exactDuplicate = others.find((p: any) => normalize(p.name) === normalize(merged.name));
    const nearDuplicates = others.filter((p: any) => isNearDuplicate(normalize(p.name), normalize(merged.name)));

    if ((exactDuplicate || nearDuplicates.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "This edit would make it identical to another existing provider — confirm to see it or override to save anyway."
          : "Similar provider names already exist — confirm this is genuinely different before saving.",
        exact_match: exactDuplicate || null,
        near_duplicate_names: nearDuplicates,
      });
    }

    const provider = await sql.begin(async (tx) => {
      const [provider] = await tx`
        update providers set
          name = ${merged.name}, country = ${merged.country}, city = ${merged.city},
          country_id = ${merged.country_id}, city_id = ${merged.city_id}, phone = ${merged.phone},
          contact_name = ${merged.contact_name}, email = ${merged.email}, email_cc = ${merged.email_cc},
          whatsapp_cc = ${merged.whatsapp_cc}, notes = ${merged.notes},
          mc_number = ${merged.mc_number}, dot_number = ${merged.dot_number},
          updated_at = now()
        where id = ${id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "providers", record_id: id, before: existing, after: provider });
      return provider;
    });

    return jsonResponse({ updated: true, provider });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
