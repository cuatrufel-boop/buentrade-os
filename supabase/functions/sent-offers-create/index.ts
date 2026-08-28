// sent_offers.create — records a quote actually sent to a customer for a plant's product. Not
// master data (no duplicate-check discipline needed — sending a real offer twice is a normal
// business event, not a data-integrity risk), but the referenced product/plant/customer must be
// real, and the record snapshots their names/specs at send time (so a later rename in the catalog
// never silently rewrites what a customer was actually shown historically).

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const REQUIRED_FIELDS = ["actor", "channel", "plant_id", "customer_id"];
const VALID_CHANNELS = ["email", "whatsapp"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = REQUIRED_FIELDS.filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const {
      actor, channel, product_id = null, plant_id, customer_id,
      // A catalog-matched offer carries product_id and gets its name/spec from the catalog row
      // (so a later rename never rewrites what a customer was actually shown historically). A
      // product typed by hand with no catalog match has no product_id — these four carry the
      // typed text instead in that case, same as before Quotes went through the API.
      product_name = null, product_name_es = null, product_spec = null, product_spec_es = null,
      purchase_price = null, us_freight_rate_id = null, us_freight_amount = 0,
      docs_on = false, inspection_amount = 0, mexican_dest_rate_id = null, mexican_freight_mxn = null,
      customs_agency_provider_id = null, tramite_aduanal_amount = 0, bodega_americana_amount = 0,
      extra_fields = [], weight = 40000, cost_per_lb = null, sale_per_lb = null,
      total_cost = null, total_sale = null, delivery_dates = [],
    } = body;

    if (!VALID_CHANNELS.includes(channel)) return jsonResponse({ error: "invalid channel", valid_channels: VALID_CHANNELS }, 400);
    if (!product_id && !product_name) return jsonResponse({ error: "product_id or product_name is required" }, 400);

    let product = null;
    if (product_id) {
      [product] = await sql`select * from products where id = ${product_id}`;
      if (!product) return jsonResponse({ error: "unknown product_id" }, 400);
    }
    const finalProductName = product ? (product.name_en || product.name) : product_name;
    const finalProductNameEs = product ? (product.name || product.name_en) : (product_name_es || product_name);
    const finalProductSpec = product ? product.full_name_en : product_spec;
    const finalProductSpecEs = product ? product.full_name_es : product_spec_es;

    const [plant] = await sql`select * from plants where id = ${plant_id}`;
    if (!plant) return jsonResponse({ error: "unknown plant_id" }, 400);
    const [customer] = await sql`select * from customers where id = ${customer_id}`;
    if (!customer) return jsonResponse({ error: "unknown customer_id" }, 400);

    const offer = await sql.begin(async (tx) => {
      const [offer] = await tx`
        insert into sent_offers (
          sent_by, channel, product_id, product_name, product_name_es, product_spec, product_spec_es,
          plant_id, plant_name, customer_id, customer_name, purchase_price,
          us_freight_rate_id, us_freight_amount, docs_on, inspection_amount,
          mexican_dest_rate_id, mexican_freight_mxn, customs_agency_provider_id,
          tramite_aduanal_amount, bodega_americana_amount, extra_fields, weight,
          cost_per_lb, sale_per_lb, total_cost, total_sale, delivery_dates, status
        ) values (
          ${actor}, ${channel}, ${product_id}, ${finalProductName}, ${finalProductNameEs}, ${finalProductSpec}, ${finalProductSpecEs},
          ${plant_id}, ${plant.name}, ${customer_id}, ${customer.trade_name}, ${purchase_price},
          ${us_freight_rate_id}, ${us_freight_amount}, ${docs_on}, ${inspection_amount},
          ${mexican_dest_rate_id}, ${mexican_freight_mxn}, ${customs_agency_provider_id},
          ${tramite_aduanal_amount}, ${bodega_americana_amount}, ${tx.json(extra_fields)}, ${weight},
          ${cost_per_lb}, ${sale_per_lb}, ${total_cost}, ${total_sale}, ${tx.json(delivery_dates)}, 'sent'
        ) returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "insert", table_name: "sent_offers", record_id: offer.id, after: offer });
      return offer;
    });

    return jsonResponse({ created: true, offer }, 201);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
