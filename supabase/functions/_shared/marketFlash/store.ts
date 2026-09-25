// Market Flash v2 persistence + reading. The trader classifies nothing: ingest reads the bulletin, every bullet is
// stored, and what a bullet MEANS in the catalog is resolved at read time from market_flash_term_aliases (taught
// once through Pending Matches — same "learn once" shape as plants), so teaching a term applies at once to every
// stored bulletin. Delivery to customers never repeats a bullet (market_flash_bullet_sends).
import { runDeterministic } from "./pipeline.ts";
import { narrativeBullets, src as sourceNoteFor } from "./bullets.ts";
import type { Bullet } from "./bullets.ts";
import { trendBullets } from "./compare.ts";
import { readNarrative } from "./narrative.ts";
import type { NarrativeSection } from "./narrative.ts";
import { callClaude } from "./claude.ts";
import { itemsFromCompact, layoutText, narrativeSections, readPdfItems } from "./pdf.ts";
import type { Fact } from "./types.ts";

export const FRESHNESS_DAYS = 21; // a bulletin's bullets stay usable this long after its data date (bi-weekly cadence + slack)
const SPECIES_BY_CATEGORY: Record<string, string> = { Pork: "pork", Beef: "beef", Chicken: "chicken", Turkey: "turkey" };

// ---------------------------------------------------------------- catalog + term resolution
export interface Family {
  key: string; kind: "product_family" | "product_name";
  category_id: string; category_en: string; species: string | null;
  name_en: string; name_es: string; subcategory_en: string | null; label_es: string; label_en: string; product_ids: string[]; search: string;
}
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const stem = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const toks = (s: string) => norm(s).split(" ").filter(Boolean).map(stem);

export async function loadCatalog(sql: any) {
  const cats = await sql`select id, name, name_en from categories`;
  const prods = await sql`select id, category_id, name, name_en, subcategory, subcategory_en from products`;
  const catById = new Map<string, any>(cats.map((c: any) => [c.id, c]));
  const fams = new Map<string, Family>(), names = new Map<string, Family>();
  for (const p of prods) {
    const c = catById.get(p.category_id);
    if (!c) continue;
    const species = SPECIES_BY_CATEGORY[c.name_en] ?? null;
    const fk = `f|${p.category_id}|${p.name_en}|${p.subcategory_en ?? ""}`;
    if (!fams.has(fk)) fams.set(fk, {
      key: fk, kind: "product_family", category_id: p.category_id, category_en: c.name_en, species, name_en: p.name_en, name_es: p.name, subcategory_en: p.subcategory_en ?? null,
      label_es: [p.name, c.name, p.subcategory].filter(Boolean).join(" "), label_en: [c.name_en, p.name_en, p.subcategory_en].filter(Boolean).join(" — "), product_ids: [],
      search: norm([p.name_en, p.subcategory_en, p.name, p.subcategory, c.name_en, c.name].filter(Boolean).join(" ")),
    });
    fams.get(fk)!.product_ids.push(p.id);
    const nk = `n|${p.category_id}|${p.name_en}`;
    if (!names.has(nk)) names.set(nk, {
      key: nk, kind: "product_name", category_id: p.category_id, category_en: c.name_en, species, name_en: p.name_en, name_es: p.name, subcategory_en: null,
      label_es: [p.name, c.name].filter(Boolean).join(" "), label_en: `${c.name_en} — ${p.name_en} (any grade)`, product_ids: [],
      search: norm([p.name_en, p.name, c.name_en, c.name].join(" ")),
    });
    names.get(nk)!.product_ids.push(p.id);
  }
  const productsByCategory = new Map<string, number>();
  for (const p of prods) productsByCategory.set(p.category_id, (productsByCategory.get(p.category_id) || 0) + 1);
  return { cats, prods, catById, families: [...fams.values()], names: [...names.values()], productsByCategory };
}
type Catalog = Awaited<ReturnType<typeof loadCatalog>>;

export interface Resolved { kind: "product" | "product_family" | "product_name"; product_ids: string[]; label_es: string; label_en: string; how: "alias" | "auto" }

