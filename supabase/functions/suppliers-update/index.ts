// suppliers.update — partial update, same duplicate discipline as suppliers.create, with the row
// being edited excluded from its own comparison (see products.update for the full reasoning).

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const UPDATABLE_FIELDS = [
  "name", "country_id", "city_id", "state", "contact_name", "email", "phone", "website",
  "notes", "avg_response_time", "payment_terms", "required_documentation",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, id, override_duplicate_check = false } = body;
    const [existing] = await sql`select * from suppliers where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown supplier id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];

    const others = (await sql`select * from suppliers`).filter((s: any) => s.id !== id);
    const exactDuplicate = others.find((s: any) => normalize(s.name) === normalize(merged.name));
    const nearDuplicates = others.filter((s: any) => isNearDuplicate(normalize(s.name), normalize(merged.name)));

    if ((exactDuplicate || nearDuplicates.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "This edit would make it identical to another existing supplier — confirm to see it or override to save anyway."
          : "This edit would make it similar to other existing suppliers — confirm this is genuinely different before saving.",
        exact_match: exactDuplicate || null,
        near_duplicate_names: nearDuplicates,
      });
    }

    const supplier = await sql.begin(async (tx) => {
      const [supplier] = await tx`
        update suppliers set
          name = ${merged.name}, country_id = ${merged.country_id}, city_id = ${merged.city_id}, state = ${merged.state},
          contact_name = ${merged.contact_name}, email = ${merged.email}, phone = ${merged.phone}, website = ${merged.website},
          notes = ${merged.notes}, avg_response_time = ${merged.avg_response_time},
          payment_terms = ${merged.payment_terms}, required_documentation = ${merged.required_documentation},
          updated_at = now()
        where id = ${id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "suppliers", record_id: id, before: existing, after: supplier });
      return supplier;
    });

    return jsonResponse({ updated: true, supplier });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
