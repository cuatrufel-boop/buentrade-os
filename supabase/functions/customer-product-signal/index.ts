// customer-product-signal — read-only by default. The "necesidad" signal (2026-09-16): for a
// customer and a list of products (whatever a quote is currently pricing), returns whichever of
// those products has something real to say — cadence, price trend favorable, or credit exposure a
// trader should know before quoting. Never invents a reason: a product with nothing real returns
// nothing.
//
// Real addition 2026-09-22 ("carga cerrada, avisar a otros clientes"): the Supabase Edge Function
// project cap was maxed at 100/100 with zero real dead functions to free up (audited: every one of
// the 100 is reachable — direct calls, wrapper indirection, pg_cron, or function-to-function fetch
// — see the project's own notes on that audit). Same real precedent as sent-offers-create folding
// the short-code feature into itself under the same cap pressure: this file now also answers two
// narrowly-scoped, closely-related questions instead of getting a whole new function slug —
// `check_notified` (has a customer already been pinged about a closed load for this product in the
// last 7 days — the frequency cap) and `log_notification` (record that a ping just went out, same
// 7-day cap). Both are mutually exclusive with the default signals behavior and with each other —
// exactly one of customer_id+product_ids / check_notified / log_notification / log_market_flash_sends is expected per call.

import postgres from "npm:postgres@3.4.4";
import { computeCustomerProductSignal, jsonResponse } from "../_shared/matching.ts";
import { logBulletSends } from "../_shared/marketFlash/store.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

const NOTIFY_FREQUENCY_CAP_DAYS = 7;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();

    if (body.check_notified) {
      const { product_id, customer_ids } = body.check_notified;
      if (!product_id || !Array.isArray(customer_ids) || !customer_ids.length) {
        return jsonResponse({ error: "check_notified requires product_id and a non-empty customer_ids array" }, 400);
      }
      const rows = await sql`
        select distinct customer_id from load_closed_notifications
        where product_id = ${product_id} and customer_id = any(${customer_ids})
          and sent_at >= now() - (${NOTIFY_FREQUENCY_CAP_DAYS} || ' days')::interval
      `;
      return jsonResponse({ notified_customer_ids: rows.map((r: any) => r.customer_id) });
    }

    if (body.log_notification) {
      const { customer_id, product_id, order_number, channel, actor } = body.log_notification;
      const missing = ["customer_id", "product_id", "order_number", "channel"].filter((k) => !body.log_notification[k]);
      if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
      if (!["email", "whatsapp"].includes(channel)) return jsonResponse({ error: "channel must be email or whatsapp" }, 400);
      // Idempotent on (customer_id, product_id, order_number) — clicking the notify action twice
      // for the same closed order never double-logs the same customer for the same order.
      await sql`
        insert into load_closed_notifications (customer_id, product_id, order_number, channel, sent_by)
        values (${customer_id}, ${product_id}, ${order_number}, ${channel}, ${actor ?? null})
        on conflict (customer_id, product_id, order_number) do nothing
      `;
      return jsonResponse({ logged: true });
    }

    // Market Flash v2: called when a message REALLY goes out, so each bullet reaches a customer once
    // (unique bullet+customer, on conflict do nothing → a retry or double click never double-counts).
    if (body.log_market_flash_sends) {
      const { bullet_ids, customer_id, channel, actor } = body.log_market_flash_sends;
      if (channel && !["email", "whatsapp"].includes(channel)) return jsonResponse({ error: "channel must be email or whatsapp" }, 400);
      const r = await logBulletSends(sql, { bullet_ids, customer_id, channel, actor: actor ?? "unknown" });
      return jsonResponse(r, "error" in r ? 400 : 200);
    }

    const { customer_id, product_ids } = body;
    if (!customer_id || !Array.isArray(product_ids) || !product_ids.length) {
      return jsonResponse({ error: "customer_id and a non-empty product_ids array are required" }, 400);
    }

    const signals = [];
    for (const productId of product_ids) {
      const signal = await computeCustomerProductSignal(sql, customer_id, productId);
      if (signal) signals.push({ product_id: productId, ...signal });
    }

    return jsonResponse({ signals });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
