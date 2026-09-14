// order-documents-history — real ask 2026-09-14: "en el momento en el que creo PO SO FO INV debe
// alojarse en el perfil de cada destinatario" — a Plant's profile needs every PO ever sent to it,
// a Customer's needs every SO and every Invoice, a Carrier's needs every FO, each in date order.
// One shared endpoint instead of three near-identical ones (keeps the function count down — see
// [[project_supabase_function_cap]]) — entity_type picks which real table(s) to read.
//
// created_at is the "document exists" date (the order was created, so the doc definitely exists);
// sent_at (from shipments — po_sent_at/so_sent_at/fo_sent_at/invoice_sent_at) is null until it
// actually went out. Both are returned so the profile tab can show "not sent yet" honestly instead
// of pretending every row was mailed.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["entity_type", "entity_id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { entity_type, entity_id } = body;
    if (!["plant", "customer", "carrier"].includes(entity_type)) {
      return jsonResponse({ error: "invalid entity_type", message: "entity_type must be 'plant', 'customer', or 'carrier'." }, 400);
    }

    let results;
    if (entity_type === "plant") {
      results = await sql`
        select po.order_number, 'PO' as doc_type, po.created_at, sh.po_sent_at as sent_at,
          po.product_name, po.weight, po.total_cost as amount
        from purchase_orders po
        left join shipments sh on sh.order_number = po.order_number
        where po.plant_id = ${entity_id}
        order by po.created_at desc
      `;
    } else if (entity_type === "customer") {
      results = await sql`
        select so.order_number, 'SO' as doc_type, so.created_at, sh.so_sent_at as sent_at,
          so.product_name, so.weight, so.total_sale as amount
        from sales_orders so
        left join shipments sh on sh.order_number = so.order_number
        where so.customer_id = ${entity_id}
        union all
        select so.order_number, 'INV' as doc_type, so.created_at, sh.invoice_sent_at as sent_at,
          so.product_name, so.weight, so.total_sale as amount
        from sales_orders so
        join shipments sh on sh.order_number = so.order_number
        where so.customer_id = ${entity_id} and sh.invoice_sent_at is not null
        order by created_at desc
      `;
    } else {
      results = await sql`
        select fo.order_number, 'FO' as doc_type, fo.created_at, sh.fo_sent_at as sent_at,
          po.product_name, po.weight, fo.quoted_rate as amount
        from freight_orders fo
        left join shipments sh on sh.order_number = fo.order_number
        left join purchase_orders po on po.order_number = fo.order_number
        where fo.carrier_provider_id = ${entity_id}
        order by fo.created_at desc
      `;
    }

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
