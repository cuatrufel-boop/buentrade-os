// shipments.applyPayment — Collections/Payments module. Real ask: "debe poderse impactar cada
// cliente cuando entre un pago si entra un pago por 50k deben poderse liberar en el sistema. para
// que ese cliente quede liberado para venta." A payment isn't always a clean match to one invoice —
// the user's own historical Excel has a "Balance Pending" column proving partial payments are
// real — so this applies one $ amount against a customer's open shipments, either automatically
// (oldest-invoice-first waterfall, unless the amount matches one open invoice exactly, in which case
// it goes to that invoice) or against a trader-specified split (`allocations`), same waterfall
// every real AR system uses, instead of a binary "mark this one paid" toggle.
// A shipment that reaches full payment gets finalized (interest/net_profit computed, credit-freed
// notification written) via the exact same finalizeShipmentPaid helper shipments-mark-paid uses —
// one real finalize path, not two.
// Real ask 2026-09-13: every payment now also records bank_entry_date (the date the money actually
// entered the bank, not the date it was applied in-system) and collection_account — a closed choice
// of the two real accounts money lands in, Buentrade or Summar. Both required going forward.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog, finalizeShipmentPaid } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const COLLECTION_ACCOUNTS = ["Buentrade", "Summar"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = ["actor", "customer_id", "amount", "bank_entry_date", "collection_account"].filter((k) => body[k] == null);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const {
      actor, customer_id, amount, payment_method = null, payment_reference = null, idempotency_key = null,
      bank_entry_date, collection_account, allocations = null,
    } = body;

    if (Number(amount) <= 0) return jsonResponse({ error: "amount must be greater than 0" }, 400);
    if (!COLLECTION_ACCOUNTS.includes(collection_account)) {
      return jsonResponse({ error: "collection_account must be one of: " + COLLECTION_ACCOUNTS.join(", ") }, 400);
    }
    if (allocations != null && (!Array.isArray(allocations) || allocations.some((a: any) => !a.shipment_id || !(Number(a.amount) > 0)))) {
      return jsonResponse({ error: "allocations must be a list of { shipment_id, amount > 0 }" }, 400);
    }

    // A double-click (or a retried network request) replays the exact same key — return what was
    // already applied instead of double-crediting the customer.
    if (idempotency_key) {
      const existing = await sql`select * from payment_applications where idempotency_key = ${idempotency_key} or idempotency_key like ${idempotency_key + ':%'}`;
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

    // Build the plan: either the trader's explicit split (allocations), or the automatic rule —
    // "si el pago es exacto se aplica a esa factura, si es parcial se aplica a la mas vieja": an
    // amount matching one open invoice's balance exactly goes straight to that invoice regardless
    // of age; otherwise it waterfalls oldest-first.
    let plan: { shipment: Record<string, any>; applyAmount: number }[] = [];
    if (allocations) {
      const byId = new Map(openShipments.map((s: Record<string, any>) => [s.id, s]));
      for (const a of allocations) {
        const shipment = byId.get(a.shipment_id);
        if (!shipment) return jsonResponse({ error: `shipment ${a.shipment_id} is not an open invoice for this customer` }, 400);
        const owed = Number(shipment.sale_amount) - Number(shipment.amount_paid);
        if (Number(a.amount) > owed + 0.01) return jsonResponse({ error: `allocation for ${shipment.order_number} ($${a.amount}) exceeds its balance ($${owed})` }, 400);
        plan.push({ shipment, applyAmount: Number(a.amount) });
      }
      const totalPlanned = plan.reduce((sum, p) => sum + p.applyAmount, 0);
      if (totalPlanned > Number(amount) + 0.01) return jsonResponse({ error: "allocations exceed the payment amount" }, 400);
    } else {
      const exactMatch = openShipments.find((s: Record<string, any>) => Math.abs((Number(s.sale_amount) - Number(s.amount_paid)) - Number(amount)) < 0.01);
      const ordered = exactMatch ? [exactMatch, ...openShipments.filter((s: Record<string, any>) => s.id !== exactMatch.id)] : openShipments;
      let remaining = Number(amount);
      for (const shipment of ordered) {
        if (remaining <= 0) break;
        const owed = Number(shipment.sale_amount) - Number(shipment.amount_paid);
        const applyAmount = Math.min(owed, remaining);
        if (applyAmount <= 0) continue;
        plan.push({ shipment, applyAmount });
        remaining -= applyAmount;
      }
    }

    const paymentBatchId = crypto.randomUUID();

    const result = await sql.begin(async (tx) => {
      let totalApplied = 0;
      const applications: Record<string, any>[] = [];
      const finalized: Record<string, any>[] = [];

      for (const { shipment, applyAmount } of plan) {
        const newAmountPaid = Number(shipment.amount_paid) + applyAmount;
        const [updatedShipment] = await tx`
          update shipments set amount_paid = ${newAmountPaid}, updated_at = now() where id = ${shipment.id} returning *
        `;
        await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "shipments", record_id: shipment.id, before: shipment, after: updatedShipment });

        const [application] = await tx`
          insert into payment_applications
            (customer_id, shipment_id, order_number, amount_applied, payment_method, payment_reference, actor, idempotency_key, payment_batch_id, bank_entry_date, collection_account)
          values
            (${customer_id}, ${shipment.id}, ${shipment.order_number}, ${applyAmount}, ${payment_method}, ${payment_reference}, ${actor}, ${idempotency_key ? `${idempotency_key}:${shipment.id}` : null}, ${paymentBatchId}, ${bank_entry_date}, ${collection_account})
          returning *
        `;
        applications.push(application);

        totalApplied += applyAmount;

        if (newAmountPaid >= Number(shipment.sale_amount)) {
          const { shipment: finalShipment, notification } = await finalizeShipmentPaid(tx, updatedShipment, HMAC_SECRET, actor);
          finalized.push({ shipment: finalShipment, notification });
        }
      }

      return { applications, finalized, unapplied_amount: Number(amount) - totalApplied };
    });

    return jsonResponse({ applied: true, applications: result.applications, finalized: result.finalized, unapplied_amount: result.unapplied_amount, payment_batch_id: paymentBatchId });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
