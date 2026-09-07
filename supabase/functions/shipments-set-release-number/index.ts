// shipments.setReleaseNumber — records the actual release number text the plant gave BuenTrade
// once payment was confirmed. Real gap found live 2026-09-07: the plant-payment email already asks
// for the RELEASE NUMBER, and a separate alert already reminds the trader to go get it
// (release_number_alert_sent_at), but there was never anywhere to record the value itself once the
// plant actually replies with it — this is that missing write, mirroring shipments-mark-plant-paid's
// same simple update-and-audit-log shape (no insert, so exempt from the idempotency-key rule).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "order_number", "release_number"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, order_number, release_number } = body;

    const [existing] = await sql`select * from shipments where order_number = ${order_number}`;
    if (!existing) return jsonResponse({ error: "unknown order_number" }, 404);

    const shipment = await sql.begin(async (tx) => {
      const [updated] = await tx`update shipments set release_number = ${release_number} where order_number = ${order_number} returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: existing.id, before: existing, after: updated });
      return updated;
    });

    return jsonResponse({ updated: true, shipment });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
