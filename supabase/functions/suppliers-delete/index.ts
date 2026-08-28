// suppliers.delete — same confirm-then-delete discipline as products/customers/providers.delete.
// Unlike those, this can genuinely fail: plants.supplier_id is `on delete restrict`, so the DB
// itself refuses to delete a supplier that still owns plants — reported here as a clear
// "still has plants" error instead of a raw Postgres constraint message, so the caller UI can show
// something a trader can act on ("delete or reassign its plants first").

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

    const [existing] = await sql`select * from suppliers where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown supplier id" }, 404);

    const plants = await sql`select id, name from plants where supplier_id = ${id}`;
    if (plants.length) {
      return jsonResponse({
        error: "supplier_has_plants",
        message: `This supplier still has ${plants.length} plant${plants.length === 1 ? "" : "s"} on file — delete or reassign ${plants.length === 1 ? "it" : "them"} first.`,
        plants,
      }, 409);
    }

    await sql.begin(async (tx) => {
      await tx`delete from suppliers where id = ${id}`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "delete", table_name: "suppliers", record_id: id, before: existing });
    });

    return jsonResponse({ deleted: true, id });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
