// collections.search — read-only. The one call collections.html needs: every invoiced order with
// its aging/interest-so-far, per-customer credit exposure (cupo used vs. available — "cuanto mas
// le puede vender"), and DSO. "Este modulo de collections es donde van todas las ordenes que ya
// tienen una factura asociada" — the base set is exactly that: shipments where invoice_sent_at is
// not null, whether paid or still open.
//
// Two different "interest" numbers on purpose, never confused with each other:
//   - interest_amount / net_profit (stored on shipments) — the REAL, final numbers, computed once
//     at the moment of full payment (see finalizeShipmentPaid). Null until then.
//   - interest_so_far / profit_so_far (computed fresh on every call here, never stored) — a live
//     "if it got paid today" estimate for OPEN invoices, so the trader can see the impact of a slow
//     payer building up before it's final. "solo cuando se pague" (confirmed) is about what gets
//     SAVED, not about whether the dashboard can show a live estimate.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    const [{ value: rateStr }] = await sql`select value from app_settings where key = 'collections_interest_rate_annual'`;
    const annualRate = parseFloat(rateStr ?? "0.15");
    if (body.view === "pay_receive") return jsonResponse(await payReceive(annualRate));

    const shipments = await sql`
      select
        sh.*, c.trade_name as customer_trade_name, c.credit_limit, c.payment_days,
        c.email as customer_email, c.whatsapp as customer_whatsapp, c.contact_name as customer_contact_name,
        so_.cost_per_lb, so_.total_cost, so_.us_freight_amount, so_.inspection_amount, so_.product_name, so_.product_name_es, so_.product_spec, so_.product_spec_es,
        sales.real_weight,
        coalesce((select sum(amount) from order_extra_costs where order_number = sh.order_number), 0) as extra_costs_total
      from shipments sh
      left join customers c on c.id = sh.customer_id
      left join sent_offers so_ on so_.id = sh.sent_offer_id
      left join sales_orders sales on sales.order_number = sh.order_number
      where sh.invoice_sent_at is not null
      order by coalesce(sh.invoice_sent_at, sh.delivered_at) asc
    `;

    const today = new Date();
    const enriched = shipments.map((sh: Record<string, any>) => {
      const invoiceDate = sh.invoice_sent_at ?? sh.delivered_at;
      const daysSinceInvoice = invoiceDate ? Math.max(0, Math.round((today.getTime() - new Date(invoiceDate).getTime()) / 86400000)) : 0;
      const balance = Number(sh.sale_amount) - Number(sh.amount_paid);
      const isPaid = !!sh.paid_at;
      const isOverdue = !isPaid && sh.payment_due_date && new Date(sh.payment_due_date) < today;
      const daysOverdue = isOverdue ? Math.max(0, Math.round((today.getTime() - new Date(sh.payment_due_date).getTime()) / 86400000)) : 0;
      // Standard AR aging buckets (0-30/31-60/61-90/90+) — every real AR/Collections platform
      // leads with these. 'current' = not yet due; null only for paid shipments (no bucket applies).
      let agingBucket = null;
      if (!isPaid) {
        if (daysOverdue === 0) agingBucket = "current";
        else if (daysOverdue <= 30) agingBucket = "0-30";
        else if (daysOverdue <= 60) agingBucket = "31-60";
        else if (daysOverdue <= 90) agingBucket = "61-90";
        else agingBucket = "90+";
      }

      let interestSoFar = null, profitSoFar = null;
      if (!isPaid) {
        // Real weight (customs pedimento) when it's on file, same fallback finalizeShipmentPaid
        // uses for the final number — real_weight has near-zero UI coverage today, so falling back
        // to the quoted total_cost is what keeps this estimate showing at all for most open orders.
        const realWeight = sh.real_weight != null ? Number(sh.real_weight) : null;
        const purchaseCost = (realWeight != null && sh.cost_per_lb != null) ? realWeight * Number(sh.cost_per_lb) : (sh.total_cost != null ? Number(sh.total_cost) : null);
        interestSoFar = Number(sh.sale_amount) * (annualRate / 365) * daysSinceInvoice;
        if (purchaseCost != null) {
          profitSoFar = Number(sh.sale_amount) - purchaseCost - Number(sh.us_freight_amount ?? 0) - Number(sh.inspection_amount ?? 0) - Number(sh.extra_costs_total) - interestSoFar;
        }
      }

      return {
        ...sh,
        balance,
        days_since_invoice: daysSinceInvoice,
        is_overdue: !!isOverdue,
        days_overdue: daysOverdue,
        aging_bucket: agingBucket,
        interest_so_far: interestSoFar,
        profit_so_far: profitSoFar,
      };
    });

    // Per-customer rollup — "cuanto le debe el cliente y cuanto mas le puede vender dependiendo de
    // su cupo." Grouped in JS off the same rows already fetched, so this stays one round trip.
    const byCustomer = new Map<string, any>();
    for (const sh of enriched) {
      if (!sh.customer_id) continue;
      if (!byCustomer.has(sh.customer_id)) {
        byCustomer.set(sh.customer_id, {
          customer_id: sh.customer_id, customer_name: sh.customer_trade_name,
          credit_limit: sh.credit_limit, payment_days: sh.payment_days,
          outstanding: 0, overdue_count: 0, oldest_due_date: null,
        });
      }
      const c = byCustomer.get(sh.customer_id);
      if (!sh.paid_at) {
        c.outstanding += sh.balance;
        if (sh.is_overdue) c.overdue_count += 1;
        if (sh.payment_due_date && (!c.oldest_due_date || sh.payment_due_date < c.oldest_due_date)) c.oldest_due_date = sh.payment_due_date;
      }
    }
    const customers = [...byCustomer.values()].map((c) => ({
      ...c,
      available_credit: c.credit_limit != null ? Number(c.credit_limit) - c.outstanding : null,
    }));

    // DSO (Days Sales Outstanding) — total open A/R divided by average daily invoiced amount over
    // the trailing 90 days. The one headline number every AR/Collections platform leads with.
    const totalOutstanding = enriched.filter((s) => !s.paid_at).reduce((sum, s) => sum + s.balance, 0);
    const [{ invoiced_90d }] = await sql`
      select coalesce(sum(sale_amount), 0) as invoiced_90d from shipments
      where invoice_sent_at is not null and invoice_sent_at >= now() - interval '90 days'
    `;
    const dso = Number(invoiced_90d) > 0 ? (totalOutstanding / Number(invoiced_90d)) * 90 : null;

    const totalOverdue = enriched.filter((s) => s.is_overdue).reduce((sum, s) => sum + s.balance, 0);
    const totalRealizedProfit = enriched.filter((s) => s.paid_at).reduce((sum, s) => sum + Number(s.net_profit ?? 0), 0);

    // Aging report — total $ and count per bucket, the standard AR summary view.
    const bucketOrder = ["current", "0-30", "31-60", "61-90", "90+"];
    const aging = bucketOrder.map((bucket) => {
      const rows = enriched.filter((s) => s.aging_bucket === bucket);
      return { bucket, count: rows.length, amount: rows.reduce((sum, s) => sum + s.balance, 0) };
    });

    return jsonResponse({
      shipments: enriched,
      customers,
      dso,
      total_outstanding: totalOutstanding,
      total_overdue: totalOverdue,
      total_realized_profit: totalRealizedProfit,
      interest_rate_annual: annualRate,
      aging,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});

