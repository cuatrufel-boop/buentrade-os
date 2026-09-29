// order-documents-history — every movement of every load, on the profile it concerns.
// 2026-09-14: "en el momento en el que creo PO SO FO INV debe alojarse en el perfil de cada
// destinatario" (documents). 2026-09-29: "deberían quedar todos los movimientos hechos con la carga,
// lo que incumbe a cada perfil, en orden de fecha... si hay que buscar, poder encontrarlo fácil y
// contrastar con facturas" — so the same endpoint now returns documents, flow steps, surcharges,
// provider invoices (with their call notes and PDF), and every payment, newest first.
// One shared endpoint instead of one per profile (function cap — [[project_supabase_function_cap]]).
//
//   entity_type customer → its SO / invoice / signature / reminders / payments received
//   entity_type plant    → its PO / plant payment / pick up
//   entity_type provider → as carrier: FO, release #, pick up / delivery, freight bill, surcharges,
//                          invoices, payments; as customs agency: docs sent, customs bill,
//                          surcharges, invoices, payments (a provider can be both)
//
// Each movement: { at, order_number, shipment_id, kind: document|step|charge|invoice|payment,
// label, amount, ref, doc (PO/SO/FO/INV — opens that PDF), file_url (provider invoice PDF) }.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
// created only when an invoice PDF needs a signed link (a module-level client made calls hang ~77 s)
let storageClient: any = null;
const storageFor = () => (storageClient ??= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } }).storage);

type M = { at: string | Date | null; order_number: string | null; shipment_id: string | null; kind: string; label: string; amount: number | null; ref: string | null; doc: string | null; file_url?: string | null };
const mv = (at: any, sh: any, kind: string, label: string, amount: number | null = null, ref: string | null = null, doc: string | null = null): M =>
  ({ at, order_number: sh.order_number ?? null, shipment_id: sh.id ?? sh.shipment_id ?? null, kind, label, amount: amount == null ? null : Number(amount), ref, doc });

async function customer(id: string): Promise<M[]> {
  const loads = await sql`select sh.id, sh.order_number, sh.so_sent_at, sh.invoice_sent_at, sh.delivered_at, sh.invoice_signed_at, sh.invoice_signed_by, sh.sale_amount, so.created_at as so_created_at, so.total_sale
    from shipments sh left join sales_orders so on so.order_number = sh.order_number where sh.customer_id = ${id}`;
  const ids = loads.map((l: any) => l.id), out: M[] = [];
  for (const l of loads) {
    if (l.so_created_at && !l.so_sent_at) out.push(mv(l.so_created_at, l, "document", "SO created · not sent", l.total_sale));
    if (l.so_sent_at) out.push(mv(l.so_sent_at, l, "document", "SO sent", l.total_sale, null, "SO"));
    if (l.delivered_at) out.push(mv(l.delivered_at, l, "step", "Delivered"));
    if (l.invoice_sent_at) out.push(mv(l.invoice_sent_at, l, "document", "Invoice sent", l.sale_amount, null, "INV"));
    if (l.invoice_signed_at) out.push(mv(l.invoice_signed_at, l, "document", "Invoice signed", l.sale_amount, l.invoice_signed_by, "INV"));
  }
  if (!ids.length) return out;
  for (const f of await sql`select shipment_id, done_at from shipment_flow_steps where step = 'customer_reminder_sent' and shipment_id = any(${ids})`)
    out.push(mv(f.done_at, { ...f, order_number: loads.find((l: any) => l.id === f.shipment_id)?.order_number }, "step", "Payment reminder sent"));
  for (const p of await sql`select pa.*, sh.delivered_at from payment_applications pa left join shipments sh on sh.id = pa.shipment_id where pa.customer_id = ${id}`) {
    const d = p.bank_entry_date && p.delivered_at ? Math.round((new Date(p.bank_entry_date).getTime() - new Date(new Date(p.delivered_at).toISOString().slice(0, 10)).getTime()) / 86400000) : null;
    out.push(mv(p.bank_entry_date ?? p.applied_at, p, "payment", d == null ? "Payment received" : `Payment received · ${d} days after delivery`, p.amount_applied, [p.payment_method, p.payment_reference].filter(Boolean).join(" · ") || null));
  }
  for (const r of await sql`select * from shipment_money_records where kind = 'client_paid_summar' and shipment_id = any(${ids})`)
    out.push(mv(r.bank_entry_date, r, "payment", "Paid Summar", r.amount, r.payment_reference));
  return out;
}

async function plant(id: string): Promise<M[]> {
  const out: M[] = [];
  for (const l of await sql`select sh.id, po.order_number, po.created_at, po.total_cost, sh.po_sent_at, sh.plant_paid_at, sh.picked_up_at
      from purchase_orders po left join shipments sh on sh.order_number = po.order_number where po.plant_id = ${id}`) {
    if (!l.po_sent_at) out.push(mv(l.created_at, l, "document", "PO created · not sent", l.total_cost));
    if (l.po_sent_at) out.push(mv(l.po_sent_at, l, "document", "PO sent", l.total_cost, null, "PO"));
    if (l.plant_paid_at) out.push(mv(l.plant_paid_at, l, "payment", "Plant paid", l.total_cost));
    if (l.picked_up_at) out.push(mv(l.picked_up_at, l, "step", "Picked up"));
  }
  return out;
}

