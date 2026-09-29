// customers.search — read-only. Matches trade_name and legal_name — a customer is sometimes
// looked up by its formal legal name, sometimes by the nickname everyone actually uses. Pass
// `ids` (an array) instead of `q` to fetch a known set of customer records directly (quotes.html
// resolves a list of customer_id from customer_products this way).

import postgres from "npm:postgres@3.4.4";
import { creditSchedule, customerAvgLoad, customerOpenLoads, jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    // credit_for (2026-09-29): the customer's credit line for its profile — limit and every sold,
    // unpaid load with the day it's due, from the same list the offer credit check uses
    if (body.credit_for) {
      const [c] = await sql`select credit_limit, payment_days from customers where id = ${body.credit_for}`;
      const loads = await customerOpenLoads(sql, body.credit_for);
      const sched = c?.credit_limit != null ? creditSchedule(loads, Number(c.credit_limit)) : null;
      return jsonResponse({ credit: { credit_limit: c?.credit_limit ?? null, payment_days: c?.payment_days ?? null, loads, today: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), schedule: sched?.steps ?? [], avg_load: await customerAvgLoad(sql, body.credit_for) } });
    }
    // credit_for_ids: the same "can sell today / from date" for a list of customers (Clients list, Quotes)
    if (Array.isArray(body.credit_for_ids)) {
      const out: Record<string, any> = {};
      for (const c of await sql`select id, credit_limit from customers where id = any(${body.credit_for_ids})`) {
        if (c.credit_limit == null) { out[c.id] = null; continue; }
        const loads = await customerOpenLoads(sql, c.id);
        const sc = creditSchedule(loads, Number(c.credit_limit)), avg = await customerAvgLoad(sql, c.id);
        // what the customer must pay so ONE more load fits (user 2026-09-29: "el monto que necesita pagar por número de
        // factura") — invoices first, oldest due first; if they don't cover it, the loads still in transit follow by
        // their order number (they have no invoice yet)
        const a = sc.available_today, need = avg ? (a < 0 ? -a + avg : a < avg ? avg - a : 0) : 0;
        let pay_invoices: any[] | null = null;
        if (need > 0) {
          let sum = 0; const picked: any[] = [];
          for (const l of [...loads.filter((x: any) => x.delivered), ...loads.filter((x: any) => !x.delivered)]) { if (sum >= need) break; picked.push(l); sum += Number(l.amount); }
          if (sum >= need) pay_invoices = picked.map((l: any) => ({ number: l.delivered ? `INV-${l.order_number}` : l.order_number, invoiced: !!l.delivered, amount: Number(l.amount), due: l.due }));
        }
        out[c.id] = { credit_limit: Number(c.credit_limit), available_today: a, steps: sc.steps, avg_load: avg, pay_invoices };
      }
      return jsonResponse({ credit: out });
    }
    const ids = Array.isArray(body.ids) ? body.ids : null;
    const q = (body.q || "").trim();
    const limit = Math.min(Number(body.limit) || 200, 500);
    const like = `%${q}%`;

    const results = ids
      ? await sql`select * from customers where id = any(${ids}) order by trade_name`
      : await sql`
          select * from customers
          where trade_name ilike ${like} or legal_name ilike ${like}
          order by trade_name limit ${limit}
        `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
