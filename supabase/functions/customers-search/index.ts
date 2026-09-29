// customers.search — read-only. Matches trade_name and legal_name — a customer is sometimes
// looked up by its formal legal name, sometimes by the nickname everyone actually uses. Pass
// `ids` (an array) instead of `q` to fetch a known set of customer records directly (quotes.html
// resolves a list of customer_id from customer_products this way).

import postgres from "npm:postgres@3.4.4";
import { creditSchedule, customerOpenLoads, jsonResponse } from "../_shared/matching.ts";

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
      return jsonResponse({ credit: { credit_limit: c?.credit_limit ?? null, payment_days: c?.payment_days ?? null, loads, today: new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }), schedule: sched?.steps ?? [] } });
    }
    // credit_for_ids: the same "can sell today / from date" for a list of customers (Clients list, Quotes)
    if (Array.isArray(body.credit_for_ids)) {
      const out: Record<string, any> = {};
      for (const c of await sql`select id, credit_limit from customers where id = any(${body.credit_for_ids})`) {
        if (c.credit_limit == null) { out[c.id] = null; continue; }
        const sc = creditSchedule(await customerOpenLoads(sql, c.id), Number(c.credit_limit));
        out[c.id] = { credit_limit: Number(c.credit_limit), available_today: sc.available_today, steps: sc.steps };
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