// alias first; else an exact, UNIQUE name match (the company's own catalog names) — anything else waits in Pending Matches
export function resolveTerm(term: string, species: string | null, aliases: Map<string, any>, cat: Catalog): Resolved | null {
  const a = aliases.get(term.toLowerCase());
  if (a) {
    if (a.meaning_type === "product") {
      const p = cat.prods.find((x: any) => x.id === a.meaning_id);
      const c = p && cat.catById.get(p.category_id);
      if (p && c) return { kind: "product", product_ids: [p.id], label_es: [p.name, c.name, p.subcategory].filter(Boolean).join(" "), label_en: [c.name_en, p.name_en, p.subcategory_en].filter(Boolean).join(" — "), how: "alias" };
    } else if (a.meaning_type === "product_family") {
      const f = cat.families.find((x) => x.category_id === a.meaning_id && x.name_en === a.meaning_text && (x.subcategory_en ?? null) === (a.meaning_subtext ?? null));
      if (f) return { kind: "product_family", product_ids: f.product_ids, label_es: f.label_es, label_en: f.label_en, how: "alias" };
    } else if (a.meaning_type === "product_name") {
      const f = cat.names.find((x) => x.category_id === a.meaning_id && x.name_en === a.meaning_text);
      if (f) return { kind: "product_name", product_ids: f.product_ids, label_es: f.label_es, label_en: f.label_en, how: "alias" };
    }
    return null; // an alias that no longer points at anything real is treated as unresolved, never guessed around
  }
  // no alias: auto-match ONLY on an exact, unique name (the company's own catalog English or Spanish name) with no grade
  // split behind it — anything else waits in Pending Matches for a human (never crosses grade/size, never guesses)
  const same = (a: string, b: string) => toks(a).join(" ") === toks(b).join(" ");
  const inCat = (f: Family) => !species || f.species === species;
  const hits = cat.families.filter((f) => inCat(f) && (same(f.name_en, term) || same(f.name_es, term)));
  if (hits.length === 1) { const f = hits[0]; return { kind: "product_family", product_ids: f.product_ids, label_es: f.label_es, label_en: f.label_en, how: "auto" }; }
  return null;
}

export function suggest(term: string, species: string | null, cat: Catalog, limit = 6): string[] {
  const tt = new Set(toks(term));
  const scored = [...cat.families, ...cat.names.filter((n) => cat.families.filter((f) => f.category_id === n.category_id && f.name_en === n.name_en).length > 1)]
    .filter((f) => !species || f.species === species)
    .map((f) => { const ft = new Set(toks(f.search)); const nameT = new Set(toks(f.name_en)); let s = 0; for (const w of tt) if (ft.has(w)) s += nameT.has(w) ? 2 : 1; return { f, s }; })
    .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, limit);
  return scored.map((x) => x.f.key);
}

async function loadAliases(sql: any): Promise<Map<string, any>> {
  const rows = await sql`select term, meaning_type, meaning_id, meaning_text, meaning_subtext from market_flash_term_aliases`;
  return new Map(rows.map((r: any) => [String(r.term).toLowerCase(), r]));
}

// ---------------------------------------------------------------- ingest (write, idempotent by file hash)
const dbBullet = (b: Bullet, validUntil: string) => ({
  key: b.key, kind: b.kind, levels: b.levels, species: b.species, market: b.market, product_entity: b.product_entity, text_es: b.text_es,
  quote_en: b.quote_en ?? null, source_note: b.source_note, page: b.page, computed: b.computed, valid_until: validUntil,
});

