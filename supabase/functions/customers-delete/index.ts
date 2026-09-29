// customers.delete — matches production's real-delete-after-confirm pattern, audit-logged so the
// deleted row's full data survives in audit_log even though the live table no longer has it.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from customers where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown customer id" }, 404);
    // 2026-09-29 (user): a customer with real activity is never deleted — only one created by mistake
    const [use] = await sql`select
      (select count(*) from shipments where customer_id = ${id})::int as loads,
      (select count(*) from sent_offers where customer_id = ${id})::int as offers,
      (select count(*) from payment_applications where customer_id = ${id})::int as payments`;
    if (use.loads || use.offers || use.payments) return jsonResponse({ error: "in_use", message: `This customer has ${use.loads} load(s), ${use.offers} offer(s) and ${use.payments} payment(s) — it can't be deleted.` }, 409);

    await sql.begin(async (tx) => {
      await tx`delete from customers where id = ${id}`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "customers", record_id: id, before: existing });
    });

    return jsonResponse({ deleted: true, id });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
