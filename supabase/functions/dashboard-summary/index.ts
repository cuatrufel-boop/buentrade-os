// dashboard.summary — read-only. "Ese debe ser el dashboard principal ahí voy a poder ver quien
// pago quien no cuando cobrar cuanto llevo facturado el mes" — one call, everything the trader
// actually asked to see on the main screen: this month's invoiced total, who owes what and since
// when, what's overdue right now, what's coming due soon, and where every active load stands.

import postgres from "npm:postgres@3.4.4";
import { computeProductPriceSignal, creditSchedule, customerAvgLoad, customerOpenLoads, jsonResponse, PRICE_FAVORABLE_THRESHOLD_PCT, traderDisplayName } from "../_shared/matching.ts";
import { bizDay, COLLECT_FROM_DAY, payReceiveLoads } from "../_shared/moneyStatus.ts";

// ---------- "Today" (2026-09-29, AI Copilot phase 1) ----------
// The trader's day in one list, most urgent first, each item with the real fact behind it and where to
// act. "Esto debe estar super sensible y estratégico, de aquí depende el éxito del día de cada trader":
// it warns BEFORE things are late (due within SOON_DAYS), not only after. Built only from real data —
// the same money dates as the alerts (_shared/moneyStatus.ts) and the same credit rule as Quotes.
// One order's margin: final (net_profit) once paid, otherwise the live estimate collections-search shows
// as profit so far — sale − purchase − US freight − inspection − extra costs − interest since invoice.
function orderMargin(r: Record<string, any>, annualRate: number) {
  const base = { order_number: r.order_number, customer_name: r.customer_name, product_name: r.product_name, product_spec: r.product_spec, sale_amount: r.sale_amount, created_at: r.created_at };
  if (r.paid_at != null) return { ...base, margin: Number(r.net_profit ?? 0), is_final: true };
  const invoiceDate = r.invoice_sent_at ?? r.delivered_at ?? r.created_at;
  const daysSinceInvoice = invoiceDate ? Math.max(0, Math.round((Date.now() - new Date(invoiceDate).getTime()) / 86400000)) : 0;
  const realWeight = r.real_weight != null ? Number(r.real_weight) : null;
  const purchaseCost = (realWeight != null && r.cost_per_lb != null) ? realWeight * Number(r.cost_per_lb) : (r.total_cost != null ? Number(r.total_cost) : null);
  const interestSoFar = Number(r.sale_amount) * (annualRate / 365) * daysSinceInvoice;
  const margin = purchaseCost != null ? Number(r.sale_amount) - purchaseCost - Number(r.us_freight_amount ?? 0) - Number(r.inspection_amount ?? 0) - Number(r.extra_costs_total) - interestSoFar : null;
  return { ...base, margin, is_final: false };
}

