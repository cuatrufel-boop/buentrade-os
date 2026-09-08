// shipments.applyPayment — Collections module. Real ask: "debe poderse impactar cada cliente
// cuando entre un pago si entra un pago por 50k deben poderse liberar en el sistema. para que ese
// cliente quede liberado para venta." A payment isn't always a clean match to one invoice — the
// user's own historical Excel has a "Balance Pending" column proving partial payments are real —
// so this applies one $ amount against a customer's open shipments oldest-invoice-first, same
// waterfall every real AR system uses, instead of a binary "mark this one paid" toggle.
// A shipment that reaches full payment gets finalized (interest/net_profit computed, credit-freed
// notification written) via the exact same finalizeShipmentPaid helper shipments-mark-paid uses —
// one real finalize path, not two.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog, finalizeShipmentPaid } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "customer_id", "amount"].filter((k) => body[k] == null);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, customer_id, amount, payment_method = null, payment_reference = null, idempotency_key = null } = body;

    if (Number(amount) <= 0) return jsonResponse({ error: "amount must be greater than 0" }, 400);

    // A double-click (or a retried network request) replays the exact same key — return what was
    // already applied instead of double-crediting the customer.
    if (idempotency_key) {
      const existing = await sql`select * from payment_applications where idempotency_key = ${idempotency_key}`;
      if (existing.length) return jsonResponse({ applied: true, idempotent_replay: true, applications: existing, unapplied_amount: 0 });
    }

    const [customer] = await sql`select id from customers where id = ${customer_id}`;
    if (!customer) return jsonResponse({ error: "unknown customer_id" }, 404);

    // Oldest invoice first — same rule every real AR waterfall uses. invoice_sent_at is "Fecha
    // Factura" in the user's own Excel; delivered_at covers the rare case a shipment somehow has
    // no logged invoice send yet.
    const openShipments = await sql`
      select * from shipments
      where customer_id = ${customer_id} and paid_at is null and (sale_amount - amount_paid) > 0
      order by coalesce(invoice_sent_at, delivered_at, created_at) asc
    `;

    const result = await sql.begin(async (tx) => {
      let remaining = Number(amount);
      const applications: Record<string, any>[] = [];
      const finalized: Record<string, any>[] = [];

      for (const shipment of openShipments) {
        if (remaining <= 0) break;
        const owed = Number(shipment.sale_amount) - Number(shipment.amount_paid);
        const applyAmount = Math.min(owed, remaining);
        if (applyAmount <= 0) continue;

        const newAmountPaid = Number(shipment.amount_paid) + applyAmount;
        const [updatedShipment] = await tx`
          update shipments set amount_paid = ${newAmountPaid}, updated_at = now() where id = ${shipment.id} returning *
        `;
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: shipment.id, before: shipment, after: updatedShipment });

        const [application] = await tx`
          insert into payment_applications (customer_id, shipment_id, order_number, amount_applied, payment_method, payment_reference, actor, idempotency_key)
          values (${customer_id}, ${shipment.id}, ${shipment.order_number}, ${applyAmount}, ${payment_method}, ${payment_reference}, ${actor}, ${idempotency_key ? `${idempotency_key}:${shipment.id}` : null})
          returning *
        `;
        applications.push(application);

        remaining -= applyAmount;

        if (newAmountPaid >= Number(shipment.sale_amount)) {
          const { shipment: finalShipment, notification } = await finalizeShipmentPaid(tx, updatedShipment, HMAC_SECRET, actor);
          finalized.push({ shipment: finalShipment, notification });
        }
      }

      return { applications, finalized, unapplied_amount: remaining };
    });

    return jsonResponse({ applied: true, applications: result.applications, finalized: result.finalized, unapplied_amount: result.unapplied_amount });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
