// shipments.search — read-only. The "super pantalla" data source: each row already carries the
// product/plant/customer context (via sent_offers), the carrier name, and the FULL event history
// as one array — a future screen can render everything about one load without a second call per
// row. Filters: status, customer_id, or "awaiting_payment" (delivered but not yet paid — the
// working list for "who owes us and since when").

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const VALID_STATUSES = ["pending_pickup", "picked_up", "unloading", "delivered"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json().catch(() => ({}));
    const { status = null, customer_id = null, awaiting_payment = false, order_number = null } = body;
    const limit = Math.min(Number(body.limit) || 100, 500);

    if (status && !VALID_STATUSES.includes(status)) return jsonResponse({ error: "invalid status", valid_statuses: VALID_STATUSES }, 400);

    const results = await sql`
      select
        sh.*,
        o.product_id, o.product_name, o.product_name_es, o.product_spec, o.product_spec_es,
        o.plant_name, o.customer_name,
        p.name as carrier_name, p.phone as carrier_phone,
        cu.contact_name as customer_contact_name, cu.whatsapp as customer_whatsapp, cu.phone as customer_phone,
        cu.email as customer_email, cu.email_cc as customer_email_cc,
        cu.payment_days as customer_payment_days,
        pl.whatsapp as plant_whatsapp, pl.phone as plant_phone, pl.email as plant_email,
        pl.payments_contact_name as plant_payments_contact_name, pl.payments_email as plant_payments_email, pl.payments_whatsapp as plant_payments_whatsapp,
        pr.name as catalog_product_name, pr.name_en as catalog_product_name_en, pp.photo_url as catalog_product_photo_url,
        (
          select fo.origin from freight_orders fo
          where fo.order_number = sh.order_number and fo.carrier_provider_id = sh.carrier_provider_id
          limit 1
        ) as freight_origin,
        (
          -- Real bug found live 2026-09-07 against BT-0014: a freight_order can exist with
          -- carrier_provider_id null (TBD, no rate matched at Win time) — every other check here
          -- keyed off sh.carrier_provider_id, so a TBD freight order was completely invisible (no
          -- FO row in the per-order panel, never flagged as "FO not sent") until a carrier got
          -- assigned. This matches by order_number only, so it's true the moment the freight_order
          -- row exists, regardless of whether a carrier has been picked yet.
          select exists(select 1 from freight_orders fo where fo.order_number = sh.order_number)
        ) as has_freight_order,
        (
          -- The confirmed pickup date, same source orders-compose-po already prints as
          -- "Pick-up date" on the real PO document (po.delivery_dates[0]) — nothing new, just
          -- exposed here so the Status tab can compute the fixed 2-day-to-border window against it.
          select po.delivery_dates->>0 from purchase_orders po
          where po.order_number = sh.order_number limit 1
        ) as pickup_date,
        (
          select po.docs_on from purchase_orders po where po.order_number = sh.order_number limit 1
        ) as docs_on,
        (
          select coalesce(json_agg(e.* order by e.at), '[]'::json)
          from shipment_events e where e.shipment_id = sh.id
        ) as events,
        (
          -- Real pickup documents (BOL/packing list/photos/USDA), received by email from plant
          -- and/or carrier (pickup-docs-emails-poll), still waiting on the trader's confirm before
          -- they go to customs — never sent automatically, see shareCustomsPickupDocs.
          select coalesce(json_agg(d.* order by d.created_at), '[]'::json)
          from shipment_pickup_documents d where d.shipment_id = sh.id and d.forwarded_to_customs_at is null
        ) as pending_pickup_documents,
        (
          -- ALL pickup documents regardless of forwarded status — the Orders "Documents" panel
          -- needs the full record of what's on file for this order, not just what's still waiting
          -- to be sent. Added 2026-09-06, real gap found live ("tengo que tener un sitio fisico
          -- donde se guarden los docs de esa venta").
          select coalesce(json_agg(d.* order by d.created_at), '[]'::json)
          from shipment_pickup_documents d where d.shipment_id = sh.id
        ) as pickup_documents
      from shipments sh
      join sent_offers o on o.id = sh.sent_offer_id
      left join providers p on p.id = sh.carrier_provider_id
      left join plants pl on pl.id = o.plant_id
      left join customers cu on cu.id = sh.customer_id
      left join products pr on pr.id = o.product_id
      left join plant_products pp on pp.product_id = o.product_id and pp.plant_id = o.plant_id
      where (${status}::text is null or sh.status = ${status})
        and (${customer_id}::uuid is null or sh.customer_id = ${customer_id})
        and (${awaiting_payment}::boolean is false or (sh.status = 'delivered' and sh.paid_at is null))
        and (${order_number}::text is null or sh.order_number = ${order_number})
      order by sh.created_at desc
      limit ${limit}
    `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