// ---------- CEO / CFO view (2026-09-29) ----------
// "Facturación mes, año, si estamos bien con la meta, si nos falta cuánto tenemos que vender para llegar."
// Goal = loads per month (app_settings monthly_load_goal, the user said 3); a load counts in the month its
// order was created (shipments.created_at, Miami). Year goal = monthly goal × 12.
async function ceoView() {
  const [{ value: goalStr }] = await sql`select coalesce((select value from app_settings where key = 'monthly_load_goal'), '3') as value`;
  const [{ value: rateStr }] = await sql`select coalesce((select value from app_settings where key = 'collections_interest_rate_annual'), '0.15') as value`;
  const goal = Number(goalStr), rate = parseFloat(rateStr);
  const rows = await sql`
    select sh.order_number, sh.sale_amount, sh.paid_at, sh.net_profit, sh.invoice_sent_at, sh.delivered_at, sh.created_at,
      to_char(sh.created_at at time zone 'America/New_York', 'YYYY-MM') as ym, sh.customer_id, trim(c.trade_name) as customer, o.won_by,
      o.customer_name, o.product_name, o.product_spec, o.cost_per_lb, o.total_cost, o.us_freight_amount, o.inspection_amount, so2.real_weight,
      coalesce((select sum(amount) from order_extra_costs where order_number = sh.order_number), 0) as extra_costs_total
    from shipments sh join sent_offers o on o.id = sh.sent_offer_id
    left join sales_orders so2 on so2.order_number = sh.order_number left join customers c on c.id = sh.customer_id`;
  const today = bizDay(new Date()), ym = today.toISOString().slice(0, 7), year = ym.slice(0, 4);
  const months: Record<string, { loads: number; sales: number; margin: number }> = {};
  for (let i = 11; i >= 0; i--) { const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1)); months[d.toISOString().slice(0, 7)] = { loads: 0, sales: 0, margin: 0 }; }
  const custY: Record<string, { loads: number; sales: number }> = {}, prodY: Record<string, { loads: number; sales: number }> = {}, tradY: Record<string, { loads: number; sales: number }> = {};
  let yLoads = 0, ySales = 0, yMargin = 0;
  for (const r of rows) {
    const m = orderMargin(r, rate), sale = Number(r.sale_amount || 0), mg = Number(m.margin || 0);
    if (months[r.ym]) { months[r.ym].loads++; months[r.ym].sales += sale; months[r.ym].margin += mg; }
    if (r.ym.startsWith(year)) {
      yLoads++; ySales += sale; yMargin += mg;
      const add = (o: any, k: string) => { if (!k) return; o[k] ??= { loads: 0, sales: 0 }; o[k].loads++; o[k].sales += sale; };
      add(custY, r.customer || r.customer_name); add(prodY, r.product_spec || r.product_name); add(tradY, traderDisplayName(r.won_by) || r.won_by);
    }
  }
  const top = (o: any) => Object.entries(o).map(([name, v]: any) => ({ name, ...v })).sort((a: any, b: any) => b.sales - a.sales).slice(0, 5);
  const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate(), dayOfMonth = today.getUTCDate();
  const monthIndex = today.getUTCMonth() + 1; // months of the year so far, this one included
  // money still in the street / owed (Pay & Receive's open loads, same shared dates as Today)
  let toCollect = 0, toPay = 0;
  for (const m of await payReceiveLoads(sql)) { toCollect += m.owed; if (!m.customsPaid) toPay += m.customsTotal; if (!m.freightPaid) toPay += m.freightTotal; }
  const avgSale = yLoads ? ySales / yLoads : 0;
  return {
    goal, ym, year, day_of_month: dayOfMonth, days_in_month: daysInMonth, avg_sale: avgSale,
    month: months[ym], year_total: { loads: yLoads, sales: ySales, margin: yMargin, goal: goal * 12, expected_by_now: goal * (monthIndex - 1) + goal * dayOfMonth / daysInMonth },
    months: Object.entries(months).map(([k, v]) => ({ ym: k, ...v })),
    to_collect: toCollect, to_pay: toPay,
    top_customers: top(custY), top_products: top(prodY), top_traders: top(tradY),
  };
}

