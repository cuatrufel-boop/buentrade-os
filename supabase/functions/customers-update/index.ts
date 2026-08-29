// customers.update — partial update, same duplicate discipline as customers.create, row excluded
// from its own comparison.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const UPDATABLE_FIELDS = [
  "trade_name", "legal_name", "country_id", "city_id", "state_id", "state", "address", "postal_code",
  "contact_name", "contact_role", "email", "email_cc", "phone", "whatsapp", "whatsapp_cc", "website", "notes",
  "preferred_currency_id", "usual_delivery_type", "usual_destination",
  "payment_days", "payment_method", "preferred_exchange_rate_mode",
  "payments_contact_name", "payments_contact_email", "payments_contact_phone", "payments_contact_whatsapp",
  "customs_agency_provider_id", "credit_limit", "usual_incoterm_text",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const { actor, id, override_duplicate_check = false } = body;
    const [existing] = await sql`select * from customers where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown customer id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];

    const others = (await sql`select * from customers`).filter((c: any) => c.id !== id);
    const exactDuplicate = others.find((c: any) => normalize(c.trade_name) === normalize(merged.trade_name));
    const nearDuplicates = others.filter((c: any) => isNearDuplicate(normalize(c.trade_name), normalize(merged.trade_name)));

    if ((exactDuplicate || nearDuplicates.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "This edit would make it identical to another existing customer — confirm to see it or override to save anyway."
          : "Similar customer names already exist — confirm this is genuinely different before saving.",
        exact_match: exactDuplicate || null,
        near_duplicate_names: nearDuplicates,
      });
    }

    const customer = await sql.begin(async (tx) => {
      const [customer] = await tx`
        update customers set
          trade_name = ${merged.trade_name}, legal_name = ${merged.legal_name},
          country_id = ${merged.country_id}, city_id = ${merged.city_id}, state_id = ${merged.state_id}, state = ${merged.state}, address = ${merged.address}, postal_code = ${merged.postal_code},
          contact_name = ${merged.contact_name}, contact_role = ${merged.contact_role},
          email = ${merged.email}, email_cc = ${merged.email_cc}, phone = ${merged.phone},
          whatsapp = ${merged.whatsapp}, whatsapp_cc = ${merged.whatsapp_cc}, website = ${merged.website}, notes = ${merged.notes},
          preferred_currency_id = ${merged.preferred_currency_id}, usual_delivery_type = ${merged.usual_delivery_type},
          usual_destination = ${merged.usual_destination}, payment_days = ${merged.payment_days},
          payment_method = ${merged.payment_method}, preferred_exchange_rate_mode = ${merged.preferred_exchange_rate_mode},
          payments_contact_name = ${merged.payments_contact_name}, payments_contact_email = ${merged.payments_contact_email},
          payments_contact_phone = ${merged.payments_contact_phone}, payments_contact_whatsapp = ${merged.payments_contact_whatsapp},
          customs_agency_provider_id = ${merged.customs_agency_provider_id}, credit_limit = ${merged.credit_limit},
          usual_incoterm_text = ${merged.usual_incoterm_text},
          updated_at = now()
        where id = ${id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "customers", record_id: id, before: existing, after: customer });
      return customer;
    });

    return jsonResponse({ updated: true, customer });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
