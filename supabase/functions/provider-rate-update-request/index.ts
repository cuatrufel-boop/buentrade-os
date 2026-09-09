// provider-rate-update-request — stamps providers.last_rate_update_requested_at so a carrier
// nobody's chased in a while looks different from one just asked today (same shape as
// plant_products.last_requested_at / "Ask Price"). Real fix 2026-09-10: this used to also send
// the actual email itself, via a backend Gmail API call — a real message going out from a server
// call the trader never saw or confirmed, and a different mechanism from every other contact point
// in this app (the WhatsApp/Email icon pair everywhere else just opens wa.me / a Gmail compose
// window and lets the trader review and send it themselves). The actual "asking" now happens
// through those same links (see providers.html's renderLocationsList) — this only ever records
// that it happened, never sends anything on its own.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "provider_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, provider_id } = body;

    const [existing] = await sql`select * from providers where id = ${provider_id}`;
    if (!existing) return jsonResponse({ error: "unknown provider id" }, 404);

    const updated = await sql.begin(async (tx) => {
      const [updated] = await tx`
        update providers set last_rate_update_requested_at = now()
        where id = ${provider_id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "providers", record_id: provider_id, before: existing, after: updated });
      return updated;
    });

    return jsonResponse({ requested: true, provider: updated });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