// carrier / customs agency: the bill of each load, its surcharges, their invoices and our payments
async function providerBills(loads: any[], kind: "freight" | "customs", confirmStep: string, billLabel: string): Promise<M[]> {
  const ids = loads.map((l: any) => l.id), out: M[] = [];
  if (!ids.length) return out;
  const num = (sid: string) => loads.find((l: any) => l.id === sid)?.order_number ?? null;
  for (const f of await sql`select shipment_id, done_at from shipment_flow_steps where step = ${confirmStep} and shipment_id = any(${ids})`)
    out.push(mv(f.done_at, { shipment_id: f.shipment_id, order_number: num(f.shipment_id) }, "step", billLabel));
  for (const c of await sql`select * from order_extra_costs where payable_kind = ${kind} and order_number = any(${loads.map((l: any) => l.order_number)})`)
    out.push(mv(c.created_at, { order_number: c.order_number, shipment_id: loads.find((l: any) => l.order_number === c.order_number)?.id }, "charge", `Surcharge: ${c.cost_type}${c.notes ? " · " + c.notes : ""}`, c.amount));
  const invs = await sql`select i.*, (select string_agg(s.order_number, ', ' order by s.order_number) from provider_invoice_loads l join shipments s on s.id = l.shipment_id where l.invoice_id = i.id) as orders
    from provider_invoices i where i.kind = ${kind} and exists (select 1 from provider_invoice_loads l where l.invoice_id = i.id and l.shipment_id = any(${ids}))`;
  for (const i of invs) {
    let file_url: string | null = null;
    if (i.storage_path) { const { data } = await storageFor().from("provider-invoices").createSignedUrl(i.storage_path, 3600); file_url = data?.signedUrl ?? null; }
    const base = { order_number: i.orders, shipment_id: null };
    out.push({ ...mv(i.created_at, base, "invoice", `Invoice #${i.invoice_number} received`, i.invoice_total, i.file_name), file_url });
    for (const n of await sql`select * from provider_invoice_notes where invoice_id = ${i.id}`) out.push(mv(n.created_at, base, "invoice", `Note on invoice #${i.invoice_number}: ${n.note}`));
    if (i.approved_at) out.push({ ...mv(i.approved_at, base, "invoice", `Invoice #${i.invoice_number} approved`, i.invoice_total), file_url });
  }
  for (const r of await sql`select m.*, i.invoice_number from shipment_money_records m left join provider_invoices i on i.id = m.invoice_id where m.kind = ${kind} and m.shipment_id = any(${ids})`)
    out.push(mv(r.bank_entry_date, r, "payment", `Paid${r.invoice_number ? " · invoice #" + r.invoice_number : ""}`, r.amount, [r.payment_method, r.payment_reference].filter(Boolean).join(" · ") || null));
  return out;
}

async function provider(id: string): Promise<M[]> {
  const out: M[] = [];
  // as carrier: every load one of its freight orders is on
  const carried = await sql`select distinct on (sh.id) sh.id, sh.order_number, sh.fo_sent_at, sh.release_number, sh.release_number_sent_at, sh.picked_up_at, sh.delivered_at, f.created_at as fo_created_at, coalesce(f.actual_rate, f.quoted_rate) as rate
    from freight_orders f join shipments sh on sh.order_number = f.order_number where f.carrier_provider_id = ${id} order by sh.id, f.created_at desc`;
  for (const l of carried) {
    if (!l.fo_sent_at) out.push(mv(l.fo_created_at, l, "document", "FO created · not sent", l.rate));
    if (l.fo_sent_at) out.push(mv(l.fo_sent_at, l, "document", "FO sent", l.rate, null, "FO"));
    if (l.release_number_sent_at) out.push(mv(l.release_number_sent_at, l, "step", `Release # sent${l.release_number ? " · " + l.release_number : ""}`));
    if (l.picked_up_at) out.push(mv(l.picked_up_at, l, "step", "Picked up"));
    if (l.delivered_at) out.push(mv(l.delivered_at, l, "step", "Delivered"));
  }
  out.push(...await providerBills(carried, "freight", "freight_confirmed", "Freight bill confirmed"));
  // as customs agency: the loads whose offer (or customer) uses it
  const cleared = await sql`select sh.id, sh.order_number, sh.customs_sent_at from shipments sh
    left join sent_offers so_ on so_.id = sh.sent_offer_id left join customers c on c.id = sh.customer_id
    where coalesce(so_.customs_agency_provider_id, c.customs_agency_provider_id) = ${id}`;
  for (const l of cleared) if (l.customs_sent_at) out.push(mv(l.customs_sent_at, l, "document", "Docs sent to customs"));
  out.push(...await providerBills(cleared, "customs", "customs_confirmed", "Customs bill confirmed"));
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["entity_type", "entity_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { entity_type, entity_id } = body;
    const fn = ({ customer, plant, provider } as Record<string, (id: string) => Promise<M[]>>)[entity_type];
    if (!fn) return jsonResponse({ error: "invalid entity_type", message: "entity_type must be 'customer', 'plant' or 'provider'." }, 400);
    const movements = (await fn(entity_id)).filter((m) => m.at).sort((a, b) => new Date(b.at as any).getTime() - new Date(a.at as any).getTime());
    // loads already in Pay & Receive (delivered + invoice signed) open there; the rest open in Orders
    const nums = [...new Set(movements.flatMap((m) => String(m.order_number || "").split(", ").filter(Boolean)))];
    const inPayReceive = nums.length ? (await sql`select order_number from shipments where order_number = any(${nums}) and delivered_at is not null and invoice_signed_at is not null`).map((r: any) => r.order_number) : [];
    return jsonResponse({ movements, pay_receive_orders: inPayReceive });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
