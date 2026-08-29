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
    const { status = null, customer_id = null, awaiting_payment = false } = body;
    const limit = Math.min(Number(body.limit) || 100, 500);

    if (status && !VALID_STATUSES.includes(status)) return jsonResponse({ error: "invalid status", valid_statuses: VALID_STATUSES }, 400);

    const results = await sql`
      select
        sh.*,
        o.product_id, o.product_name, o.product_name_es, o.product_spec, o.product_spec_es,
        o.plant_name, o.customer_name,
        p.name as carrier_name, p.phone as carrier_phone,
        cu.contact_name as customer_contact_name, cu.whatsapp as customer_whatsapp, cu.phone as customer_phone,
        cu.payment_days as customer_payment_days,
        pr.name as catalog_product_name, pr.name_en as catalog_product_name_en, pp.photo_url as catalog_product_photo_url,
        (
          select fo.origin from freight_orders fo
          where fo.order_number = sh.order_number and fo.carrier_provider_id = sh.carrier_provider_id
          limit 1
        ) as freight_origin,
        (
          select coalesce(json_agg(e.* order by e.at), '[]'::json)
          from shipment_events e where e.shipment_id = sh.id
        ) as events
      from shipments sh
      join sent_offers o on o.id = sh.sent_offer_id
      left join providers p on p.id = sh.carrier_provider_id
      left join customers cu on cu.id = sh.customer_id
      left join products pr on pr.id = o.product_id
      left join plant_products pp on pp.product_id = o.product_id and pp.plant_id = o.plant_id
      where (${status}::text is null or sh.status = ${status})
        and (${customer_id}::uuid is null or sh.customer_id = ${customer_id})
        and (${awaiting_payment}::boolean is false or (sh.status = 'delivered' and sh.paid_at is null))
      order by sh.created_at desc
      limit ${limit}
    `;

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