// Pay & Receive (Collections + Payments merged, approved 2026-09-28) — every load still moving
// money, straight from Orders, plus every money record already made on it. The page builds each
// load's money steps from these facts (who pays whom, how much, when); nothing here is re-asked.
//   - plant payment / Summar wire: Orders steps (plant_paid_at / summar_payment_sent_at)
//   - freight + customs we pay at delivery, Summar remanente it pays us at delivery:
//     shipment_money_records
//   - customer invoice payments (direct loads): payment_applications, same as always
async function payReceive(annualRate: number) {
  const loads = await sql`
    select sh.id, sh.order_number, sh.status, sh.customer_id, c.trade_name as customer_name, c.credit_limit, c.payment_days as customer_payment_days,
      c.email as customer_email, c.whatsapp as customer_whatsapp, c.contact_name as customer_contact_name,
      po.plant_name, coalesce(so_.product_spec, so_.product_name) as product, po.financing_method, po.payment_days as summar_payment_days,
      sh.sale_amount, po.total_cost as plant_cost, so_.total_cost as offer_cost, so_.cost_per_lb, sales.real_weight,
      so_.us_freight_amount, coalesce(so_.tramite_aduanal_amount, 0) as tramite_aduanal_amount, coalesce(so_.inspection_amount, 0) as inspection_amount,
      coalesce((select sum(amount) from order_extra_costs where order_number = sh.order_number), 0) as extra_costs_total,
      (select min(d::date) from purchase_orders p2, jsonb_array_elements_text(p2.delivery_dates) d where p2.order_number = sh.order_number) as delivery_date,
      sh.pickup_date, sh.plant_paid_at, sh.summar_payment_sent_at, sh.picked_up_at, sh.delivered_at, sh.invoice_sent_at, sh.payment_due_date,
      sh.paid_at, sh.amount_paid, sh.net_profit, sh.interest_amount,
      fo.carrier_name, fo.freight_rate
    from shipments sh
    left join customers c on c.id = sh.customer_id
    left join purchase_orders po on po.order_number = sh.order_number
    left join sent_offers so_ on so_.id = sh.sent_offer_id
    left join sales_orders sales on sales.order_number = sh.order_number
    left join lateral (
      select pr.name as carrier_name, coalesce(f.actual_rate, f.quoted_rate) as freight_rate
      from freight_orders f left join providers pr on pr.id = f.carrier_provider_id
      where f.order_number = sh.order_number order by f.created_at desc limit 1
    ) fo on true
    order by sh.order_number
  `;
  const records = await sql`select * from shipment_money_records order by created_at`;
  const customerPayments = await sql`
    select pa.*, c.trade_name as customer_name from payment_applications pa
    left join customers c on c.id = pa.customer_id order by pa.applied_at
  `;
  return { loads, records, customer_payments: customerPayments, interest_rate_annual: annualRate, today: new Date().toISOString().slice(0, 10) };
}

