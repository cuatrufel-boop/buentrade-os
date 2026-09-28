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
    if (body.kind === "surcharge") return await addSurcharge(body);
    if (body.kind && body.kind !== "customer") return await recordMoney(body);
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
        -- Pay & Receive 2026-09-28: a Summar-financed load is paid by the customer TO SUMMAR, never
        -- to us — it can never be one of "this customer's open invoices" for a payment we received.
        and not exists (select 1 from purchase_orders po where po.order_number = shipments.order_number and po.financing_method = 'summar')
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

// Pay & Receive (2026-09-28): the load money that is not a customer invoice — freight and customs
// we pay at delivery, the Summar remanente Summar pays us at delivery. One bank movement can cover
// several loads (allocations), exactly like a customer payment; each slice is one
// shipment_money_records row, all sharing one payment_batch_id. The page computes the split and
// shows it before saving; this only validates and stores it.
// client_paid_summar (2026-09-28): the customer paid SUMMAR for a Summar load — never our bank,
// recorded so the load closes and the real Summar fee (days from delivery) is known.
const KINDS: Record<string, "in" | "out" | "watch"> = { freight: "out", customs: "out", summar_remanente: "in", client_paid_summar: "watch" };
async function recordMoney(body: Record<string, any>) {
  const { actor, kind, party_name = null, bank_entry_date, collection_account, payment_method = null, payment_reference = null, idempotency_key, allocations } = body;
  const missing = ["actor", "kind", "bank_entry_date", "collection_account", "idempotency_key", "allocations"].filter((k) => body[k] == null);
  if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
  if (!KINDS[kind]) return jsonResponse({ error: "kind must be one of: customer, " + Object.keys(KINDS).join(", ") }, 400);
  if (!COLLECTION_ACCOUNTS.includes(collection_account)) return jsonResponse({ error: "collection_account must be one of: " + COLLECTION_ACCOUNTS.join(", ") }, 400);
  if (!Array.isArray(allocations) || !allocations.length || allocations.some((a: any) => !a.shipment_id || !(Number(a.amount) > 0) || typeof a.settles !== "boolean")) {
    return jsonResponse({ error: "allocations must be a non-empty list of { shipment_id, amount > 0, settles: true|false }" }, 400);
  }

  const existing = await sql`select * from shipment_money_records where idempotency_key like ${idempotency_key + ':%'}`;
  if (existing.length) return jsonResponse({ recorded: true, idempotent_replay: true, records: existing });

  const ids = allocations.map((a: any) => a.shipment_id);
  const ships = await sql`
    select sh.id, sh.order_number, po.financing_method from shipments sh
    left join purchase_orders po on po.order_number = sh.order_number where sh.id = any(${ids})
  `;
  const byId = new Map(ships.map((r: Record<string, any>) => [r.id, r]));
  for (const a of allocations) {
    const sh = byId.get(a.shipment_id);
    if (!sh) return jsonResponse({ error: `unknown shipment ${a.shipment_id}` }, 400);
    if ((kind === "summar_remanente" || kind === "client_paid_summar") && sh.financing_method !== "summar") return jsonResponse({ error: `${sh.order_number} is not a Summar load` }, 400);
  }

  const batchId = crypto.randomUUID();
  const records = await sql.begin(async (tx) => {
    const out: Record<string, any>[] = [];
    for (const a of allocations) {
      const sh = byId.get(a.shipment_id);
      const [row] = await tx`
        insert into shipment_money_records
          (shipment_id, order_number, kind, direction, party_name, amount, settles, bank_entry_date, account, payment_method, payment_reference, payment_batch_id, actor, idempotency_key)
        values
          (${sh.id}, ${sh.order_number}, ${kind}, ${KINDS[kind]}, ${party_name}, ${Number(a.amount)}, ${a.settles}, ${bank_entry_date}, ${collection_account}, ${payment_method}, ${payment_reference}, ${batchId}, ${actor}, ${idempotency_key + ':' + sh.id})
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "shipment_money_records", record_id: row.id, before: null, after: row });
      out.push(row);
    }
    return out;
  });
  return jsonResponse({ recorded: true, records, payment_batch_id: batchId });
}

// Pay & Receive surcharges (2026-09-28, "si los fletes de cada carga tuvieron sobrecostos debo
// poder adherirlos y saber al final del corte cuanto se le paga... igual que aduanas"): one
// order_extra_costs row on the load (so profit already counts it, like every extra cost) marked
// with the bill it belongs to — the carrier's freight bill or the customs bill.
// cost_type is a closed list: the Trading Tool's own extra-cost names, or "Other" with a note.
const SURCHARGE_TYPES = ["Customs Processing", "US Warehouse Handling", "Lumper fee", "INBOND Release", "Labels", "Plastic wrap", "IN-LIEU",
  "Storage — Overnight", "Storage — Weekend", "Storage — Short term", "Storage — Mid term", "Storage — Long term", "Storage — Extra long",
  "Fresh to Frozen conversion", "Other"];
async function addSurcharge(body: Record<string, any>) {
  const { actor, order_number, payable_kind, cost_type, amount, notes = null, idempotency_key } = body;
  const missing = ["actor", "order_number", "payable_kind", "cost_type", "amount", "idempotency_key"].filter((k) => body[k] == null);
  if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
  if (!["freight", "customs"].includes(payable_kind)) return jsonResponse({ error: "payable_kind must be freight or customs" }, 400);
  if (!SURCHARGE_TYPES.includes(cost_type)) return jsonResponse({ error: "cost_type must be one of: " + SURCHARGE_TYPES.join(", ") }, 400);
  if (cost_type === "Other" && !(notes && String(notes).trim())) return jsonResponse({ error: "write what the Other surcharge is in notes" }, 400);
  if (!(Number(amount) > 0)) return jsonResponse({ error: "amount must be greater than 0" }, 400);
  const [done] = await sql`select * from order_extra_costs where idempotency_key = ${idempotency_key}`;
  if (done) return jsonResponse({ added: true, idempotent_replay: true, surcharge: done });
  const [sh] = await sql`select sh.order_number, sh.sent_offer_id from shipments sh where sh.order_number = ${order_number}`;
  if (!sh) return jsonResponse({ error: "unknown order_number" }, 404);
  const row = await sql.begin(async (tx) => {
    const [r] = await tx`
      insert into order_extra_costs (order_number, sent_offer_id, cost_type, amount, notes, payable_kind, actor, idempotency_key)
      values (${sh.order_number}, ${sh.sent_offer_id}, ${cost_type}, ${Number(amount)}, ${notes}, ${payable_kind}, ${actor}, ${idempotency_key})
      returning *
    `;
    await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "order_extra_costs", record_id: r.id, before: null, after: r });
    return r;
  });
  return jsonResponse({ added: true, surcharge: row });
}

