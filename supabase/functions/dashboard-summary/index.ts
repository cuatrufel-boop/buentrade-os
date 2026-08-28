// dashboard.summary — read-only. "Ese debe ser el dashboard principal ahí voy a poder ver quien
// pago quien no cuando cobrar cuanto llevo facturado el mes" — one call, everything the trader
// actually asked to see on the main screen: this month's invoiced total, who owes what and since
// when, what's overdue right now, what's coming due soon, and where every active load stands.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

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

    return jsonResponse({
      invoiced_this_month,
      outstanding_by_customer: outstandingByCustomer,
      overdue,
      upcoming_due: upcomingDue,
      shipments_by_status: byStatus,
    });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
