// shipments.markPlantPaid — records that BuenTrade actually paid the PLANT for this load (never to
// be confused with shipments.paid_at, which is the CUSTOMER's payment to BuenTrade, used for
// credit-limit/collections). Real correction 2026-09-06: paying the plant and asking for the
// release number are two separate steps — the trader clicks "Confirmar pago enviado" in Orders
// right after actually sending the wire, which sends a real payment-confirmation email to the
// plant (same preview-before-send modal as every other document) and sets plant_paid_at here. Only
// once plant_paid_at is set does the separate release-number alert start firing — "el pago habilita
// a buentrade a pedir el release number."

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "order_number"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, order_number } = body;

    const [existing] = await sql`select * from shipments where order_number = ${order_number}`;
    if (!existing) return jsonResponse({ error: "unknown order_number" }, 404);

    const shipment = await sql.begin(async (tx) => {
      const [updated] = await tx`update shipments set plant_paid_at = now() where order_number = ${order_number} returning *`;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: existing.id, before: existing, after: updated });
      return updated;
    });

    return jsonResponse({ updated: true, shipment });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
