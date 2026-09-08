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
    const [{ value: rateStr }] = await sql`select value from app_settings where key = 'collections_interest_rate_annual'`;
    const annualRate = parseFloat(rateStr ?? "0.15");

    const shipments = await sql`
      select
        sh.*, c.trade_name as customer_trade_name, c.credit_limit, c.payment_days,
        so_.cost_per_lb, so_.total_cost, so_.us_freight_amount, so_.inspection_amount, so_.product_name, so_.product_name_es,
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

    return jsonResponse({
      shipments: enriched,
      customers,
      dso,
      total_outstanding: totalOutstanding,
      total_overdue: totalOverdue,
      total_realized_profit: totalRealizedProfit,
      interest_rate_annual: annualRate,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
