// sent_offers.delete — removes a single sent-offer record. Exists so a test/garbage row (or a
// genuine mis-send) can be cleared without it blocking products.delete's foreign key, since
// sent_offers.product_id has no ON DELETE CASCADE (a real historical send should never silently
// vanish just because the product it referenced got deleted — deleting the offer itself has to be
// its own explicit, audited action).

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

    const [existing] = await sql`select * from sent_offers where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown sent_offers id" }, 404);

    await sql.begin(async (tx) => {
      await tx`delete from sent_offers where id = ${id}`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "sent_offers", record_id: id, before: existing });
    });

    return jsonResponse({ deleted: true, id });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
