// push.subscribe — saves (or refreshes) one browser's push subscription for a trader. Called from
// the client right after `pushManager.subscribe(...)` succeeds. Upsert on `endpoint` (the
// subscription's own unique id from the browser) so re-subscribing the same browser never
// duplicates a row — actor is updated too, in case the same browser is later used by someone else.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "endpoint", "p256dh", "auth"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, endpoint, p256dh, auth } = body;

    const [subscription] = await sql`
      insert into push_subscriptions (actor, endpoint, p256dh, auth)
      values (${actor}, ${endpoint}, ${p256dh}, ${auth})
      on conflict (endpoint) do update set actor = excluded.actor, p256dh = excluded.p256dh, auth = excluded.auth
      returning *
    `;

    return jsonResponse({ subscribed: true, subscription });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