const SOON_DAYS = 3, PRICE_STALE_DAYS = 2; // PRICE_STALE_DAYS = Quotes' RQ_PRICE_STALE_DAYS
const md = (d: Date) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
const usd0 = (v: number) => "$" + Math.round(v).toLocaleString("en-US");
async function todayList() {
  const items: any[] = [], today = bizDay(new Date()), dd = (d: Date) => Math.round((d.getTime() - today.getTime()) / 86400000);
  const when = (n: number) => n < 0 ? `${-n}d overdue` : n === 0 ? "due today" : `due in ${n}d`;
  for (const m of await payReceiveLoads(sql)) {
    const o = m.L.order_number, href = `collections.html?focus=${encodeURIComponent(o)}`;
    // collect from the customer: from day 29 (Summar: its fee grows after day 30), or a direct load past its due date
    const nCollect = dd(m.collectOn), nDue = dd(m.customerDue);
    if (nCollect <= SOON_DAYS || nDue <= SOON_DAYS) {
      const late = m.summar ? m.days > 30 : nDue < 0;
      items.push({ prio: late || nCollect <= 0 ? 1 : 2, group: "collect", title: `Collect ${usd0(m.owed)} from ${m.who}`, order: o, href, sort: Math.min(nCollect, nDue),
        why: m.summar ? (m.days > 30 ? `Day ${m.days} since delivery · Summar fee grows $${m.perDay.toFixed(2)} every day` : `Day ${m.days} since delivery · collect from day ${COLLECT_FROM_DAY} (${md(m.collectOn)}) · Summar fee grows after day 30`)
          : `Day ${m.days} since delivery · payment ${when(nDue)} (${md(m.customerDue)})` });
    }
    // our bills: customs and freight, before they're late
    if (m.customsTotal > 0 && !m.customsPaid && dd(m.customsDue) <= SOON_DAYS) items.push({ prio: dd(m.customsDue) <= 0 ? 1 : 2, group: "pay", order: o, href, sort: dd(m.customsDue),
      title: `Pay customs ${usd0(m.customsTotal)}${m.L.customs_agency ? ` to ${m.L.customs_agency}` : ""}`, why: `${when(dd(m.customsDue))} (${md(m.customsDue)}) · ${m.who}` });
    if (m.freightTotal > 0 && !m.freightPaid && dd(m.freightDue) <= SOON_DAYS) items.push({ prio: dd(m.freightDue) <= 0 ? 1 : 2, group: "pay", order: o, href, sort: dd(m.freightDue),
      title: `Pay freight ${usd0(m.freightTotal)}${m.L.carrier ? ` to ${m.L.carrier}` : ""}`, why: `${when(dd(m.freightDue))} (${md(m.freightDue)}) · ${m.who}` });
    // Summar pays the remanente at delivery — if it hasn't been recorded, check it
    if (m.summar && !m.recorded.includes("summar_remanente") && m.days >= 1) items.push({ prio: 2, group: "collect", order: o, href, sort: 0,
      title: `Confirm the Summar remanente for ${o}`, why: `Delivered ${m.days}d ago · Summar pays it at delivery — not recorded yet` });
  }
  // customers over their credit line — don't offer until they pay
  for (const c of await sql`select id, trim(trade_name) as name, credit_limit from customers where credit_limit is not null`) {
    const loads = await customerOpenLoads(sql, c.id); if (!loads.length) continue;
    const sc = creditSchedule(loads, Number(c.credit_limit));
    if (sc.available_today < 0) {
      // 2026-09-29 (user): never stop offering an over-limit customer — "se pierde la comunicación y menos
      // paga": keep offering and ask for the payment, naming the invoice and its amount
      const L = await customerAvgLoad(sql, c.id), fits = sc.steps.find((x) => x.available >= (L || 1));
      const inv = loads.filter((l: any) => l.delivered).sort((a: any, b: any) => String(a.due).localeCompare(String(b.due)))[0];
      items.push({ prio: 2, group: "credit", title: `${c.name} is over the limit by ${usd0(-sc.available_today)}`, href: `customers.html?open=${c.id}`, sort: 0,
        why: `Keep offering — ${inv ? `ask them to pay INV-${inv.order_number} (${usd0(Number(inv.amount))}) to free credit` : "ask for payment of their open loads"}${L ? ` · they must pay ${usd0(-sc.available_today + L)} for one more load` : ""}${fits ? ` · next load fits ${md(new Date(fits.from + "T00:00:00Z"))} if paid on time` : ""}` });
    }
  }
  // prices of what the clients buy, older than Quotes' stale limit
  const stale = await sql`
    select p.full_name_en as name, count(distinct cp.customer_id)::int as clients, max(pp.price_date) as last
    from customer_products cp join products p on p.id = cp.product_id
    left join plant_products pp on pp.product_id = cp.product_id and pp.current_price is not null
    group by p.id, p.full_name_en
    having max(pp.price_date) is null or max(pp.price_date) < (now() at time zone 'America/New_York')::date - ${PRICE_STALE_DAYS}::int
    order by 2 desc, 3 nulls first`;
  if (stale.length) items.push({ prio: 2, group: "prices", href: "quotes.html", sort: 0, title: `${stale.length} product${stale.length === 1 ? "" : "s"} your clients buy have old or no prices`,
    why: stale.slice(0, 3).map((r: any) => `${r.name} (${r.clients} client${r.clients === 1 ? "" : "s"}, ${r.last ? "price " + md(new Date(r.last)) : "no price"})`).join(" · ") + (stale.length > 3 ? ` · +${stale.length - 3} more` : "") });
  // what to offer first: products the clients buy that have a current price (≤ PRICE_STALE_DAYS old), most
  // competitive first — best plant price vs. its own 30-day market average (Quotes' price signal); a
  // favorable one (≤ PRICE_FAVORABLE_THRESHOLD_PCT) leads, then the other fresh ones by how many clients buy it
  const fresh = await sql`
    select cp.product_id, p.full_name_en as name, max(ph.price_date) as last,
      array_agg(distinct trim(c.trade_name)) as clients, count(distinct cp.customer_id)::int as n
    from customer_products cp join products p on p.id = cp.product_id join customers c on c.id = cp.customer_id
    join price_history ph on ph.product_id = cp.product_id
    group by cp.product_id, p.full_name_en
    having max(ph.price_date) >= (now() at time zone 'America/New_York')::date - ${PRICE_STALE_DAYS}::int`;
  const sell: any[] = [];
  for (const f of fresh) { const sig = await computeProductPriceSignal(sql, f.product_id); sell.push({ ...f, sig, pct: sig?.trend ? sig.trend.pctChange : null }); }
  sell.sort((a, b) => ((a.pct ?? 0) <= PRICE_FAVORABLE_THRESHOLD_PCT ? 0 : 1) - ((b.pct ?? 0) <= PRICE_FAVORABLE_THRESHOLD_PCT ? 0 : 1) || (a.pct ?? 0) - (b.pct ?? 0) || b.n - a.n);
  for (const f of sell.slice(0, 5)) {
    const good = f.pct != null && f.pct <= PRICE_FAVORABLE_THRESHOLD_PCT;
    items.push({ prio: 2, group: "sell", href: `quotes.html?products=${f.product_id}`, sort: f.pct ?? 0,
      title: `Offer ${f.name} to ${f.clients.slice(0, 3).join(", ")}${f.n > 3 ? ` +${f.n - 3}` : ""}`,
      why: `${f.n === 1 ? "1 client buys" : `${f.n} clients buy`} it · best price $${Number(f.sig?.latestBest ?? 0).toFixed(2)}/lb (${md(new Date(f.last))})${good ? ` · ${Math.abs(f.pct).toFixed(1)}% below its 30-day market average` : f.pct != null ? ` · ${f.pct > 0 ? "+" : ""}${f.pct.toFixed(1)}% vs 30-day average` : " · current price"}` });
  }
  const G = { collect: 0, pay: 1, sell: 2, credit: 3, prices: 4 } as Record<string, number>;
  return items.sort((a, b) => a.prio - b.prio || G[a.group] - G[b.group] || a.sort - b.sort);
}


