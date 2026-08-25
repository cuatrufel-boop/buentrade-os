// customer_notifications.search — read-only. Powers the "notificaciones importantes en el perfil
// de ese cliente" feed — payments received, credit-limit warnings, and whatever else gets added to
// this feed later. unread_only narrows to what hasn't been acknowledged yet.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require" });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    const { customer_id = null, unread_only = false } = body;
    const limit = Math.min(Number(body.limit) || 50, 200);

    if (!customer_id) return jsonResponse({ error: "customer_id is required" }, 400);

    const results = unread_only
      ? await sql`select * from customer_notifications where customer_id = ${customer_id} and read_at is null order by created_at desc limit ${limit}`
      : await sql`select * from customer_notifications where customer_id = ${customer_id} order by created_at desc limit ${limit}`;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
