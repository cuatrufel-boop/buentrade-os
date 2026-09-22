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
//
// Real correction 2026-09-22, same day ("un trader no tiene tiempo para escribir cosas de mercado
// ... el sistema debe recibir el boletin"): save_market_note (trader types from scratch) stays for
// one-off manual edits, but is no longer the primary path. The primary path is now
// product_market_note_suggestions — rows staged by whoever actually reads the bulletin (today: a
// Claude session reading the real PDF and matching cut names against the real catalog; the
// suggestion is a guess, never applied blind) — and three new actions: list_suggestions (all
// pending, for the "review bulletin suggestions" panel), approve_suggestion (trader confirms —
// creates/updates the real product_market_notes row), reject_suggestion. The default read below
// also now returns this product's own pending suggestion (if any), so the per-product panel can
// show "review this" instead of a blank form to type into.
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

    // Real addition 2026-09-22: stage a suggestion — whoever read the bulletin (a Claude session
    // today) calls this once per cut it recognizes as possibly one of BuenTrade's own products.
    // suggested_product_id is a guess (nullable — "couldn't tell which catalog row" is a valid,
    // honest state, still worth showing the trader with no pre-selected product).
    if (body.create_suggestion) {
      const { bulletin_date, raw_cut_name, suggested_product_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, actor } = body.create_suggestion;
      if (!raw_cut_name) return jsonResponse({ error: "create_suggestion requires raw_cut_name" }, 400);
      const [row] = await sql`
        insert into product_market_note_suggestions
          (bulletin_date, raw_cut_name, suggested_product_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, created_by)
        values (${bulletin_date ?? new Date().toISOString().slice(0, 10)}, ${raw_cut_name}, ${suggested_product_id ?? null}, ${trend_pct ?? null}, ${note ?? null}, ${mx_benchmark_price_usd_kg ?? null}, ${mx_benchmark_region ?? null}, ${actor ?? null})
        returning id
      `;
      return jsonResponse({ created: true, id: row.id });
    }

    // Real addition 2026-09-22: every pending suggestion, for the "Review bulletin suggestions"
    // panel — joined with the suggested product's own name so the trader sees a real product name,
    // not a raw ID, and can judge the match at a glance.
    if (body.list_suggestions) {
      const rows = await sql`
        select s.id, s.bulletin_date, s.raw_cut_name, s.suggested_product_id, s.trend_pct, s.note,
          s.mx_benchmark_price_usd_kg, s.mx_benchmark_region, s.created_at,
          p.full_name_en as suggested_product_name
        from product_market_note_suggestions s
        left join products p on p.id = s.suggested_product_id
        where s.status = 'pending'
        order by s.bulletin_date desc, s.created_at desc
      `;
      return jsonResponse({ suggestions: rows });
    }

    // Real addition 2026-09-22: trader confirms — confirmed_product_id lets them override the
    // suggestion (pick a different real product than the guess, or supply one when there was no
    // guess) before it becomes a real, customer-facing product_market_notes row. Never silently
    // applies the guess without this explicit confirmation.
    if (body.approve_suggestion) {
      const { id, confirmed_product_id, actor } = body.approve_suggestion;
      if (!id || !confirmed_product_id) return jsonResponse({ error: "approve_suggestion requires id and confirmed_product_id" }, 400);
      const [suggestion] = await sql`select * from product_market_note_suggestions where id = ${id} and status = 'pending'`;
      if (!suggestion) return jsonResponse({ error: "suggestion not found or already reviewed" }, 404);
      await sql`
        insert into product_market_notes (product_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, created_by)
        values (${confirmed_product_id}, ${suggestion.trend_pct}, ${suggestion.note}, ${suggestion.mx_benchmark_price_usd_kg}, ${suggestion.mx_benchmark_region}, ${actor ?? null})
      `;
      await sql`update product_market_note_suggestions set status = 'approved', reviewed_by = ${actor ?? null}, reviewed_at = now() where id = ${id}`;
      return jsonResponse({ approved: true });
    }

    if (body.reject_suggestion) {
      const { id, actor } = body.reject_suggestion;
      if (!id) return jsonResponse({ error: "reject_suggestion requires id" }, 400);
      await sql`update product_market_note_suggestions set status = 'rejected', reviewed_by = ${actor ?? null}, reviewed_at = now() where id = ${id} and status = 'pending'`;
      return jsonResponse({ rejected: true });
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

    // This product's own pending suggestion (if any) — lets the per-product panel show a
    // review-this card instead of (or alongside) a blank manual-entry form.
    const [pendingSuggestion] = await sql`
      select id, bulletin_date, raw_cut_name, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region
      from product_market_note_suggestions
      where suggested_product_id = ${product_id} and status = 'pending'
      order by bulletin_date desc, created_at desc
      limit 1
    `;

    return jsonResponse({ results, trend, market_note: marketNote ?? null, pending_suggestion: pendingSuggestion ?? null });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