// Both entry points converge on the PDF's text items: the manual upload sends them already read by the browser
// (`items` + the sha-256 of the file as `file_hash`), the email/API path will hand over the PDF itself
// (`pdf_base64`). From the items on — layout, tables, narrative, idempotency — it is one and the same code.
export async function ingestBulletin(sql: any, p: { pdf_base64?: string; items?: unknown; file_hash?: string; actor: string; source?: string }) {
  let file_hash: string, items: ReturnType<typeof itemsFromCompact>;
  if (p.items) {
    if (!p.file_hash || !/^[a-f0-9]{64}$/.test(p.file_hash)) return { error: "file_hash (sha-256 of the PDF) is required with items" };
    file_hash = p.file_hash;
    items = itemsFromCompact(p.items);
    if (!items) return { error: "items are not in the expected [text, x, y] per page shape" };
  } else if (p.pdf_base64) {
    let bytes: Uint8Array;
    try { const bin = atob(p.pdf_base64); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); } catch { return { error: "pdf_base64 is not valid base64" }; }
    if (bytes.length < 10000 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "%PDF") return { error: "that is not a PDF" };
    file_hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const [dup] = await sql`select 1 from market_flash_bulletins where file_hash = ${file_hash}`;
    items = dup ? [] : await readPdfItems(bytes);
  } else return { error: "items (with file_hash) or pdf_base64 is required" };
  const [existing] = await sql`select id, as_of from market_flash_bulletins where file_hash = ${file_hash}`;
  if (existing) { const [c] = await sql`select count(*)::int n from market_flash_bullets where bulletin_id = ${existing.id}`; return { bulletin_id: existing.id, as_of: String(existing.as_of instanceof Date ? existing.as_of.toISOString().slice(0, 10) : existing.as_of), bullets: c.n, idempotent_replay: true }; }
  if (!items) return { error: "could not read the bulletin" };
  const det = runDeterministic(layoutText(items));
  if (!det.asOf) return { error: "this does not look like the bi-weekly bulletin (no weekly production data date found)" };
  let narrative: { claims: any[]; dropped: any[]; error: string | null } = { claims: [], dropped: [], error: null };
  const sections = narrativeSections(items);
  if (sections.length) { try { const r = await readNarrative(sections, callClaude); narrative = { ...r, error: null }; } catch (e) { narrative.error = String((e as Error).message || e); } }
  const [prev] = await sql`select id, facts, as_of from market_flash_bulletins where as_of < ${det.asOf} order by as_of desc limit 1`;
  const trends = prev ? trendBullets(det.facts, prev.facts as Fact[], (f) => sourceNoteFor(f, det.asOf)) : [];
  const all: Bullet[] = [...det.bullets, ...narrativeBullets(narrative.claims, det.asOf), ...trends];
  const validUntil = new Date(Date.parse(det.asOf) + FRESHNESS_DAYS * 86400000).toISOString().slice(0, 10);
  const seen = new Set<string>(); const rows = all.filter((b) => (seen.has(b.key) ? false : (seen.add(b.key), true))).map((b) => dbBullet(b, validUntil));
  const bulletinId = await sql.begin(async (tx: any) => {
    const [b] = await tx`
      insert into market_flash_bulletins (as_of, file_hash, source, facts, per_source, dropped, created_by)
      values (${det.asOf}, ${file_hash}, ${p.source ?? "upload"}, ${tx.json(det.facts)}, ${tx.json(det.perSource)}, ${tx.json([...det.dropped, ...narrative.dropped])}, ${p.actor})
      on conflict (file_hash) do nothing returning id`;
    if (!b) return null;
    // one statement for all bullets (313 single inserts took ~50 s over the network)
    await tx`
      insert into market_flash_bullets (bulletin_id, key, kind, levels, species, market, product_entity, text_es, quote_en, source_note, page, computed, valid_until)
      select ${b.id}, x.key, x.kind, array(select jsonb_array_elements_text(x.levels)), x.species, x.market, x.product_entity, x.text_es, x.quote_en, x.source_note, x.page, x.computed, x.valid_until
      from jsonb_to_recordset(${tx.json(rows)}) as x(key text, kind text, levels jsonb, species text, market text, product_entity text, text_es text, quote_en text, source_note text, page int, computed boolean, valid_until date)
      on conflict (bulletin_id, key) do nothing`;
    return b.id;
  });
  return { bulletin_id: bulletinId, as_of: det.asOf, bullets: rows.length, trend_bullets: trends.length, narrative_error: narrative.error, previous_edition: prev?.as_of ?? null };
}

