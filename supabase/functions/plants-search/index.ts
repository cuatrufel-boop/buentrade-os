// plants.search — read-only. Matches on the plant's own name AND its supplier's name (a plant is
// often looked up by the parent company's name), joined so the caller always sees both together —
// per [[feedback_always_disambiguate_product_names_given_to_user]]'s spirit, never hand back a
// bare plant name without the context that disambiguates it.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    const q = (body.q || "").trim();
    const category_id = body.category_id || null;
    const id = body.id || null;
    const limit = Math.min(Number(body.limit) || 200, 500);
    const like = `%${q}%`;

    const results = id
      ? await sql`select p.*, s.name as supplier_name from plants p join suppliers s on s.id = p.supplier_id where p.id = ${id}`
      : category_id
      ? await sql`
          select p.*, s.name as supplier_name
          from plants p join suppliers s on s.id = p.supplier_id
          where p.category_id = ${category_id} and (p.name ilike ${like} or s.name ilike ${like})
          order by p.name limit ${limit}
        `
      : await sql`
          select p.*, s.name as supplier_name
          from plants p join suppliers s on s.id = p.supplier_id
          where p.name ilike ${like} or s.name ilike ${like}
          order by p.name limit ${limit}
        `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
