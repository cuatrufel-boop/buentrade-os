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
import { createClient } from "npm:@supabase/supabase-js@2";
// created only when an invoice PDF is uploaded (a module-level client made calls hang ~77 s)
let storageClient: any = null;
const storageFor = () => (storageClient ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } }).storage);

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;
const COLLECTION_ACCOUNTS = ["Buentrade", "Summar"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    if (body.kind === "surcharge") return await addSurcharge(body);
    if (body.kind === "invoice_create") return await invoiceCreate(body);
    if (body.kind === "invoice_note") return await invoiceNote(body);
    if (body.kind === "invoice_approve") return await invoiceApprove(body);
    if (body.kind === "flow_step") return await flowStep(body);
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
  if (kind === "freight" || kind === "customs") {
    // "tiene que cuadrar... hasta que podamos dar visto bueno y poder pagar": no approved invoice, no payment
    if (!body.invoice_id) return jsonResponse({ error: "a carrier / customs payment needs its approved invoice (invoice_id)" }, 400);
    const [inv] = await sql`select * from provider_invoices where id = ${body.invoice_id}`;
    if (!inv || inv.status !== "approved" || inv.kind !== kind) return jsonResponse({ error: "that invoice is not approved for this bill" }, 400);
    const covered = new Set((await sql`select shipment_id from provider_invoice_loads where invoice_id = ${inv.id}`).map((r: any) => r.shipment_id));
    if (ids.some((id: string) => !covered.has(id))) return jsonResponse({ error: "a load being paid is not on that invoice" }, 400);
  }
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
          (shipment_id, order_number, kind, direction, party_name, amount, settles, bank_entry_date, account, payment_method, payment_reference, payment_batch_id, actor, idempotency_key, invoice_id)
        values
          (${sh.id}, ${sh.order_number}, ${kind}, ${KINDS[kind]}, ${party_name}, ${Number(a.amount)}, ${a.settles}, ${bank_entry_date}, ${collection_account}, ${payment_method}, ${payment_reference}, ${batchId}, ${actor}, ${idempotency_key + ':' + sh.id}, ${body.invoice_id ?? null})
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
// cost_type is a closed list: the Trading Tool's own cost names (inspection + extra costs), or "Other" with a note.
const SURCHARGE_TYPES = ["Inspection — Cases", "Inspection — Combos", "Customs Processing", "US Warehouse Handling", "Lumper fee", "INBOND Release", "Labels", "Plastic wrap", "IN-LIEU",
  "Storage — Overnight", "Storage — Weekend", "Storage — Short term", "Storage — Mid term", "Storage — Long term", "Storage — Extra long",
  "Fresh to Frozen conversion", "Other"];
async function addSurcharge(body: Record<string, any>) {
  const { actor, order_number, payable_kind, cost_type, amount, notes = null, idempotency_key } = body;
  const missing = ["actor", "order_number", "payable_kind", "cost_type", "amount", "idempotency_key"].filter((k) => body[k] == null);
  if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
  if (!["freight", "customs"].includes(payable_kind)) return jsonResponse({ error: "payable_kind must be freight or customs" }, 400);
  if (!SURCHARGE_TYPES.includes(cost_type)) return jsonResponse({ error: "cost_type must be one of: " + SURCHARGE_TYPES.join(", ") }, 400);
  if (cost_type === "Other" && !(notes && String(notes).trim())) return jsonResponse({ error: "write what the Other surcharge is in notes" }, 400);
  // each charge belongs to one bill (user 2026-09-28): Lumper fee → carrier; every other named
  // charge (Storage included) → customs; "Other" can go on either bill
  const bill = cost_type === "Lumper fee" ? "freight" : cost_type === "Other" ? payable_kind : "customs";
  if (bill !== payable_kind) return jsonResponse({ error: `${cost_type} goes on the ${bill === "freight" ? "carrier" : "customs"} bill` }, 400);
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

// Pay & Receive flow steps that are not money (2026-09-28): the trader confirmed the load's real
// freight cost, or sent the customer the day-29 payment reminder. Once per load per step.
async function flowStep(body: Record<string, any>) {
  const { actor, order_number, step, detail = null, idempotency_key } = body;
  const missing = ["actor", "order_number", "step", "idempotency_key"].filter((k) => body[k] == null);
  if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
  if (!["freight_confirmed", "customs_confirmed", "customer_reminder_sent"].includes(step)) return jsonResponse({ error: "step must be freight_confirmed, customs_confirmed or customer_reminder_sent" }, 400);
  const [sh] = await sql`select id from shipments where order_number = ${order_number}`;
  if (!sh) return jsonResponse({ error: "unknown order_number" }, 404);
  const [done] = await sql`select * from shipment_flow_steps where shipment_id = ${sh.id} and step = ${step}`;
  if (done) return jsonResponse({ recorded: true, idempotent_replay: true, step: done });
  const row = await sql.begin(async (tx) => {
    const [r] = await tx`
      insert into shipment_flow_steps (shipment_id, step, actor, detail, idempotency_key)
      values (${sh.id}, ${step}, ${actor}, ${detail}, ${idempotency_key}) returning *
    `;
    await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "shipment_flow_steps", record_id: `${sh.id}:${step}`, before: null, after: r });
    return r;
  });
  return jsonResponse({ recorded: true, step: row });
}