// ---------------------------------------------------------------- read: the three tabs + Pending Matches
async function latestBulletin(sql: any) {
  const [b] = await sql`select id, as_of, created_at, source, per_source, dropped from market_flash_bulletins order by as_of desc, created_at desc limit 1`;
  return b ?? null;
}
const render = (text: string, r: Resolved | null) => (text.includes("{{CUT}}") ? (r ? text.replaceAll("{{CUT}}", r.label_es) : null) : text);

export async function listMarketFlash(sql: any) {
  const b = await latestBulletin(sql);
  const cat = await loadCatalog(sql);
  const options = [...cat.families, ...cat.names.filter((n) => cat.families.filter((f) => f.category_id === n.category_id && f.name_en === n.name_en).length > 1)]
    .map((f) => ({ key: f.key, kind: f.kind, species: f.species, category_en: f.category_en, label_en: f.label_en, label_es: f.label_es, search: f.search, product_count: f.product_ids.length, category_id: f.category_id, name_en: f.name_en, subcategory_en: f.subcategory_en }));
  if (!b) return { bulletin: null, product: [], protein: {}, market: {}, pending: [], catalog_options: options, counts: { product: 0, protein: 0, market: 0, pending: 0 } };
  const bullets = await sql`select id, kind, levels, species, market, product_entity, text_es, quote_en, source_note, page, computed, valid_until from market_flash_bullets where bulletin_id = ${b.id} order by key`;
  bullets.sort((a: any, b: any) => prio(a.kind) - prio(b.kind)); // current price first, wider context after
  const aliases = await loadAliases(sql);
  const links = await sql`select cp.customer_id, cp.product_id, c.trade_name, co.name_en as country from customer_products cp join customers c on c.id = cp.customer_id left join countries co on co.id = c.country_id`;
  const sentRows = await sql`select bullet_id, count(*)::int n from market_flash_bullet_sends where bullet_id in (select id from market_flash_bullets where bulletin_id = ${b.id}) group by 1`;
  const sent = new Map<string, number>(sentRows.map((r: any) => [r.bullet_id, r.n]));
  const allCustomers = await sql`select c.id, c.trade_name, co.name_en as country from customers c left join countries co on co.id = c.country_id`;
  const catBySpecies = new Map<string, string>(cat.cats.filter((c: any) => SPECIES_BY_CATEGORY[c.name_en]).map((c: any) => [SPECIES_BY_CATEGORY[c.name_en], c.id]));
  const productCategory = new Map<string, string>(cat.prods.map((p: any) => [p.id, p.category_id]));
  const customersFor = (productIds: string[]) => [...new Map(links.filter((l: any) => productIds.includes(l.product_id)).map((l: any) => [l.customer_id, l.trade_name])).values()] as string[];
  const customersForSpecies = (sp: string) => { const cid = catBySpecies.get(sp); return [...new Map(links.filter((l: any) => productCategory.get(l.product_id) === cid).map((l: any) => [l.customer_id, l.trade_name])).values()] as string[]; };

  const product = new Map<string, any>(), protein: Record<string, any[]> = {}, market: Record<string, any[]> = {};
  const pendingMap = new Map<string, { term: string; species: string | null; kinds: Set<string>; count: number; example: string }>();
  const resolvedCache = new Map<string, Resolved | null>();
  for (const bl of bullets) {
    let r: Resolved | null = null;
    if (bl.product_entity) {
      if (!resolvedCache.has(bl.product_entity)) resolvedCache.set(bl.product_entity, resolveTerm(bl.product_entity, bl.species, aliases, cat));
      r = resolvedCache.get(bl.product_entity)!;
    }
    const text = render(bl.text_es, r);
    if (text == null) {
      const hasProducts = !bl.species || [...cat.cats].some((c: any) => SPECIES_BY_CATEGORY[c.name_en] === bl.species && (cat.productsByCategory.get(c.id) || 0) > 0);
      const pm = pendingMap.get(bl.product_entity) ?? { term: bl.product_entity, species: bl.species, kinds: new Set<string>(), count: 0, example: "", no_catalog: !hasProducts } as any;
      pm.count++; pm.kinds.add(bl.kind); if (!pm.example) pm.example = bl.text_es.replaceAll("{{CUT}}", `«${bl.product_entity}»`);
      pendingMap.set(bl.product_entity, pm as any);
      continue;
    }
    const item = { id: bl.id, kind: bl.kind, text_es: text, quote_en: bl.quote_en, source_note: bl.source_note, computed: bl.computed, levels: bl.levels, sent_count: sent.get(bl.id) || 0, species: bl.species, market: bl.market, valid_until: bl.valid_until };
    if (bl.levels.includes("product") && r) {
      const g = product.get(r.label_es) ?? { label_es: r.label_es, label_en: r.label_en, species: bl.species, product_ids: r.product_ids, customers: customersFor(r.product_ids), bullets: [] };
      g.bullets.push(item); product.set(r.label_es, g);
    }
    if (bl.levels.includes("protein") && bl.species) (protein[bl.species] ||= []).push(item);
    if (bl.levels.includes("market")) (market[bl.market] ||= []).push(item);
  }
  const pending = [...pendingMap.values()].map((p: any) => ({ term: p.term, species: p.species, kinds: [...p.kinds], bullet_count: p.count, example: p.example, no_catalog: !!p.no_catalog, suggested_keys: p.no_catalog ? [] : suggest(p.term, p.species, cat) }))
    .sort((a, b) => Number(a.no_catalog) - Number(b.no_catalog) || b.bullet_count - a.bullet_count);
  const mx = allCustomers.filter((c: any) => c.country === "Mexico").map((c: any) => c.trade_name);
  return {
    bulletin: { id: b.id, as_of: b.as_of, created_at: b.created_at, source: b.source, per_source: b.per_source, dropped_count: (b.dropped || []).length },
    product: [...product.values()].sort((a, c) => a.label_es.localeCompare(c.label_es)),
    protein: Object.fromEntries(Object.entries(protein).map(([sp, arr]) => [sp, { bullets: arr, customers: customersForSpecies(sp) }])),
    market: Object.fromEntries(Object.entries(market).map(([m, arr]) => [m, { bullets: arr, customers: m === "MX" ? mx : allCustomers.map((c: any) => c.trade_name) }])),
    pending, catalog_options: options,
    counts: { product: [...product.values()].reduce((n, g) => n + g.bullets.length, 0), protein: Object.values(protein).reduce((n, a) => n + a.length, 0), market: Object.values(market).reduce((n, a) => n + a.length, 0), pending: pending.filter((p) => !p.no_catalog).length },
  };
}

