// price-history-search — read-only by default. Every real price ever recorded for a product
// (price_history, filled automatically since 2026-09-16 — see applyPlantProductMatch/
// plant-products-update), plus the same market-trend signal (today's best vs the prior-30-day
// average) already used to build the "Price X% better/worse" line in the customer-product signal.
// Returns null trend, not a fabricated one, until there's genuinely a prior day to compare against.
//
// Market Flash v2 (2026-09-25) lives here too — folded into this file instead of new function slugs
// because the Edge Function project cap is maxed at 100/100 (same precedent as customer-product-signal):
//   ingest_market_flash      reads the WHOLE bulletin automatically (tables by deterministic self-validating parsers,
//                            narrative by an audited literal-translation step) and stores every Spanish bullet.
//                            Idempotent by the sha-256 of the PDF (computed here): the same PDF/email twice = one bulletin.
//   list_market_flash        the three tabs (Product / Protein / Market) + Pending Matches, read-only.
//   teach_market_flash_term  Pending Matches → "this printed term means this catalog product/family" (learned once,
//                            applies to every stored and future bulletin). Idempotent upsert.
// Mutually exclusive with each other and with the default read below.
// The read-only default also returns the bulletin's bullets that apply to this product as `market_note`
// (same shape products.html already renders), so what a trader sees here never disagrees with what a quote sends.
import postgres from "npm:postgres@3.4.4";
import { computeProductPriceSignal, jsonResponse } from "../_shared/matching.ts";
import { ingestBulletin, listMarketFlash, pickBulletsForCustomerProduct, teachTerm } from "../_shared/marketFlash/store.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();

    if (body.ingest_market_flash) {
      const { items, file_hash, pdf_base64, actor, source } = body.ingest_market_flash;
      const r = await ingestBulletin(sql, { items, file_hash, pdf_base64, actor: actor ?? "unknown", source });
      return jsonResponse(r, "error" in r ? 400 : 200);
    }

    if (body.list_market_flash) return jsonResponse(await listMarketFlash(sql));

    if (body.teach_market_flash_term) {
      const { term, option_key, actor } = body.teach_market_flash_term;
      const r = await teachTerm(sql, { term, option_key, actor: actor ?? "unknown" });
      return jsonResponse(r, "error" in r ? 400 : 200);
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

    const bullets = await pickBulletsForCustomerProduct(sql, null, product_id, 3);
    const [latest] = bullets.length ? await sql`select as_of from market_flash_bulletins order by as_of desc limit 1` : [];
    const marketNote = bullets.length
      ? { trend_pct: null, note: bullets.map((b: any) => b.text).join(" "), note_date: latest?.as_of ?? null, mx_benchmark_price_usd_kg: null, mx_benchmark_region: null }
      : null;

    return jsonResponse({ results, trend, market_note: marketNote });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