// ============ Carrier / customs invoices (2026-09-28) ============
// Entered with number, total and PDF, linked to the loads it covers (one load when the provider is
// paid at delivery; the period's loads when paid at 30 days). Stays in_review — with the trader's
// call notes — until its total equals the sum of our bills for those loads; then approved.
async function invoiceCreate(body: Record<string, any>) {
  const { actor, payee_name, bill: kind, invoice_number, invoice_total, loads, file_name = null, file_base64 = null, content_type = null, idempotency_key } = body;
  const missing = ["actor", "payee_name", "bill", "invoice_number", "invoice_total", "loads", "idempotency_key"].filter((k) => body[k] == null || body[k] === "");
  if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
  if (!["customs", "freight"].includes(kind)) return jsonResponse({ error: "bill must be customs or freight" }, 400);
  if (!(Number(invoice_total) > 0)) return jsonResponse({ error: "invoice_total must be greater than 0" }, 400);
  if (!Array.isArray(loads) || !loads.length || loads.some((l: any) => !l.shipment_id || !(Number(l.amount) > 0))) return jsonResponse({ error: "loads must be a non-empty list of { shipment_id, amount > 0 }" }, 400);
  const [done] = await sql`select * from provider_invoices where idempotency_key = ${idempotency_key}`;
  if (done) return jsonResponse({ created: true, idempotent_replay: true, invoice: done });
  const taken = await sql`select l.shipment_id from provider_invoice_loads l join provider_invoices i on i.id = l.invoice_id where i.kind = ${kind} and l.shipment_id = any(${loads.map((l: any) => l.shipment_id)})`;
  if (taken.length) return jsonResponse({ error: "a selected load is already on another invoice for this bill" }, 400);
  let storagePath: string | null = null;
  if (file_base64) {
    let bytes: Uint8Array;
    try { bytes = Uint8Array.from(atob(file_base64), (c) => c.charCodeAt(0)); } catch { return jsonResponse({ error: "file_base64 is not valid base64" }, 400); }
    if (bytes.byteLength > 15 * 1024 * 1024) return jsonResponse({ error: "file_too_large", message: "Files must be 15MB or smaller." }, 400);
    storagePath = `${kind}/${crypto.randomUUID()}-${String(file_name || "invoice.pdf").replace(/[^A-Za-z0-9._-]/g, "_")}`;
    const { error } = await storageFor().from("provider-invoices").upload(storagePath, bytes, { contentType: content_type || "application/pdf" });
    if (error) return jsonResponse({ error: `storage upload failed: ${error.message}` }, 500);
  }
  const inv = await sql.begin(async (tx) => {
    const [i] = await tx`
      insert into provider_invoices (payee_name, kind, invoice_number, invoice_total, file_name, storage_path, created_by, idempotency_key)
      values (${payee_name}, ${kind}, ${String(invoice_number).trim()}, ${Number(invoice_total)}, ${file_name}, ${storagePath}, ${actor}, ${idempotency_key}) returning *
    `;
    for (const l of loads) await tx`insert into provider_invoice_loads (invoice_id, shipment_id, amount) values (${i.id}, ${l.shipment_id}, ${Number(l.amount)})`;
    await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "provider_invoices", record_id: i.id, before: null, after: { ...i, loads } });
    return i;
  });
  return jsonResponse({ created: true, invoice: inv });
}
async function invoiceNote(body: Record<string, any>) {
  const { actor, invoice_id, note, idempotency_key } = body;
  if (!actor || !invoice_id || !(note && String(note).trim()) || !idempotency_key) return jsonResponse({ error: "missing required fields: actor, invoice_id, note, idempotency_key" }, 400);
  const [done] = await sql`select * from provider_invoice_notes where idempotency_key = ${idempotency_key}`;
  if (done) return jsonResponse({ added: true, idempotent_replay: true, note: done });
  const [r] = await sql`insert into provider_invoice_notes (invoice_id, note, actor, idempotency_key) values (${invoice_id}, ${String(note).trim()}, ${actor}, ${idempotency_key}) returning *`;
  return jsonResponse({ added: true, note: r });
}
// approve only when it matches: the page sends the loads with our CURRENT bill amounts (charges may
// have been added while reviewing); they replace the stored ones and must add up to the invoice total
async function invoiceApprove(body: Record<string, any>) {
  const { actor, invoice_id, loads } = body;
  if (!actor || !invoice_id || !Array.isArray(loads) || !loads.length) return jsonResponse({ error: "missing required fields: actor, invoice_id, loads" }, 400);
  const [inv] = await sql`select * from provider_invoices where id = ${invoice_id}`;
  if (!inv) return jsonResponse({ error: "unknown invoice" }, 404);
  if (inv.status === "approved") return jsonResponse({ approved: true, idempotent_replay: true, invoice: inv });
  const ours = loads.reduce((n: number, l: any) => n + Number(l.amount), 0);
  if (Math.abs(ours - Number(inv.invoice_total)) > 0.005) return jsonResponse({ error: "does_not_match", message: `Invoice ${inv.invoice_number} is ${Number(inv.invoice_total).toFixed(2)}, our bills add up to ${ours.toFixed(2)}. It has to match before it can be approved.` }, 400);
  const out = await sql.begin(async (tx) => {
    await tx`delete from provider_invoice_loads where invoice_id = ${invoice_id}`;
    for (const l of loads) await tx`insert into provider_invoice_loads (invoice_id, shipment_id, amount) values (${invoice_id}, ${l.shipment_id}, ${Number(l.amount)})`;
    const [i] = await tx`update provider_invoices set status = 'approved', approved_by = ${actor}, approved_at = now() where id = ${invoice_id} returning *`;
    await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "provider_invoices", record_id: invoice_id, before: inv, after: i });
    return i;
  });
  return jsonResponse({ approved: true, invoice: out });
}

