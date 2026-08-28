// customers.search — read-only. Matches trade_name and legal_name — a customer is sometimes
// looked up by its formal legal name, sometimes by the nickname everyone actually uses. Pass
// `ids` (an array) instead of `q` to fetch a known set of customer records directly (quotes.html
// resolves a list of customer_id from customer_products this way).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
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
