// products.search — read-only. Substring match (case-insensitive) across name, name_en,
// full_name_en, full_name_es, subcategory, subcategory_en — a trader typing a partial plant-style
// name or a partial OS name both need to find the same row. No writes, no audit log (reads aren't
// audited — only what changes data is).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    const q = (body.q || "").trim();
    const category_id = body.category_id || null;
    const limit = Math.min(Number(body.limit) || 200, 500);
    const like = `%${q}%`;

    const results = category_id
      ? await sql`
          select * from products
          where category_id = ${category_id} and (
            name ilike ${like} or name_en ilike ${like} or
            full_name_en ilike ${like} or full_name_es ilike ${like} or
            subcategory ilike ${like} or subcategory_en ilike ${like}
          )
          order by name_en limit ${limit}
        `
      : await sql`
          select * from products
          where name ilike ${like} or name_en ilike ${like} or
            full_name_en ilike ${like} or full_name_es ilike ${like} or
            subcategory ilike ${like} or subcategory_en ilike ${like}
          order by name_en limit ${limit}
        `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
