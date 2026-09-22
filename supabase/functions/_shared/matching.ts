// Shared across every Edge Function that has to answer "is this the same thing as something that
// already exists, or genuinely new?" — products, suppliers, plants, customers all need the exact
// same discipline (case/typo-insensitive comparison, never a silent guess, never a dead end).
// One copy, imported everywhere, so a fix or a rule change happens once, not once per function.

import { createHmac } from "node:crypto";

// Real bug caught live 2026-09-16, same class already hit once in plants.html (toDateOnly) and
// documented there: a `date` column comes back from postgres.js as a JS Date object, and
// String(dateObject) calls .toString() (locale format, "Wed Sep 16 2026...") — NOT .toISOString().
// Slicing that to 10 chars is not even a valid date string, and fed straight into a ::date column
// it silently parsed as some unrelated date (caught producing 2001-09-16 for an actual 2026-09-16)
// instead of throwing. Always go through this instead of `String(x).slice(0, 10)` on anything that
// might be a Date object coming back from a query result.
export function toDateOnly(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export function normalize(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeLoose(s: string | null | undefined): string {
  return normalize(s).replace(/\b(pork|beef|chicken|lamb)\b/g, "").replace(/\s+/g, " ").trim();
}

// Plain Levenshtein edit distance — small, dependency-free, exactly what's needed to catch a
// one-or-two-character slip ("St Luis" vs "St Louis") without flagging genuinely different names.
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

export function isNearDuplicate(a: string, b: string): boolean {
  if (!a || !b || a === b) return false;
  const dist = editDistance(a, b);
  const longer = Math.max(a.length, b.length);
  if (longer < 4) return false; // too short for edit-distance to mean anything
  return dist <= 2 && dist / longer < 0.3;
}

// Real ask 2026-09-18 ("bellies va solo, nunca con variation... que no deje a nadie juntarlo"):
// confirmed live against real data — 5 cut names ("Backribs #2", "Bellies #2", "Bellies 13/15",
// "Bellies 15/17", "42% Trim"/"72% Trim") had a size/grade/descriptor baked directly into the cut
// name text instead of living in the separate Variation field, and there was nothing stopping it
// from happening again. This is a hard, unconditional block (unlike the duplicate checks elsewhere
// in this file, which always allow an explicit override — Rule 5) because there is no legitimate
// case for a cut name or a product's own name/name_en to contain another catalog value verbatim;
// it is never "confirm this is genuinely different," it is always a data-entry mistake. Matches as
// a substring on normalized (lowercased, whitespace-collapsed) text — deliberately simple, since
// every real offender caught so far is a short, distinctive token (a number, a fraction, a %, or a
// short English/Spanish descriptor word) that would never coincidentally appear inside an unrelated
// cut name in this domain.
export function findEmbeddedVariation(
  candidateEn: string | null | undefined,
  candidateEs: string | null | undefined,
  categoryVariations: { name_en: string; name_es: string }[],
): { name_en: string; name_es: string } | null {
  const enText = normalize(candidateEn);
  const esText = normalize(candidateEs);
  for (const v of categoryVariations) {
    const vEn = normalize(v.name_en);
    const vEs = normalize(v.name_es);
    if (vEn && enText.includes(vEn)) return v;
    if (vEs && esText.includes(vEs)) return v;
  }
  return null;
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Rule 5, absolute, no exceptions (see feedback-catalog-matching-is-the-core-system, "never block
// even for a case-only duplicate that's obviously the same product") — every caller of this
// returns a 409 with the real candidate(s) and requires override_duplicate_check to proceed, never
// an unconditional refusal.
export function duplicateResponse(payload: Record<string, unknown>) {
  return new Response(JSON.stringify({ error: "possible_duplicate", ...payload }), {
    status: 409,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function jsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Every write, in every function, goes through this — one hash-chained audit_log row per write,
// in the SAME transaction as the write itself, so a row that exists with no audit trail (or the
// reverse) is impossible by construction.
// Real 2-letter USPS codes only (50 states + DC) — a price-list's FOB clause can end in any
// capitalized 2-letter word ("LH", a plant's own shorthand; "no docs" run together with the wrong
// regex flag elsewhere), and without validating against real codes, parseCityState below silently
// accepted any of them as a state. Caught live 2026-09-12: a Smithfield line reading "FOB Midwest,
// LH Sept ship" got parsed as city="Midwest", state="LH" and matchOrCreateLocationId actually
// INSERTED that into the real locations catalog — a bogus master-data row, not just a display bug.
export const US_STATE_CODES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA",
  "ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK",
  "OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

// "City, ST" / "City ST" only — a plant's pickup-location text is a mechanical fact (unlike a
// product cut name, there's no real linguistic ambiguity in a city+state pair), so this is the one
// place in the catalog-matching system that's allowed to auto-create rather than stop and ask.
// Confirmed real requirement 2026-08-30: "todo tiene que estar conectado... todo es automatico" —
// manual add stays available (providers.html's "+ Add New City to Catalog"), this is just the
// automatic path so a plant's own location never sits disconnected from the same catalog every
// carrier rate already resolves to. Anything that doesn't parse as a clean city+state (a warehouse
// name, a country, a region name like "Midwest", freeform notes) is left unlinked rather than
// guessed — the trailing token must be a REAL state code, not just two capital letters.
export function parseCityState(text: string | null | undefined): { city: string; state: string } | null {
  if (!text) return null;
  const m = text.trim().match(/^(.+?),?\s+([A-Za-z]{2})$/);
  if (!m) return null;
  const state = m[2].toUpperCase();
  if (!US_STATE_CODES.has(state)) return null;
  return { city: m[1].trim(), state };
}

export async function matchOrCreateLocationId(tx: any, locationName: string | null | undefined): Promise<string | null> {
  const parsed = parseCityState(locationName);
  if (!parsed) return null;
  const [existing] = await tx`select id from locations where lower(city) = lower(${parsed.city}) and upper(state) = upper(${parsed.state})`;
  if (existing) return existing.id;
  // Same race-safe insert-or-fetch shape as the price-list plant_id fix — two people (or a create
  // and a rate load) resolving the same brand-new city at the same instant never produces a
  // duplicate row or a lost write.
  const [created] = await tx`insert into locations (city, state) values (${parsed.city}, ${parsed.state}) on conflict (city, state) do nothing returning id`;
  if (created) return created.id;
  const [raced] = await tx`select id from locations where lower(city) = lower(${parsed.city}) and upper(state) = upper(${parsed.state})`;
  return raced ? raced.id : null;
}

// Credit-limit exposure (2026-09-12) — "si le he vendido al cliente 95 y tiene 100 de limite no le
// puedo vender mas hasta cobrar." One shared formula, used by every caller that gates on it
// (sent-offers-mark-won's softer check, sent-offers-log-event's hard block on the first plant
// contact, sent-offers-create's non-blocking customer warning) so it's never computed two
// different ways in parallel. Outstanding = every won-but-unpaid shipment's sale_amount, invoiced
// or not — a shipment row exists the moment an offer is won, so this counts real, already-sold
// exposure, not just what's been invoiced (a narrower AR-aging number collections-search shows,
// a different purpose).
//
// asOfDate (2026-09-16) — real ask: "si la carga es para una fecha despues de la fecha en que se
// le vence una factura en teoria si se la puedo vender." A shipment already delivered has a real
// payment_due_date (set in shipments-update-status); if that due date falls strictly before the
// NEW load's own delivery date, that old balance is presumed collected by then and is excluded
// from the projected exposure. A shipment with no payment_due_date yet (not delivered) always
// still counts — there's no future date to reason about it being paid by. Passing no asOfDate
// (existing callers before this date) keeps the exact previous flat-sum behavior.
export async function computeCustomerExposure(
  sql: any,
  customerId: string,
  asOfDate: string | null = null,
): Promise<{ creditLimit: number; outstanding: number } | null> {
  const [customer] = await sql`select credit_limit from customers where id = ${customerId}`;
  if (customer?.credit_limit == null) return null;
  const [{ outstanding }] = await sql`
    select coalesce(sum(sale_amount), 0) as outstanding from shipments
    where customer_id = ${customerId} and paid_at is null
      and (${asOfDate}::date is null or payment_due_date is null or payment_due_date >= ${asOfDate}::date)
  `;
  return { creditLimit: Number(customer.credit_limit), outstanding: Number(outstanding) };
}

// Same "which date do we mean" resolution used by every caller of computeCustomerExposure that
// only has a delivery_dates array (not yet a single confirmed date, see sent-offers-mark-won's
// confirmed_delivery_date) — the earliest one is the first point this new sale becomes real
// exposure, so it's the conservative choice: only balances due before THAT date are presumed paid.
export function earliestDeliveryDate(dates: unknown): string | null {
  if (!Array.isArray(dates) || dates.length === 0) return null;
  const valid = dates.filter((d): d is string => typeof d === "string" && d.length > 0).sort();
  return valid.length ? valid[0] : null;
}

// Market-wide price trend for a product (2026-09-16, final shape confirmed 2026-09-17) — every
// plant that sells it, not just one ("una cosa es el precio del producto de la misma marca y otra
// el precio del producto en el mercado, o sea todas las marcas"). Two real, independent facts, so
// a sparse product (few real prices this month) still gives the trader something honest to say:
//  1. trend — today's best price vs. the average of every price recorded in the prior 30 calendar
//     days. Null (no badge) when there's nothing in that window, never a fabricated percentage.
//  2. previous — the single most recent price before today's, whenever ANY earlier price exists
//     at all (no 30-day requirement) — "precio anterior vs precio actual," the plain fact the
//     trader can literally read out to a customer even when the 30-day trend has nothing to show.
export async function computeProductPriceSignal(
  sql: any,
  productId: string,
): Promise<{
  latestBest: number;
  trend: { avgPrior30d: number; pctChange: number } | null;
  previous: { price: number; priceDate: string } | null;
} | null> {
  const [row] = await sql`
    with latest as (select max(price_date) as d from price_history where product_id = ${productId}),
    -- Real gap caught 2026-09-18: "esta tomando el precio de cada planta, lo que quiere es el
    -- precio de mercado" — the aggregate numbers here already filter by product_id only (never
    -- plant_id), so they were always market-wide, not one plant's own price. But "previous" used
    -- to grab a single arbitrary row when two plants shared the same earlier date, instead of the
    -- market's best (min) that date — inconsistent with latest_best's own logic. Fixed: find the
    -- most recent PRIOR DATE with any price on file first, then take the min price across every
    -- plant on that specific date, mirroring latest_best exactly.
    previous_date as (
      select max(price_date) as d from price_history
      where product_id = ${productId} and price_date < (select d from latest)
    )
    select
      (select min(price) from price_history where product_id = ${productId} and price_date = (select d from latest)) as latest_best,
      (select avg(price) from price_history where product_id = ${productId}
         and price_date < (select d from latest) and price_date >= (select d from latest) - interval '30 days') as avg_prior_30d,
      (select min(price) from price_history where product_id = ${productId} and price_date = (select d from previous_date)) as previous_price,
      (select d from previous_date) as previous_price_date
  `;
  if (!row || row.latest_best == null) return null;
  const latestBest = Number(row.latest_best);
  let trend: { avgPrior30d: number; pctChange: number } | null = null;
  if (row.avg_prior_30d != null && Number(row.avg_prior_30d) !== 0) {
    const avgPrior30d = Number(row.avg_prior_30d);
    trend = { avgPrior30d, pctChange: ((latestBest - avgPrior30d) / avgPrior30d) * 100 };
  }
  const previous = row.previous_price != null
    ? { price: Number(row.previous_price), priceDate: row.previous_price_date }
    : null;
  if (!trend && !previous) return null;
  return { latestBest, trend, previous };
}

// The combined "necesidad" signal (2026-09-16) — real ask: "no quiero cotizarle a nadie sin que
// sepan que sabemos y creemos la necesidad." Joins the 3 axes already built (cupo con fecha,
// cadencia por cliente-producto, tendencia de precio de mercado) into one message, but ONLY states
// what's real — a customer with no cadence set, no price trend yet, and normal credit gets no
// message at all, never a filler reason to justify the contact. PRICE_FAVORABLE_THRESHOLD_PCT is a
// starting assumption (2%); revisit once real price_history accumulates and this gets used for
// real. Real order history comes from sales_orders (a row only exists once an offer is actually
// won, see sent-offers-mark-won) — never sent_offers, which also holds quotes that never closed.
const PRICE_FAVORABLE_THRESHOLD_PCT = -2;

// Shared with price-history-search's own save_market_note/read — a bit more than the bulletin's
// own bi-weekly cadence, so a note never keeps showing well past when the next one should replace it.
export const MARKET_NOTE_FRESHNESS_DAYS = 21;

export async function computeCustomerProductSignal(
  sql: any,
  customerId: string,
  productId: string,
): Promise<{
  cadence: { frequencyDays: number; loadsPerCycle: number | null } | null;
  priceTrend: { pctChange: number } | null;
  marketNote: {
    trendPct: number | null; note: string | null;
    mxBenchmarkPriceUsdKg: number | null; mxBenchmarkRegion: string | null;
  } | null;
  overCreditLimit: boolean;
} | null> {
  // Real correction 2026-09-22: this used to compare frequency_days (what the customer told us
  // they buy overall, "compro 3 cargas por semana") against days since OUR OWN last sale to them
  // ("le toca" framing) — but a customer who buys from several traders can easily go 40 days
  // without ordering from BUENTRADE while still buying every 7 days in the market. Measuring their
  // real cadence against our own sales record was comparing two unrelated things. This now returns
  // only the cadence itself, exactly as the customer stated it — no "overdue," no comparison
  // against our last sale, no cutoff. Never fetches sales_orders/last_known_order_date any more —
  // neither is used for anything here.
  const [cp] = await sql`select frequency_days, loads_per_cycle from customer_products where customer_id = ${customerId} and product_id = ${productId}`;
  const cadence = cp?.frequency_days != null
    ? { frequencyDays: Number(cp.frequency_days), loadsPerCycle: cp.loads_per_cycle != null ? Number(cp.loads_per_cycle) : null }
    : null;

  const priceSignal = await computeProductPriceSignal(sql, productId);
  const priceTrend = (priceSignal?.trend && priceSignal.trend.pctChange <= PRICE_FAVORABLE_THRESHOLD_PCT)
    ? { pctChange: priceSignal.trend.pctChange }
    : null;

  // Real addition 2026-09-22, extended same day ("no es solo por producto, hay proteina y
  // mercado"): product-specific note wins when one exists; otherwise falls back to the species/
  // category-wide note for this exact product's own category (e.g. no note on "Pork Medium
  // Spareribs" itself, but there IS one for "Pork" overall) — coalesce, never both, never a
  // standalone broadcast unrelated to the product actually being quoted.
  //
  // Real addition 2026-09-22 ("si no especifica que llegue a todos si especifica que lo asocie con
  // el correcto"): a THIRD tier sits between those two — a family note (product_name_en set,
  // scoped to this product's own category + its own clean name_en, e.g. "Picnic") reaches every
  // real SKU sharing that name regardless of packaging/temperature, without broadcasting to the
  // whole category the way a species-wide note would. Precedence: product-specific, then family,
  // then category-wide — most specific real match always wins.
  const [marketNoteRow] = await sql`
    select trend_pct, note, mx_benchmark_price_usd_kg, mx_benchmark_region from product_market_notes
    where product_id = ${productId} and note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
    order by note_date desc, created_at desc
    limit 1
  `;
  const familyNoteRow = marketNoteRow ? null : (await sql`
    select pmn.trend_pct, pmn.note, pmn.mx_benchmark_price_usd_kg, pmn.mx_benchmark_region
    from product_market_notes pmn
    join products p on p.category_id = pmn.category_id and p.name_en = pmn.product_name_en
    where p.id = ${productId} and pmn.product_name_en is not null
      and pmn.note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
    order by pmn.note_date desc, pmn.created_at desc
    limit 1
  `)[0];
  const marketNoteRowFinal = marketNoteRow ?? familyNoteRow ?? (await sql`
    select pmn.trend_pct, pmn.note, pmn.mx_benchmark_price_usd_kg, pmn.mx_benchmark_region
    from product_market_notes pmn
    join products p on p.category_id = pmn.category_id
    where p.id = ${productId} and pmn.category_id is not null and pmn.product_name_en is null
      and pmn.note_date >= current_date - (${MARKET_NOTE_FRESHNESS_DAYS} || ' days')::interval
    order by pmn.note_date desc, pmn.created_at desc
    limit 1
  `)[0];
  const marketNote = marketNoteRowFinal
    ? {
        trendPct: marketNoteRowFinal.trend_pct != null ? Number(marketNoteRowFinal.trend_pct) : null, note: marketNoteRowFinal.note ?? null,
        mxBenchmarkPriceUsdKg: marketNoteRowFinal.mx_benchmark_price_usd_kg != null ? Number(marketNoteRowFinal.mx_benchmark_price_usd_kg) : null,
        mxBenchmarkRegion: marketNoteRowFinal.mx_benchmark_region ?? null,
      }
    : null;

  const exposure = await computeCustomerExposure(sql, customerId);
  const overCreditLimit = !!(exposure && exposure.outstanding > exposure.creditLimit);

  if (!cadence && !priceTrend && !marketNote && !overCreditLimit) return null;
  return { cadence, priceTrend, marketNote, overCreditLimit };
}

// Collections module (2026-09-08). The one real moment a shipment becomes fully settled — used by
// both shipments-mark-paid (dashboard.html's simple "mark this one paid" button) and
// shipments-apply-payment (Collections' $-amount waterfall across a customer's open shipments), so
// interest/profit math and the "credit freed up" notification exist in exactly one place.
//
// Real formula, taken word-for-word from the user's own historical Excel ("Mes a Mes.xlsx",
// June/July/August 2025 tabs) — not invented: Interes = Monto * (tasa_anual/365) * dias_reales
// (factura -> pago); Net Profit = Monto - PO Bill - Flete - Inspeccion - Interes - Costos Misc.
// "Fecha Factura" maps to invoice_sent_at (falls back to delivered_at if the invoice send was
// somehow never logged, so this never throws on an otherwise-real paid shipment); "PO Bill" is
// cost_per_lb * real_weight when a customs-pedimento real_weight is on file (else the quoted
// total_cost) — "teniendo en cuenta los costos adicionales finales", the real numbers, not the
// quoted ones; "Costos Misc" is every order_extra_costs row for this order (tramite aduanal,
// bodega americana, and anything else added by hand). Interest is computed ONCE, right here, at
// the moment of full payment — never live/accruing while a shipment is still open ("solo cuando
// se pague", confirmed explicitly).
export async function finalizeShipmentPaid(
  tx: any,
  shipment: Record<string, any>,
  hmacSecret: string,
  actor: string,
): Promise<{ shipment: Record<string, any>; notification: Record<string, any> | null }> {
  const [offer] = shipment.sent_offer_id
    ? await tx`select * from sent_offers where id = ${shipment.sent_offer_id}`
    : [null];
  const [salesOrder] = await tx`select real_weight from sales_orders where order_number = ${shipment.order_number}`;
  const extraCostsRows = await tx`select coalesce(sum(amount), 0) as total from order_extra_costs where order_number = ${shipment.order_number}`;
  const extraCostsTotal = Number(extraCostsRows[0]?.total ?? 0);

  const invoiceDate: string | null = shipment.invoice_sent_at ?? shipment.delivered_at ?? null;
  const now = new Date();
  const paidDays = invoiceDate
    ? Math.max(0, Math.round((now.getTime() - new Date(invoiceDate).getTime()) / 86400000))
    : 0;

  const realWeight = salesOrder?.real_weight != null ? Number(salesOrder.real_weight) : null;
  const purchaseCost = (realWeight != null && offer?.cost_per_lb != null)
    ? realWeight * Number(offer.cost_per_lb)
    : Number(offer?.total_cost ?? 0);
  const freight = Number(offer?.us_freight_amount ?? 0);
  const inspection = Number(offer?.inspection_amount ?? 0);

  const [{ value: rateStr }] = await tx`select value from app_settings where key = 'collections_interest_rate_annual'`;
  const annualRate = parseFloat(rateStr ?? "0.15");
  const saleAmount = Number(shipment.sale_amount ?? 0);
  const interestAmount = saleAmount * (annualRate / 365) * paidDays;
  const netProfit = saleAmount - purchaseCost - freight - inspection - extraCostsTotal - interestAmount;

  const [updatedShipment] = await tx`
    update shipments set
      paid_at = now(), amount_paid = ${saleAmount}, paid_days = ${paidDays},
      interest_amount = ${interestAmount}, net_profit = ${netProfit}, updated_at = now()
    where id = ${shipment.id} returning *
  `;
  await writeAuditLog(tx, hmacSecret, { actor, action: "update", table_name: "shipments", record_id: shipment.id, before: shipment, after: updatedShipment });

  let notification = null;
  if (shipment.customer_id) {
    const [customer] = await tx`select credit_limit from customers where id = ${shipment.customer_id}`;
    const [{ outstanding }] = await tx`
      select coalesce(sum(sale_amount - amount_paid), 0) as outstanding from shipments
      where customer_id = ${shipment.customer_id} and paid_at is null
    `;
    const available = customer?.credit_limit != null ? Number(customer.credit_limit) - Number(outstanding) : null;
    const amountFmt = `$${saleAmount.toLocaleString()}`;
    const availableFmt = available != null ? ` Available credit now: $${available.toLocaleString()}.` : "";
    const [n] = await tx`
      insert into customer_notifications (customer_id, type, message)
      values (${shipment.customer_id}, 'payment_received', ${`Payment received for order ${shipment.order_number} (${amountFmt}) — credit freed up.` + availableFmt})
      returning *
    `;
    notification = n;
  }

  return { shipment: updatedShipment, notification };
}

// Real ask 2026-09-14: "ahora el unico buyer y trader es Felipe Cuartas" — every current login
// goes through the shared info@buentradegroup.com account (no per-trader login exists yet), so
// splitting won_by on "@" printed the ugly, wrong "info" as the Buyer/Trader name on every PO/SO.
// This maps that one shared account to the real name for now; the split-based fallback stays for
// whenever a real named account (felipe@..., maria@...) actually exists, so this doesn't have to
// be touched again once real per-trader logins are set up — just add another entry here then.
const TRADER_DISPLAY_NAMES: Record<string, string> = {
  "info@buentradegroup.com": "Felipe Cuartas",
};
export function traderDisplayName(email: string | null | undefined): string | null {
  if (!email) return null;
  return TRADER_DISPLAY_NAMES[email.toLowerCase()] || email.split("@")[0];
}

export async function writeAuditLog(
  tx: any,
  hmacSecret: string,
  entry: { actor: string; action: "insert" | "update" | "delete"; table_name: string; record_id: string; before?: unknown; after?: unknown },
) {
  const [lastEntry] = await tx`select hash from audit_log order by id desc limit 1`;
  const prevHash = lastEntry?.hash ?? null;
  const payload = JSON.stringify({ prevHash, ...entry });
  const hash = createHmac("sha256", hmacSecret).update(payload).digest("hex");
  await tx`
    insert into audit_log (actor, action, table_name, record_id, before, after, prev_hash, hash)
    values (${entry.actor}, ${entry.action}, ${entry.table_name}, ${entry.record_id}, ${entry.before ? tx.json(entry.before) : null}, ${entry.after ? tx.json(entry.after) : null}, ${prevHash}, ${hash})
  `;
}
