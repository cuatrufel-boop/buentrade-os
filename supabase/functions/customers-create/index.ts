// customers.create — the only way a new customer row gets inserted. Same discipline as
// suppliers.create/plants.create/products.create — [[feedback_never_duplicate_master_data]] names
// customers explicitly as covered by the same rule, after a real incident ("La Blanquita" existed
// twice under slightly different wording). Near-duplicate check on trade_name, never a dead-end
// block, override required to proceed past a real warning, every write hash-chained.

import postgres from "npm:postgres@3.4.4";
import { duplicateResponse, isNearDuplicate, jsonResponse, normalize, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "trade_name"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const {
      actor, trade_name, legal_name = null, country_id = null, city_id = null, state = null, address = null,
      contact_name = null, contact_role = null, email = null, email_cc = null,
      phone = null, whatsapp = null, whatsapp_cc = null, website = null, notes = null,
      preferred_currency_id = null, usual_delivery_type = null, usual_destination = null,
      payment_days = null, payment_method = null, preferred_exchange_rate_mode = null,
      payments_contact_name = null, payments_contact_email = null, payments_contact_phone = null,
      payments_contact_whatsapp = null, customs_agency_provider_id = null, credit_limit = null,
      override_duplicate_check = false,
    } = body;

    const allCustomers = await sql`select * from customers`;

    const exactDuplicate = allCustomers.find((c: any) => normalize(c.trade_name) === normalize(trade_name));
    const nearDuplicates = allCustomers.filter((c: any) => isNearDuplicate(normalize(c.trade_name), normalize(trade_name)));

    if ((exactDuplicate || nearDuplicates.length) && !override_duplicate_check) {
      return duplicateResponse({
        message: exactDuplicate
          ? "A customer with this exact trade name already exists — confirm to see it or override to create a separate row anyway."
          : "Similar customer names already exist — confirm this is genuinely different before creating it.",
        exact_match: exactDuplicate || null,
        near_duplicate_names: nearDuplicates,
      });
    }

    if (country_id) {
      const [country] = await sql`select id from countries where id = ${country_id}`;
      if (!country) return jsonResponse({ error: "unknown country_id" }, 400);
    }
    if (city_id) {
      const [city] = await sql`select id from cities where id = ${city_id}`;
      if (!city) return jsonResponse({ error: "unknown city_id" }, 400);
    }

    const customer = await sql.begin(async (tx) => {
      const [customer] = await tx`
        insert into customers (
          trade_name, legal_name, country_id, city_id, state, address,
          contact_name, contact_role, email, email_cc, phone, whatsapp, whatsapp_cc, website, notes,
          preferred_currency_id, usual_delivery_type, usual_destination,
          payment_days, payment_method, preferred_exchange_rate_mode,
          payments_contact_name, payments_contact_email, payments_contact_phone, payments_contact_whatsapp,
          customs_agency_provider_id, credit_limit
        ) values (
          ${trade_name}, ${legal_name}, ${country_id}, ${city_id}, ${state}, ${address},
          ${contact_name}, ${contact_role}, ${email}, ${email_cc}, ${phone}, ${whatsapp}, ${whatsapp_cc}, ${website}, ${notes},
          ${preferred_currency_id}, ${usual_delivery_type}, ${usual_destination},
          ${payment_days}, ${payment_method}, ${preferred_exchange_rate_mode},
          ${payments_contact_name}, ${payments_contact_email}, ${payments_contact_phone}, ${payments_contact_whatsapp},
          ${customs_agency_provider_id}, ${credit_limit}
        ) returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "customers", record_id: customer.id, after: customer });
      return customer;
    });

    return jsonResponse({ created: true, customer }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
