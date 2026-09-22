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
// Real correction 2026-09-22, twice same day ("no quiero editar producto por producto... esto
// tiene que ir conectado a who buy this" / "busca plants y construyelo igual — upload popup
// después cierro y salen bullets bien hechas"): matches plants.html's own "Load Prices" mechanic
// exactly — nothing is written to the database until ONE final batch commit. The real flow:
//
//   1. preview_market_flash_lines — READ-ONLY. For each pasted line, checks market_flash_term_
//      aliases (case-insensitive exact match on the term — same proven "learn the language" shape
//      as plant_term_aliases) and reports back whether it's already known and what it means.
//      Nothing is written here, same as plants.html's processPriceListText/products-match-from-
//      plant-text being read-only until Apply.
//   2. Market Flash Admin holds the whole reviewed batch in browser memory (known rows shown as
//      already-resolved, unknown rows get a product/species/market choice) — Cancel loses
//      everything, Apply All commits everything in one shot.
//   3. teach_term — the ONE write per row, called once per line at Apply time (batched):
//      remembers the term in market_flash_term_aliases forever (so it's read-only/known next
//      Market Flash) AND applies the note now. Called for every row in the batch, not just new
//      ones — a previously-known term still needs this to record THIS bulletin's actual numbers,
//      the alias only remembers the MEANING, never the changing data.
//   4. list_market_flash — the one visibility screen: every active note (product- or category-
//      scoped), joined with the REAL customers linked to that product/category (customer_products).
//
// product_market_notes.product_id is nullable — a note is either product-scoped or category_id-
// scoped (species-wide), never both (DB check constraint).
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

    // Real correction 2026-09-22 ("upload popup después cierro y salen bullets bien hechas"):
    // READ-ONLY, matches plants.html's processPriceListText step exactly — parses nothing server-
    // side (that's client JS), just answers "does market_flash_term_aliases already know this
    // term" for each line, so Market Flash Admin can render known rows as already-resolved and
    // unknown rows with a product/species/market choice, ALL still in browser memory. Nothing
    // written here.
    if (body.preview_market_flash_lines) {
      const { lines } = body.preview_market_flash_lines;
      if (!Array.isArray(lines) || !lines.length) return jsonResponse({ error: "preview_market_flash_lines requires a non-empty lines array" }, 400);
      const terms = lines.map((l: any) => l?.raw_cut_name).filter(Boolean);
      const aliasRows = terms.length
        ? await sql`
            select a.term, a.meaning_type, a.meaning_id, a.meaning_text,
              case
                when a.meaning_type = 'product' then p.full_name_en
                when a.meaning_type = 'species' then cat.name_en
                when a.meaning_type = 'product_family' then famcat.name_en || ' — ' || a.meaning_text || ' (all variants)'
                else null
              end as meaning_label
            from market_flash_term_aliases a
            left join products p on a.meaning_type = 'product' and p.id = a.meaning_id
            left join categories cat on a.meaning_type = 'species' and cat.id = a.meaning_id
            left join categories famcat on a.meaning_type = 'product_family' and famcat.id = a.meaning_id
            where lower(a.term) = any(${terms.map((t: string) => t.toLowerCase())})
          `
        : [];
      const aliasByTerm = new Map(aliasRows.map((r: any) => [String(r.term).toLowerCase(), r]));
      const rows = lines.map((l: any) => {
        const alias = l?.raw_cut_name ? aliasByTerm.get(String(l.raw_cut_name).toLowerCase()) : null;
        return {
          raw_cut_name: l?.raw_cut_name, trend_pct: l?.trend_pct ?? null,
          known: !!alias,
          meaning_type: alias?.meaning_type ?? null, meaning_id: alias?.meaning_id ?? null,
          meaning_text: alias?.meaning_text ?? null, meaning_label: alias?.meaning_label ?? null,
        };
      });
      return jsonResponse({ rows });
    }

    // Real addition 2026-09-22: the single write per row, called once per line at "Apply All" time
    // (batched from the client, same as plants.html's applyPriceList firing one call per row).
    // meaning_type: 'product' (meaning_id = a real product), 'species' (meaning_id = a real
    // category/protein), or 'market' (no association at all, meaning_id stays null). Always
    // remembers the term in market_flash_term_aliases (upsert — safe to call again for an already-
    // known term, it just re-confirms the same meaning) AND applies THIS bulletin's real numbers as
    // a fresh product_market_notes row — the alias only remembers the meaning, never the changing
    // data, so a known term still needs this call every time to record today's actual %.
    if (body.teach_term) {
      const { raw_cut_name, meaning_type, meaning_id, meaning_text, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, actor } = body.teach_term;
      if (!raw_cut_name || !meaning_type) return jsonResponse({ error: "teach_term requires raw_cut_name and meaning_type" }, 400);
      if (!["product", "species", "product_family", "market"].includes(meaning_type)) return jsonResponse({ error: "meaning_type must be product, species, product_family, or market" }, 400);
      if (meaning_type !== "market" && !meaning_id) return jsonResponse({ error: "meaning_id is required for product/species/product_family" }, 400);
      // product_family: meaning_id is the category_id (scopes the family so it never crosses
      // categories), meaning_text is the shared products.name_en that groups the real SKUs (e.g.
      // "Picnic" — 6 real Bone-In/Boneless x Fresh/Frozen x Combo/Box/VAC/Poly rows).
      if (meaning_type === "product_family" && !meaning_text) return jsonResponse({ error: "meaning_text (the shared product name) is required for product_family" }, 400);

      await sql`
        insert into market_flash_term_aliases (term, meaning_type, meaning_id, meaning_text, created_by)
        values (${raw_cut_name}, ${meaning_type}, ${meaning_id ?? null}, ${meaning_type === "product_family" ? meaning_text : null}, ${actor ?? null})
        on conflict (term) do update set meaning_type = excluded.meaning_type, meaning_id = excluded.meaning_id, meaning_text = excluded.meaning_text
      `;

      const hasData = trend_pct != null || !!note || mx_benchmark_price_usd_kg != null;
      if (hasData && meaning_type === "product") {
        await sql`insert into product_market_notes (product_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, created_by) values (${meaning_id}, ${trend_pct ?? null}, ${note ?? null}, ${mx_benchmark_price_usd_kg ?? null}, ${mx_benchmark_region ?? null}, ${actor ?? null})`;
      } else if (hasData && meaning_type === "species") {
        await sql`insert into product_market_notes (category_id, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, created_by) values (${meaning_id}, ${trend_pct ?? null}, ${note ?? null}, ${mx_benchmark_price_usd_kg ?? null}, ${mx_benchmark_region ?? null}, ${actor ?? null})`;
      } else if (hasData && meaning_type === "product_family") {
        await sql`insert into product_market_notes (category_id, product_name_en, trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region, created_by) values (${meaning_id}, ${meaning_text}, ${trend_pct ?? null}, ${note ?? null}, ${mx_benchmark_price_usd_kg ?? null}, ${mx_benchmark_region ?? null}, ${actor ?? null})`;
      }
      return jsonResponse({ taught: true });
    }

    // Real addition 2026-09-22 ("una pestaña donde queden las bullets... conectando con producto
    // correcto con proteína correcta con cliente correcto"): the one visibility screen — every
    // active note (product- or species-scoped), joined with the REAL customers linked to that
    // product/category (customer_products), so "who this applies to" is never a guess or a
    // separate lookup, plus every term already learned.
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
        where pmn.category_id is not null and pmn.product_name_en is null
          and pmn.note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
        order by pmn.note_date desc
      `;
      // Real addition 2026-09-22 ("si no especifica que llegue a todos"): a family note reaches
      // every real customer of every product sharing this exact name_en within this category — the
      // 6 real Picnic SKUs (Bone-In/Boneless x Fresh/Frozen x Combo/Box/VAC/Poly) all count as one
      // audience, never just the one row a trader might otherwise have had to pick arbitrarily.
      const familyNotes = await sql`
        select pmn.id, pmn.category_id, pmn.product_name_en, pmn.trend_pct, pmn.note, pmn.note_date,
          pmn.mx_benchmark_price_usd_kg, pmn.mx_benchmark_region, cat.name_en as category_name,
          coalesce((
            select array_agg(distinct c.trade_name order by c.trade_name)
            from customer_products cp
            join customers c on c.id = cp.customer_id
            join products p2 on p2.id = cp.product_id
            where p2.category_id = pmn.category_id and p2.name_en = pmn.product_name_en
          ), '{}') as customer_names
        from product_market_notes pmn
        join categories cat on cat.id = pmn.category_id
        where pmn.product_name_en is not null
          and pmn.note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
        order by pmn.note_date desc
      `;
      // Every term already learned, so the trader can see/undo what the system knows — same idea
      // as Plants' "Recognized Words" screen.
      const aliases = await sql`
        select a.id, a.term, a.meaning_type, a.meaning_id, a.meaning_text, a.created_at,
          case
            when a.meaning_type = 'product' then p.full_name_en
            when a.meaning_type = 'species' then cat.name_en
            when a.meaning_type = 'product_family' then famcat.name_en || ' — ' || a.meaning_text || ' (all variants)'
            else null
          end as meaning_label
        from market_flash_term_aliases a
        left join products p on a.meaning_type = 'product' and p.id = a.meaning_id
        left join categories cat on a.meaning_type = 'species' and cat.id = a.meaning_id
        left join categories famcat on a.meaning_type = 'product_family' and famcat.id = a.meaning_id
        order by a.created_at desc
      `;
      return jsonResponse({ product_notes: productNotes, category_notes: categoryNotes, family_notes: familyNotes, aliases });
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
    // Same 3-tier precedence as computeCustomerProductSignal (product-specific, then family, then
    // category-wide) so this read-only display never disagrees with what a quote actually sends.
    const familyNoteRow = marketNoteRow ? null : (await sql`
      select pmn.trend_pct, pmn.note, pmn.note_date, pmn.mx_benchmark_price_usd_kg, pmn.mx_benchmark_region
      from product_market_notes pmn
      join products p on p.category_id = pmn.category_id and p.name_en = pmn.product_name_en
      where p.id = ${product_id} and pmn.product_name_en is not null
        and pmn.note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
      order by pmn.note_date desc, pmn.created_at desc
      limit 1
    `)[0];
    const marketNote = marketNoteRow ?? familyNoteRow ?? (await sql`
      select pmn.trend_pct, pmn.note, pmn.note_date, pmn.mx_benchmark_price_usd_kg, pmn.mx_benchmark_region
      from product_market_notes pmn
      join products p on p.category_id = pmn.category_id
      where p.id = ${product_id} and pmn.category_id is not null and pmn.product_name_en is null
        and pmn.note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
      order by pmn.note_date desc, pmn.created_at desc
      limit 1
    `)[0];

    return jsonResponse({ results, trend, market_note: marketNote ?? null });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
