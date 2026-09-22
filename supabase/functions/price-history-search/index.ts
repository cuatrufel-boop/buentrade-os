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
// Real correction 2026-09-22, same day ("no quiero editar producto por producto... esto tiene que
// ir conectado a who buy this, ningún trader va a ir a alimentar productos nunca" / "Market Flash,
// no boletín" / "reconozca matches con producto, proteína y mercado, hasta que aprende"): the whole
// per-product manual-entry idea is gone. The real, permanent flow is:
//
//   1. process_market_flash_lines — trader pastes Market Flash text in ONE new screen (not
//      Products). For each line, checks market_flash_term_aliases first (same proven "learn the
//      language" shape as plant_term_aliases): a term it already knows auto-applies with zero
//      interaction, forever. A term it's never seen stays unresolved (never guessed).
//   2. teach_term — the ONLY moment a trader is ever asked anything, and only for a genuinely new
//      term: is this a specific PRODUCT, a whole PROTEIN/species category, or general MARKET info
//      with no association at all? Whichever it is, this both applies the data now AND remembers
//      the term forever in market_flash_term_aliases — next Market Flash never asks again.
//   3. list_market_flash — the one screen showing everything: every active note (product- or
//      category-scoped), joined with which real customers are linked to that product/category
//      (customer_products) — so the trader sees the who-buys-this connection right there, never a
//      bare product ID with no context.
//
// product_market_notes.product_id is nullable now — a note is either product-scoped or
// category_id-scoped (species-wide), never both (DB check constraint). save_market_note/
// create_suggestion/approve_suggestion/reject_suggestion below are kept only as the underlying
// primitives teach_term itself calls — never called directly by the UI any more.
import postgres from "npm:postgres@3.4.4";
import { computeProductPriceSignal, jsonResponse, MARKET_NOTE_FRESHNESS_DAYS } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();

    if (body.save_market_note) {
      const { product_id, category_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, actor } = body.save_market_note;
      if (!product_id && !category_id) return jsonResponse({ error: "save_market_note requires product_id or category_id" }, 400);
      if (product_id && category_id) return jsonResponse({ error: "save_market_note takes product_id or category_id, never both" }, 400);
      if (trend_pct == null && !note && mx_benchmark_price_usd_kg == null) {
        return jsonResponse({ error: "save_market_note requires trend_pct, note, and/or mx_benchmark_price_usd_kg" }, 400);
      }
      await sql`
        insert into product_market_notes (product_id, category_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, created_by)
        values (${product_id ?? null}, ${category_id ?? null}, ${trend_pct ?? null}, ${note ?? null}, ${mx_benchmark_price_usd_kg ?? null}, ${mx_benchmark_region ?? null}, ${actor ?? null})
      `;
      return jsonResponse({ saved: true });
    }

    // Real addition 2026-09-22 ("hasta que aprende"): the ONE screen where a trader pastes Market
    // Flash text — never per-product. Each line checks market_flash_term_aliases FIRST (case-
    // insensitive exact match on the term); a term already taught applies with zero interaction,
    // forever. A term never seen before is queued as a suggestion, waiting for teach_term — never
    // guessed, never silently dropped.
    if (body.process_market_flash_lines) {
      const { lines, actor } = body.process_market_flash_lines;
      if (!Array.isArray(lines) || !lines.length) return jsonResponse({ error: "process_market_flash_lines requires a non-empty lines array" }, 400);
      let applied = 0, queued = 0;
      for (const line of lines) {
        const rawCutName = line?.raw_cut_name;
        const trendPct = line?.trend_pct;
        if (!rawCutName) continue;
        const [alias] = await sql`select meaning_type, meaning_id from market_flash_term_aliases where lower(term) = lower(${rawCutName})`;
        if (alias) {
          if (alias.meaning_type === "product") {
            await sql`insert into product_market_notes (product_id, trend_pct, created_by) values (${alias.meaning_id}, ${trendPct ?? null}, ${actor ?? null})`;
          } else if (alias.meaning_type === "species") {
            await sql`insert into product_market_notes (category_id, trend_pct, created_by) values (${alias.meaning_id}, ${trendPct ?? null}, ${actor ?? null})`;
          }
          // meaning_type === "market": already known to be general/unassociated — nothing to apply, never asked again.
          applied++;
        } else {
          await sql`insert into product_market_note_suggestions (raw_cut_name, trend_pct, created_by) values (${rawCutName}, ${trendPct ?? null}, ${actor ?? null})`;
          queued++;
        }
      }
      return jsonResponse({ applied, queued });
    }

    // Real addition 2026-09-22: the ONLY moment a trader is ever asked anything about a Market
    // Flash term, and only once per unique term, ever. meaning_type: 'product' (meaning_id = a real
    // product), 'species' (meaning_id = a real category/protein), or 'market' (no association at
    // all — genuinely general market info, meaning_id stays null). Remembers the term in
    // market_flash_term_aliases (so it never asks again), applies the data now if there's any real
    // data to apply, and resolves every pending suggestion that used this exact raw term.
    if (body.teach_term) {
      const { raw_cut_name, meaning_type, meaning_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, actor } = body.teach_term;
      if (!raw_cut_name || !meaning_type) return jsonResponse({ error: "teach_term requires raw_cut_name and meaning_type" }, 400);
      if (!["product", "species", "market"].includes(meaning_type)) return jsonResponse({ error: "meaning_type must be product, species, or market" }, 400);
      if (meaning_type !== "market" && !meaning_id) return jsonResponse({ error: "meaning_id is required for product/species" }, 400);

      await sql`
        insert into market_flash_term_aliases (term, meaning_type, meaning_id, created_by)
        values (${raw_cut_name}, ${meaning_type}, ${meaning_id ?? null}, ${actor ?? null})
        on conflict (term) do update set meaning_type = excluded.meaning_type, meaning_id = excluded.meaning_id
      `;

      const hasData = trend_pct != null || !!note || mx_benchmark_price_usd_kg != null;
      if (hasData && meaning_type === "product") {
        await sql`insert into product_market_notes (product_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, created_by) values (${meaning_id}, ${trend_pct ?? null}, ${note ?? null}, ${mx_benchmark_price_usd_kg ?? null}, ${mx_benchmark_region ?? null}, ${actor ?? null})`;
      } else if (hasData && meaning_type === "species") {
        await sql`insert into product_market_notes (category_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, created_by) values (${meaning_id}, ${trend_pct ?? null}, ${note ?? null}, ${mx_benchmark_price_usd_kg ?? null}, ${mx_benchmark_region ?? null}, ${actor ?? null})`;
      }

      await sql`update product_market_note_suggestions set status = 'approved', reviewed_by = ${actor ?? null}, reviewed_at = now() where raw_cut_name = ${raw_cut_name} and status = 'pending'`;
      return jsonResponse({ taught: true });
    }

    // Real addition 2026-09-22 ("una pestaña donde queden las bullets... conectando con producto
    // correcto con proteína correcta con cliente correcto"): the one visibility screen — every
    // active note (product- or species-scoped), joined with the REAL customers linked to that
    // product/category (customer_products), so "who this applies to" is never a guess or a
    // separate lookup. Plus whatever's still waiting to be taught, plus every term already learned
    // (so the trader can see/undo what the system knows, same as Plants' "Recognized Words").
    if (body.list_market_flash) {
      const productNotes = await sql`
        select pmn.id, pmn.product_id, pmn.trend_pct, pmn.note, pmn.note_date,
          pmn.mx_benchmark_price_usd_kg, pmn.mx_benchmark_region, p.full_name_en as product_name,
          coalesce((
            select array_agg(c.trade_name order by c.trade_name)
            from customer_products cp join customers c on c.id = cp.customer_id
            where cp.product_id = pmn.product_id
          ), '{}') as customer_names
        from product_market_notes pmn
        join products p on p.id = pmn.product_id
        where pmn.product_id is not null and pmn.note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
        order by pmn.note_date desc
      `;
      const categoryNotes = await sql`
        select pmn.id, pmn.category_id, pmn.trend_pct, pmn.note, pmn.note_date,
          pmn.mx_benchmark_price_usd_kg, pmn.mx_benchmark_region, cat.name_en as category_name,
          coalesce((
            select array_agg(distinct c.trade_name order by c.trade_name)
            from customer_products cp
            join customers c on c.id = cp.customer_id
            join products p2 on p2.id = cp.product_id
            where p2.category_id = pmn.category_id
          ), '{}') as customer_names
        from product_market_notes pmn
        join categories cat on cat.id = pmn.category_id
        where pmn.category_id is not null and pmn.note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
        order by pmn.note_date desc
      `;
      const pending = await sql`
        select id, bulletin_date, raw_cut_name, trend_pct, note, created_at
        from product_market_note_suggestions where status = 'pending' order by bulletin_date desc, created_at desc
      `;
      const aliases = await sql`
        select a.id, a.term, a.meaning_type, a.meaning_id, a.created_at,
          case when a.meaning_type = 'product' then p.full_name_en when a.meaning_type = 'species' then cat.name_en else null end as meaning_label
        from market_flash_term_aliases a
        left join products p on a.meaning_type = 'product' and p.id = a.meaning_id
        left join categories cat on a.meaning_type = 'species' and cat.id = a.meaning_id
        order by a.created_at desc
      `;
      return jsonResponse({ product_notes: productNotes, category_notes: categoryNotes, pending, aliases });
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

    // Real correction 2026-09-22 ("nunca ir a mano a un producto"): read-only here now — no more
    // per-product edit/teach UI, that all happens once in the Market Flash screen. Product-specific
    // note wins; falls back to this product's own category-wide note, same coalesce as
    // computeCustomerProductSignal, so what's shown here never disagrees with what a quote sends.
    const [marketNoteRow] = await sql`
      select trend_pct, note, note_date, mx_benchmark_price_usd_kg, mx_benchmark_region from product_market_notes
      where product_id = ${product_id} and note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
      order by note_date desc, created_at desc
      limit 1
    `;
    const marketNote = marketNoteRow ?? (await sql`
      select pmn.trend_pct, pmn.note, pmn.note_date, pmn.mx_benchmark_price_usd_kg, pmn.mx_benchmark_region
      from product_market_notes pmn
      join products p on p.category_id = pmn.category_id
      where p.id = ${product_id} and pmn.category_id is not null
        and pmn.note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
      order by pmn.note_date desc, pmn.created_at desc
      limit 1
    `)[0];

    return jsonResponse({ results, trend, market_note: marketNote ?? null });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