const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    if (body.view === "today") return jsonResponse({ today: await todayList() });
    if (body.view === "ceo") return jsonResponse({ ceo: await ceoView() });
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
      select sh.*, o.customer_name, o.product_name, o.product_spec
      from shipments sh join sent_offers o on o.id = sh.sent_offer_id
      where sh.paid_at is null and sh.payment_due_date is not null and sh.payment_due_date < current_date
      order by sh.payment_due_date asc
    `;

    const upcomingDue = await sql`
      select sh.*, o.customer_name, o.product_name, o.product_spec
      from shipments sh join sent_offers o on o.id = sh.sent_offer_id
      where sh.paid_at is null and sh.payment_due_date is not null
        and sh.payment_due_date >= current_date and sh.payment_due_date <= current_date + interval '7 days'
      order by sh.payment_due_date asc
    `;

    const byStatus = await sql`
      select status, count(*)::int as count from shipments group by status
    `;

    // Real addition 2026-09-22 ("alerta de cadencia próxima" — internal only, never shown to the
    // customer): a trader-facing triage list, not a claim to anyone. cadence (frequency_days) is
    // what the customer told us they buy overall; the only date this can compare it against is our
    // OWN last real sale to them (sales_orders, same fallback to customer_products.
    // last_known_order_date used elsewhere) — a customer buying from other traders too can look
    // "overdue" here while actually still on schedule with someone else. That's fine for an
    // internal "who's worth calling first" prioritization; it would NOT be fine to say to the
    // customer (see customer-product-signal's own correction the same day, which removed exactly
    // this comparison from the customer-facing message for that reason).
    const cadenceDue = await sql`
      select
        cp.customer_id, c.trade_name, cp.product_id, p.full_name_en as product_name,
        cp.frequency_days, cp.loads_per_cycle,
        coalesce(so_last.last_order_date, cp.last_known_order_date) as last_order_date,
        (current_date - coalesce(so_last.last_order_date, cp.last_known_order_date)::date)::int as days_since_our_last_sale
      from customer_products cp
      join customers c on c.id = cp.customer_id
      join products p on p.id = cp.product_id
      left join lateral (
        select max(d.delivery_date) as last_order_date
        from sales_orders so, lateral (select (jsonb_array_elements_text(so.delivery_dates))::date as delivery_date) d
        where so.customer_id = cp.customer_id and so.product_id = cp.product_id
      ) so_last on true
      where cp.frequency_days is not null
        and coalesce(so_last.last_order_date, cp.last_known_order_date) is not null
        and (current_date - coalesce(so_last.last_order_date, cp.last_known_order_date)::date) >= cp.frequency_days
      order by (current_date - coalesce(so_last.last_order_date, cp.last_known_order_date)::date) - cp.frequency_days desc
      limit 20
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
      select sh.order_number, sh.sale_amount, sh.created_at, o.customer_name, o.product_name, o.product_spec
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
    // Full catalog name+spec, never the bare short cut name (feedback-full-names-full-consecutives-
    // always) — product_spec carries that full text the same way the Best Orders table above
    // already prefers it (r.product_spec || r.product_name); only falls back to product_name when
    // an older row never had a spec captured.
    const topProductsByRevenue = await sql`
      select coalesce(o.product_spec, o.product_name) as product_name, count(*)::int as order_count, coalesce(sum(sh.sale_amount), 0) as total_sales
      from shipments sh join sent_offers o on o.id = sh.sent_offer_id
      where o.product_name is not null
      group by coalesce(o.product_spec, o.product_name)
      order by total_sales desc
      limit 5
    `;
    const topProductsByQuantity = await sql`
      select coalesce(o.product_spec, o.product_name) as product_name, count(*)::int as order_count,
        coalesce(sum(coalesce(nullif(so2.real_weight, 0), o.weight, 0)), 0) as total_weight
      from shipments sh
      join sent_offers o on o.id = sh.sent_offer_id
      left join sales_orders so2 on so2.order_number = sh.order_number
      where o.product_name is not null
      group by coalesce(o.product_spec, o.product_name)
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
        o.customer_name, o.product_name, o.product_spec, o.cost_per_lb, o.total_cost, o.us_freight_amount, o.inspection_amount,
        so2.real_weight,
        coalesce((select sum(amount) from order_extra_costs where order_number = sh.order_number), 0) as extra_costs_total
      from shipments sh
      join sent_offers o on o.id = sh.sent_offer_id
      left join sales_orders so2 on so2.order_number = sh.order_number
    `;
    const topOrdersByMargin = marginRows
      .map((r: Record<string, any>) => orderMargin(r, annualRate))
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
      cadence_due: cadenceDue,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
