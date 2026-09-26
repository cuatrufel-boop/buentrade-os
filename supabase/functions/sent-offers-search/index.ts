// sent_offers.search — read-only (plus the Offer Sheet actions below, see handleOfferSheet). Powers the Offers screen: every offer ever sent, whichever path
// it came from (fresh Quotes price or a chased Pending one — both land in the same sent_offers
// table by design, see plant_products.requestPrice / sent_offers.create). Ordered by customer then
// product by default, per the trader's own words (2026-08-25): "se ordenan por cliente y por
// producto" — pass order_by: "product" to flip to product-then-customer instead.

import postgres from "npm:postgres@3.4.4";
import { computeCustomerExposure, earliestDeliveryDate, jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const VALID_STATUSES = ["sent", "won", "lost"];

// Offer Sheets (approved 2026-09-26, parts 1-5 — see migration 20260926120000_offer_sheets.sql). Hosted here, not in a new
// function, because the project is at its 100-function cap. One live sheet per product: which customers it is for, the
// delivery dates, and which plants were asked for a price (and when). Everything else a sheet shows is read live from
// plant_products / provider_rates / sent_offers by quotes.html — never copied into these tables.
// Idempotent by natural key: one OPEN sheet per product (unique partial index), (sheet, customer) and (sheet, plant)
// primary keys — a double click or a retried request can never create a second sheet or a second row.
const SHEET_LIFE_DAYS = 10; // same life as an offer (sent-offers-expire-stale)

async function openSheet(tx: any, productId: string, actor: string, deliveryDates: string[]) {
  // A sheet older than its life is closed as expired first, so the product starts a fresh one.
  await tx`update offer_sheets set status = 'closed', closed_reason = 'expired', closed_at = now()
    where product_id = ${productId} and status = 'open' and created_at < now() - make_interval(days => ${SHEET_LIFE_DAYS})`;
  const [existing] = await tx`select * from offer_sheets where product_id = ${productId} and status = 'open'`;
  if (existing) {
    if (deliveryDates.length) {
      const [upd] = await tx`update offer_sheets set delivery_dates = ${tx.json(deliveryDates)} where id = ${existing.id} returning *`;
      return upd;
    }
    return existing;
  }
  const [created] = await tx`
    insert into offer_sheets (product_id, delivery_dates, created_by)
    values (${productId}, ${tx.json(deliveryDates)}, ${actor})
    on conflict (product_id) where status = 'open' do nothing
    returning *`;
  return created || (await tx`select * from offer_sheets where product_id = ${productId} and status = 'open'`)[0];
}

async function sheetsWithDetails(productIds: string[] | null) {
  const sheets = await sql`
    select s.*, p.full_name_en as product_name from offer_sheets s join products p on p.id = s.product_id
    where s.status = 'open' and s.created_at >= now() - make_interval(days => ${SHEET_LIFE_DAYS})
      and (${productIds}::uuid[] is null or s.product_id = any(${productIds}::uuid[]))
    order by s.created_at desc`;
  if (!sheets.length) return [];
  const ids = sheets.map((s: any) => s.id);
  const customers = await sql`select sheet_id, customer_id, added_at from offer_sheet_customers where sheet_id = any(${ids}::uuid[])`;
  const plants = await sql`select * from offer_sheet_plants where sheet_id = any(${ids}::uuid[])`;
  return sheets.map((s: any) => ({
    ...s,
    customer_ids: customers.filter((c: any) => c.sheet_id === s.id).map((c: any) => c.customer_id),
    plants: plants.filter((pl: any) => pl.sheet_id === s.id),
  }));
}

async function handleOfferSheet(req: any) {
  const { action, actor = "unknown" } = req;
  const productIds: string[] = Array.isArray(req.product_ids) ? req.product_ids.filter(Boolean) : (req.product_id ? [req.product_id] : []);

  if (action === "list") return jsonResponse({ sheets: await sheetsWithDetails(null) });
  if (action === "get") {
    if (!productIds.length) return jsonResponse({ error: "product_ids required" }, 400);
    return jsonResponse({ sheets: await sheetsWithDetails(productIds) });
  }
  if (action === "open") {
    // Opens (or continues) one sheet per product and adds the customers it is for. Called when the trader sends.
    const customerIds: string[] = Array.isArray(req.customer_ids) ? req.customer_ids.filter(Boolean) : [];
    const deliveryDates: string[] = Array.isArray(req.delivery_dates) ? req.delivery_dates.filter(Boolean) : [];
    if (!productIds.length) return jsonResponse({ error: "product_ids required" }, 400);
    await sql.begin(async (tx: any) => {
      for (const pid of productIds) {
        const sheet = await openSheet(tx, pid, actor, deliveryDates);
        for (const cid of customerIds) {
          await tx`insert into offer_sheet_customers (sheet_id, customer_id) values (${sheet.id}, ${cid}) on conflict do nothing`;
        }
      }
    });
    return jsonResponse({ sheets: await sheetsWithDetails(productIds) });
  }
  if (action === "mark_asked") {
    // After a price request to a plant actually went out (the trader confirmed it in the preview). remind: true = Remind.
    const plantId = req.plant_id;
    if (!productIds.length || !plantId) return jsonResponse({ error: "product_ids and plant_id required" }, 400);
    await sql.begin(async (tx: any) => {
      for (const pid of productIds) {
        const sheet = await openSheet(tx, pid, actor, []);
        if (req.remind) {
          await tx`insert into offer_sheet_plants (sheet_id, plant_id, asked_at, reminded_at) values (${sheet.id}, ${plantId}, now(), now())
            on conflict (sheet_id, plant_id) do update set reminded_at = now(), answered_at = null`;
        } else {
          await tx`insert into offer_sheet_plants (sheet_id, plant_id, asked_at) values (${sheet.id}, ${plantId}, now())
            on conflict (sheet_id, plant_id) do update set asked_at = now(), answered_at = null, reminded_at = null`;
        }
      }
    });
    return jsonResponse({ sheets: await sheetsWithDetails(productIds) });
  }
  if (action === "close") {
    if (!productIds.length) return jsonResponse({ error: "product_ids required" }, 400);
    await sql`update offer_sheets set status = 'closed', closed_reason = 'manual', closed_at = now()
      where status = 'open' and product_id = any(${productIds}::uuid[])`;
    return jsonResponse({ closed: true });
  }
  return jsonResponse({ error: "unknown offer_sheet action", valid: ["list", "get", "open", "mark_asked", "close"] }, 400);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    if (body.offer_sheet) return await handleOfferSheet(body.offer_sheet);
    const { id = null, customer_id = null, product_id = null, status = null, order_by = "customer", sent_from = null, sent_to = null, order_number = null } = body;
    const limit = Math.min(Number(body.limit) || 100, 1000);

    if (status && !VALID_STATUSES.includes(status)) {
      return jsonResponse({ error: "invalid status", valid_statuses: VALID_STATUSES }, 400);
    }

    const orderClause = order_by === "product"
      ? sql`order by product_name, customer_name, sent_at desc`
      : sql`order by customer_name, product_name, sent_at desc`;

    const results = await sql`
      select * from sent_offers
      where (${id}::uuid is null or id = ${id})
        and (${customer_id}::uuid is null or customer_id = ${customer_id})
        and (${product_id}::uuid is null or product_id = ${product_id})
        and (${status}::text is null or status = ${status})
        and (${sent_from}::timestamptz is null or sent_at >= ${sent_from})
        and (${sent_to}::timestamptz is null or sent_at <= ${sent_to})
        and (${order_number}::text is null or order_number = ${order_number})
      ${orderClause}
      limit ${limit}
    `;

    // Real ask 2026-09-16: flag a still-open offer being negotiated above the customer's available
    // credit (as of its own delivery date, same date-aware formula as sent-offers-create/mark-won)
    // — never blocks anything (the plant-contact hard block was removed the same day), just lets
    // offers.html show the red "Cupo" tag so the trader knows this can be negotiated to the end but
    // can only close once the customer's last invoice is paid. Computed per open offer, not per
    // customer, because each open offer can carry its own delivery date.
    for (const offer of results) {
      if (offer.status === "sent" && offer.customer_id && offer.total_sale != null) {
        const exposure = await computeCustomerExposure(sql, offer.customer_id, earliestDeliveryDate(offer.delivery_dates));
        if (exposure) {
          const projected = exposure.outstanding + Number(offer.total_sale);
          offer.over_credit_limit = projected > exposure.creditLimit;
          if (offer.over_credit_limit) {
            offer.credit_limit = exposure.creditLimit;
            offer.outstanding_balance = exposure.outstanding;
          }
        }
      }
    }

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