// ---------------------------------------------------------------- teach a term (Pending Matches) — idempotent upsert
export async function teachTerm(sql: any, p: { term: string; option_key: string; actor: string }) {
  if (!p.term || !p.option_key) return { error: "term and option_key are required" };
  const cat = await loadCatalog(sql);
  const opt = [...cat.families, ...cat.names].find((f) => f.key === p.option_key);
  if (!opt) return { error: "unknown catalog option" };
  const sub = opt.kind === "product_family" ? opt.subcategory_en : null;
  await sql`
    insert into market_flash_term_aliases (term, meaning_type, meaning_id, meaning_text, meaning_subtext, created_by)
    values (${p.term}, ${opt.kind}, ${opt.category_id}, ${opt.name_en}, ${sub}, ${p.actor})
    on conflict (term) do update set meaning_type = excluded.meaning_type, meaning_id = excluded.meaning_id, meaning_text = excluded.meaning_text, meaning_subtext = excluded.meaning_subtext, created_by = excluded.created_by`;
  return { learned: true, term: p.term, meaning: opt.label_en };
}

// What a customer should read first: the current price of THEIR product, then how it moved, then wider context.
const KIND_PRIORITY = ["cut_price_weekly", "mx_pork_price", "trend_vs_previous", "cut_price_forecast_week", "cold_storage", "prod_weekly", "export_change", "narrative_observed", "narrative_view", "cut_price_forecast_month", "prod_ytd", "prod_forecast", "cold_storage_total", "hog_price_us_mx", "cattle_on_feed", "futures", "hogs_pigs"];
const prio = (k: string) => { const i = KIND_PRIORITY.indexOf(k); return i < 0 ? KIND_PRIORITY.length : i; };

