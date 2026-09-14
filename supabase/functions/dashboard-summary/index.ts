// dashboard.summary — read-only. "Ese debe ser el dashboard principal ahí voy a poder ver quien
// pago quien no cuando cobrar cuanto llevo facturado el mes" — one call, everything the trader
// actually asked to see on the main screen: this month's invoiced total, who owes what and since
// when, what's overdue right now, what's coming due soon, and where every active load stands.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, traderDisplayName } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const [{ invoiced_this_month }] = await sql`
      select coalesce(sum(sale_amount), 0) as invoiced_this_month
      from shipments
      where created_at >= date_trunc('month', now()) and created_at < date_trunc('month', now()) + interval '1 month'
    `;

    const outstandingByCustomer = await sql`
      select
        sh.customer_id, o.customer_name,
        sum(sh.sale_amount) as outstanding,
        min(sh.payment_due_date) as oldest_due_date,
        count(*) filter (where sh.payment_due_date is not null and sh.payment_due_date < current_date) as overdue_count,
        c.credit_limit
      from shipments sh
      join sent_offers o on o.id = sh.sent_offer_id
      left join customers c on c.id = sh.customer_id
      where sh.paid_at is null
      group by sh.customer_id, o.customer_name, c.credit_limit
      order by outstanding desc
    `;

    const overdue = await sql`
      select sh.*, o.customer_name, o.product_name
      from shipments sh join sent_offers o on o.id = sh.sent_offer_id
      where sh.paid_at is null and sh.payment_due_date is not null and sh.payment_due_date < current_date
      order by sh.payment_due_date asc
    `;

    const upcomingDue = await sql`
      select sh.*, o.customer_name, o.product_name
      from shipments sh join sent_offers o on o.id = sh.sent_offer_id
      where sh.paid_at is null and sh.payment_due_date is not null
        and sh.payment_due_date >= current_date and sh.payment_due_date <= current_date + interval '7 days'
      order by sh.payment_due_date asc
    `;

    const byStatus = await sql`
      select status, count(*)::int as count from shipments group by status
    `;

    // Real ask 2026-09-08: "todos los pagos a plantas deben ser in advance" — there's no real
    // "payables aging" the way Collections has for receivables (a payment should never sit unpaid
    // for days by policy — the sequential gate in orders.html already blocks confirming pickup
    // until Pay-Plant is done). What actually helps here is a cash-OUT forecast: every won order
    // where the plant hasn't been paid yet, ranked by how close it is to physically needing that
    // payment to move forward — pending_pickup first (payment is the one thing blocking it right
    // now), then picked_up/unloading/delivered (already moved without payment on file — a real gap
    // in older data, still worth surfacing, just not as urgent as one actively blocked today).
    const stageUrgency = sql`case sh.status
      when 'pending_pickup' then 0 when 'picked_up' then 1 when 'unloading' then 2 when 'delivered' then 3 else 4 end`;
    const pendingPlantPayments = await sql`
      select sh.order_number, sh.status, sh.pickup_date, sh.created_at,
        po.plant_name, po.total_cost
      from shipments sh
      left join purchase_orders po on po.sent_offer_id = sh.sent_offer_id
      where sh.plant_paid_at is null
      order by ${stageUrgency}, sh.pickup_date asc nulls last, sh.created_at asc
    `;
    const pendingPlantPaymentsTotal = pendingPlantPayments.reduce((sum, r) => sum + Number(r.total_cost ?? 0), 0);

    // Real ask 2026-09-14 ("quiero ver... top orden mas grande, ventas totales, ventas del
    // periodo, top 5 de productos por cantidades, top 5 de traders"): shipments (not sent_offers)
    // is the real-sales source — sent_offers includes lost/pending quotes that never became a real
    // order, which would overcount. sale_amount + created_at on shipments is what's actually a won,
    // real order (see sent-offers-mark-won, which is the only thing that inserts a shipments row).
    const [{ total_sales_all_time }] = await sql`select coalesce(sum(sale_amount), 0) as total_sales_all_time from shipments`;
    const [biggestOrder] = await sql`
      select sh.order_number, sh.sale_amount, sh.created_at, o.customer_name, o.product_name
      from shipments sh join sent_offers o on o.id = sh.sent_offer_id
      order by sh.sale_amount desc nulls last
      limit 1
    `;

    // Real gap confirmed live (2026-09-14 investigation): "trader" isn't a real column anywhere —
    // sent_offers.won_by is a free-text email, stamped by whoever's logged in when an offer is
    // marked won (see sent-offers-mark-won). It's the closest real thing to "who closed this,"
    // just never normalized into an actual users table.
    const topTradersRaw = await sql`
      select o.won_by as trader, count(*)::int as order_count, coalesce(sum(sh.sale_amount), 0) as total_sales
      from shipments sh join sent_offers o on o.id = sh.sent_offer_id
      where o.won_by is not null
      group by o.won_by
      order by total_sales desc
      limit 5
    `;
    // Real ask 2026-09-14: "ahora el unico buyer y trader es Felipe Cuartas" — every login goes
    // through the shared info@buentradegroup.com account right now, which printed as the raw,
    // wrong "info" everywhere a trader name showed. traderDisplayName maps that one real name in;
    // falls back to the email's local part once real per-trader logins exist.
    const topTraders = topTradersRaw.map((t: any) => ({ ...t, trader: traderDisplayName(t.trader) }));

    // Real gap confirmed live: real_weight (the actual customs-pedimento weight) is rarely
    // populated today — this falls back to the quoted sent_offers.weight the same way
    // collections-search/orders.html already do, so "by quantity" is honest about ranking mostly
    // quoted weight right now, not always the true delivered weight.
    const topProductsByRevenue = await sql`
      select o.product_name, count(*)::int as order_count, coalesce(sum(sh.sale_amount), 0) as total_sales
      from shipments sh join sent_offers o on o.id = sh.sent_offer_id
      where o.product_name is not null
      group by o.product_name
      order by total_sales desc
      limit 5
    `;
    const topProductsByQuantity = await sql`
      select o.product_name, count(*)::int as order_count,
        coalesce(sum(coalesce(nullif(so2.real_weight, 0), o.weight, 0)), 0) as total_weight
      from shipments sh
      join sent_offers o on o.id = sh.sent_offer_id
      left join sales_orders so2 on so2.order_number = sh.order_number
      where o.product_name is not null
      group by o.product_name
      order by total_weight desc
      limit 5
    `;

    // Real margin, exactly the same formula finalizeShipmentPaid uses for a paid shipment
    // (net_profit, already computed once and stored) — but that's null until an order is actually
    // paid. "Construyelo con lo que hay" (explicit ask): rather than only ranking the handful of
    // already-paid orders, an open order gets the exact same live, never-stored estimate
    // collections-search already shows as profit_so_far, so "best orders by margin" reflects every
    // real order on file, clearly distinguishing which numbers are final vs. still estimated.
    const [{ value: rateStr }] = await sql`select value from app_settings where key = 'collections_interest_rate_annual'`;
    const annualRate = parseFloat(rateStr ?? "0.15");
    const marginRows = await sql`
      select sh.order_number, sh.sale_amount, sh.paid_at, sh.net_profit, sh.invoice_sent_at, sh.delivered_at, sh.created_at,
        o.customer_name, o.product_name, o.cost_per_lb, o.total_cost, o.us_freight_amount, o.inspection_amount,
        so2.real_weight,
        coalesce((select sum(amount) from order_extra_costs where order_number = sh.order_number), 0) as extra_costs_total
      from shipments sh
      join sent_offers o on o.id = sh.sent_offer_id
      left join sales_orders so2 on so2.order_number = sh.order_number
    `;
    const now = new Date();
    const topOrdersByMargin = marginRows
      .map((r: Record<string, any>) => {
        if (r.paid_at != null) {
          return { order_number: r.order_number, customer_name: r.customer_name, product_name: r.product_name, sale_amount: r.sale_amount, margin: Number(r.net_profit ?? 0), is_final: true };
        }
        const invoiceDate = r.invoice_sent_at ?? r.delivered_at ?? r.created_at;
        const daysSinceInvoice = invoiceDate ? Math.max(0, Math.round((now.getTime() - new Date(invoiceDate).getTime()) / 86400000)) : 0;
        const realWeight = r.real_weight != null ? Number(r.real_weight) : null;
        const purchaseCost = (realWeight != null && r.cost_per_lb != null) ? realWeight * Number(r.cost_per_lb) : (r.total_cost != null ? Number(r.total_cost) : null);
        const interestSoFar = Number(r.sale_amount) * (annualRate / 365) * daysSinceInvoice;
        const marginEstimate = purchaseCost != null
          ? Number(r.sale_amount) - purchaseCost - Number(r.us_freight_amount ?? 0) - Number(r.inspection_amount ?? 0) - Number(r.extra_costs_total) - interestSoFar
          : null;
        return { order_number: r.order_number, customer_name: r.customer_name, product_name: r.product_name, sale_amount: r.sale_amount, margin: marginEstimate, is_final: false };
      })
      .filter((r) => r.margin != null)
      .sort((a, b) => (b.margin as number) - (a.margin as number))
      .slice(0, 5);

    return jsonResponse({
      invoiced_this_month,
      outstanding_by_customer: outstandingByCustomer,
      overdue,
      upcoming_due: upcomingDue,
      shipments_by_status: byStatus,
      pending_plant_payments: pendingPlantPayments,
      pending_plant_payments_total: pendingPlantPaymentsTotal,
      total_sales_all_time,
      sales_this_month: invoiced_this_month,
      biggest_order: biggestOrder || null,
      top_orders_by_margin: topOrdersByMargin,
      top_products_by_revenue: topProductsByRevenue,
      top_products_by_quantity: topProductsByQuantity,
      top_traders: topTraders,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
