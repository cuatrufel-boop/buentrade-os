// shipments.markPaid — the exact moment credit gets freed up. "En el momento que el cliente paga
// el sistema debería liberar ese monto para venderle más y eso tiene que ser notificaciones
// importantes en el perfil de ese cliente" — so this writes a customer_notifications row, not just
// a timestamp, so it actually surfaces on the customer's profile, not just in shipment history.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, finalizeShipmentPaid } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "shipment_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, shipment_id } = body;

    const [shipment] = await sql`select * from shipments where id = ${shipment_id}`;
    if (!shipment) return jsonResponse({ error: "unknown shipment_id" }, 404);
    if (shipment.paid_at) return jsonResponse({ already_paid: true, shipment }, 200);

    // Real ask 2026-09-08 (Collections): "calcules los intereses dependiendo del dia en que pago
    // la factura... numeros reales en el pnl" — marking a shipment paid is now the same real
    // finalize path Collections' own payment-application waterfall uses (shipments-apply-payment),
    // so this simple button also produces a real interest/net_profit number, not just a timestamp.
    const result = await sql.begin(async (tx) => finalizeShipmentPaid(tx, shipment, HMAC_SECRET, actor));

    return jsonResponse({ paid: true, shipment: result.shipment, notification: result.notification });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
