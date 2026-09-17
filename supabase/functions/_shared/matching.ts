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

// Market-wide price trend for a product (2026-09-16) — every plant that sells it, not just one
// ("una cosa es el precio del producto de la misma marca y otra el precio del producto en el
// mercado, o sea todas las marcas"). "Today" = the most recent price_date any plant has on file
// for this product; compared against the average of every price recorded before that date, within
// the prior 30 days. Returns null — no signal, not a fabricated one — whenever there's nothing
// yet to compare against (price_history only started 2026-09-16, so this stays null for weeks on
// real products until enough data accumulates; it doesn't need building later, it just starts
// working once the data exists).
export async function computeProductPriceSignal(
  sql: any,
  productId: string,
): Promise<{ latestBest: number; avgPrior30d: number; pctChange: number } | null> {
  const [row] = await sql`
    with latest as (select max(price_date) as d from price_history where product_id = ${productId})
    select
      (select min(price) from price_history where product_id = ${productId} and price_date = (select d from latest)) as latest_best,
      (select avg(price) from price_history where product_id = ${productId}
         and price_date < (select d from latest) and price_date >= (select d from latest) - interval '30 days') as avg_prior_30d
  `;
  if (!row || row.latest_best == null || row.avg_prior_30d == null) return null;
  const latestBest = Number(row.latest_best);
  const avgPrior30d = Number(row.avg_prior_30d);
  if (avgPrior30d === 0) return null;
  return { latestBest, avgPrior30d, pctChange: ((latestBest - avgPrior30d) / avgPrior30d) * 100 };
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

export async function computeCustomerProductSignal(
  sql: any,
  customerId: string,
  productId: string,
): Promise<{ message: string | null; overCreditLimit: boolean } | null> {
  const [cp] = await sql`select frequency_days, last_known_order_date from customer_products where customer_id = ${customerId} and product_id = ${productId}`;
  const [{ last_order_date: realLastOrderDate }] = await sql`
    select max(d.delivery_date) as last_order_date
    from sales_orders so, lateral (select (jsonb_array_elements_text(so.delivery_dates))::date as delivery_date) d
    where so.customer_id = ${customerId} and so.product_id = ${productId}
  `;
  // A real order in the live system always wins over the historical/manual fallback — never the
  // other way, so a real sale immediately becomes the anchor instead of a stale import date.
  const last_order_date = realLastOrderDate ?? cp?.last_known_order_date ?? null;

  // Real correction 2026-09-16: frequency_days is only ever "how often BUENTRADE sold them this,"
  // never the customer's real total buying cycle — a customer this app never sells to for 400+
  // days may just be buying it from someone else the whole time, not "overdue." Saying "le toca"
  // claims certainty about the customer's real need that this data can't support. This states only
  // the two real facts (our own cadence with them, days since our own last sale) and never implies
  // they're due — no "le toca," no urgency language, no cutoff that pretends to know their total
  // demand.
  const parts: string[] = [];
  if (cp?.frequency_days != null && last_order_date) {
    const daysSince = Math.floor((Date.now() - new Date(last_order_date).getTime()) / 86400000);
    if (daysSince >= Number(cp.frequency_days)) {
      parts.push(`Used to order every ${cp.frequency_days} days — last order from us was ${daysSince} days ago.`);
    }
  }

  const priceSignal = await computeProductPriceSignal(sql, productId);
  if (priceSignal && priceSignal.pctChange <= PRICE_FAVORABLE_THRESHOLD_PCT) {
    parts.push(`Price ${Math.abs(Math.round(priceSignal.pctChange))}% better than the last 30-day average.`);
  }

  const exposure = await computeCustomerExposure(sql, customerId);
  const overCreditLimit = !!(exposure && exposure.outstanding > exposure.creditLimit);

  if (!parts.length && !overCreditLimit) return null;
  return { message: parts.length ? parts.join(" ") : null, overCreditLimit };
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
