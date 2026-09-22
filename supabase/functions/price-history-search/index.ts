// price-history-search — read-only by default. Every real price ever recorded for a product
// (price_history, filled automatically since 2026-09-16 — see applyPlantProductMatch/
// plant-products-update), plus the same market-trend signal (today's best vs the prior-30-day
// average) already used to build the "Price X% better/worse" line in the customer-product signal.
// Returns null trend, not a fabricated one, until there's genuinely a prior day to compare against.
//
// Real addition 2026-09-22 ("boletín de la industria, por producto específico"): also reads/writes
// product_market_notes — what the trader captured off the bi-weekly industry bulletin for THIS
// product (trend % + a short note, e.g. cold-storage-inventory context). Folded into this file
// instead of a new function slug, same reason as customer-product-signal's own check_notified/
// log_notification addition the same day: the Edge Function project cap was maxed at 100/100 with
// zero real dead functions found in a full audit. This file is the natural fit — it's already
// product-scoped and already the call products.html makes the moment a trader opens a product's
// price history, exactly where the market note belongs. save_market_note is mutually exclusive
// with the default read.
import postgres from "npm:postgres@3.4.4";
import { computeProductPriceSignal, jsonResponse, MARKET_NOTE_FRESHNESS_DAYS } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();

    if (body.save_market_note) {
      const { product_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, actor } = body.save_market_note;
      if (!product_id) return jsonResponse({ error: "save_market_note requires product_id" }, 400);
      if (trend_pct == null && !note && mx_benchmark_price_usd_kg == null) {
        return jsonResponse({ error: "save_market_note requires trend_pct, note, and/or mx_benchmark_price_usd_kg" }, 400);
      }
      await sql`
        insert into product_market_notes (product_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, created_by)
        values (${product_id}, ${trend_pct ?? null}, ${note ?? null}, ${mx_benchmark_price_usd_kg ?? null}, ${mx_benchmark_region ?? null}, ${actor ?? null})
      `;
      return jsonResponse({ saved: true });
    }

    const { product_id } = body;
    if (!product_id) return jsonResponse({ error: "product_id is required" }, 400);

    const results = await sql`
      select ph.price, ph.price_date, ph.created_at, pl.name as plant_name
      from price_history ph
      join plants pl on pl.id = ph.plant_id
      where ph.product_id = ${product_id}
      order by ph.price_date desc, ph.created_at desc
      limit 200
    `;

    const trend = await computeProductPriceSignal(sql, product_id);

    const [marketNote] = await sql`
      select trend_pct, note, note_date, mx_benchmark_price_usd_kg, mx_benchmark_region from product_market_notes
      where product_id = ${product_id} and note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
      order by note_date desc, created_at desc
      limit 1
    `;

    return jsonResponse({ results, trend, market_note: marketNote ?? null });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
