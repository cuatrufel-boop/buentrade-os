// shipments.markPaid — the exact moment credit gets freed up. "En el momento que el cliente paga
// el sistema debería liberar ese monto para venderle más y eso tiene que ser notificaciones
// importantes en el perfil de ese cliente" — so this writes a customer_notifications row, not just
// a timestamp, so it actually surfaces on the customer's profile, not just in shipment history.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });
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

    const result = await sql.begin(async (tx) => {
      const [updatedShipment] = await tx`
        update shipments set paid_at = now(), updated_at = now() where id = ${shipment_id} returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: shipment_id, before: shipment, after: updatedShipment });

      let notification = null;
      if (shipment.customer_id) {
        const [customer] = await tx`select credit_limit from customers where id = ${shipment.customer_id}`;
        const [{ outstanding }] = await tx`
          select coalesce(sum(sale_amount), 0) as outstanding from shipments
          where customer_id = ${shipment.customer_id} and paid_at is null
        `;
        const available = customer?.credit_limit != null ? Number(customer.credit_limit) - Number(outstanding) : null;
        const amountFmt = shipment.sale_amount != null ? `$${Number(shipment.sale_amount).toLocaleString()}` : "this order";
        const availableFmt = available != null ? ` Available credit now: $${available.toLocaleString()}.` : "";
        const [n] = await tx`
          insert into customer_notifications (customer_id, type, message)
          values (${shipment.customer_id}, 'payment_received', ${`Payment received for order ${shipment.order_number} (${amountFmt}) — credit freed up.` + availableFmt})
          returning *
        `;
        notification = n;
      }

      return { shipment: updatedShipment, notification };
    });

    return jsonResponse({ paid: true, shipment: result.shipment, notification: result.notification });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