// ---------------------------------------------------------------- delivery: pick unsent bullets for one customer+product, log real sends
// customerId null = no customer context (read-only product view): nothing is filtered as "already sent".
export async function pickBulletsForCustomerProduct(sql: any, customerId: string | null, productId: string, max = 2) {
  const [b] = await sql`select id from market_flash_bulletins where as_of >= (current_date - ${FRESHNESS_DAYS}::int) order by as_of desc, created_at desc limit 1`;
  if (!b) return [];
  const cat = await loadCatalog(sql);
  const prod = cat.prods.find((p: any) => p.id === productId);
  const category = prod && cat.catById.get(prod.category_id);
  const species = category ? SPECIES_BY_CATEGORY[category.name_en] ?? null : null;
  const [cust] = customerId ? await sql`select co.name_en as country from customers c left join countries co on co.id = c.country_id where c.id = ${customerId}` : [null];
  const aliases = await loadAliases(sql);
  const bullets = await sql`
    select bl.id, bl.kind, bl.levels, bl.species, bl.market, bl.product_entity, bl.text_es from market_flash_bullets bl
    where bl.bulletin_id = ${b.id} and bl.valid_until >= current_date
      and (${customerId}::uuid is null or not exists (select 1 from market_flash_bullet_sends s where s.bullet_id = bl.id and s.customer_id = ${customerId}))
    order by bl.key`;
  const cache = new Map<string, Resolved | null>();
  const tiers: Array<Array<{ id: string; text: string; kind: string; entity: string | null }>> = [[], [], []];
  for (const bl of bullets) {
    let r: Resolved | null = null;
    if (bl.product_entity) { if (!cache.has(bl.product_entity)) cache.set(bl.product_entity, resolveTerm(bl.product_entity, bl.species, aliases, cat)); r = cache.get(bl.product_entity)!; }
    const text = render(bl.text_es, r);
    if (text == null) continue;
    const item = { id: bl.id, text, kind: bl.kind, entity: bl.product_entity as string | null };
    if (bl.levels.includes("product") && r && r.product_ids.includes(productId)) tiers[0].push(item);
    else if (bl.levels.includes("protein") && species && bl.species === species && !bl.product_entity) tiers[1].push(item);
    else if (bl.levels.includes("market") && !bl.product_entity && (bl.market === "US" || cust?.country === "Mexico")) tiers[2].push(item);
  }
  // most specific first; one bullet per kind AND per product term, so a message never repeats the same shape or says
  // two things about the same cut (e.g. its current price and its comparison, which read as one repeated line)
  const out: typeof tiers[0] = [], kinds = new Set<string>(), entities = new Set<string>();
  for (const tier of tiers) for (const it of tier.sort((a, b) => prio(a.kind) - prio(b.kind))) { if (out.length >= max) break; if (kinds.has(it.kind) || (it.entity && entities.has(it.entity))) continue; kinds.add(it.kind); if (it.entity) entities.add(it.entity); out.push(it); }
  return out;
}

export async function logBulletSends(sql: any, p: { bullet_ids: string[]; customer_id: string; channel?: string; actor: string }) {
  if (!Array.isArray(p.bullet_ids) || !p.bullet_ids.length || !p.customer_id) return { error: "bullet_ids and customer_id are required" };
  for (const id of p.bullet_ids) {
    await sql`insert into market_flash_bullet_sends (bullet_id, customer_id, channel, sent_by) values (${id}, ${p.customer_id}, ${p.channel ?? null}, ${p.actor}) on conflict (bullet_id, customer_id) do nothing`;
  }
  return { logged: p.bullet_ids.length };
}
