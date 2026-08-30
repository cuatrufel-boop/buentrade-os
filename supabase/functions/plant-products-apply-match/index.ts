// plant_products.applyMatch — the ONLY way a price gets attached to a plant+product, and the
// ONLY way plant_product_aliases learns how a plant writes something. This is the write half of
// the loop products.matchFromPlantText starts: that function only ever proposes (it never writes
// anything), and NOTHING becomes a saved alias or a saved price until this function is called —
// which only happens once a human has actually looked at the match (confident or picked from
// candidates) and confirmed it. No duplicate-check logic here on purpose: by the time this is
// called, the "is this the right product" question has already been answered by a human via the
// match step — this function's only job is to persist that decision correctly.
//
// Upserts both tables in one transaction: plant_products (the price link) and
// plant_product_aliases (the plant's own wording, remembered for next time) — either both happen
// or neither does, so a price with no alias (loses the "remember it" benefit) or an alias with no
// price (a phantom link) can't happen from a partial failure.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog, matchOrCreateLocationId } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

const REQUIRED_FIELDS = ["actor", "plant_id", "product_id", "raw_text", "price"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });

  try {
    const body = await req.json();
    const missing = REQUIRED_FIELDS.filter((k) => body[k] == null || body[k] === "");
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);

    const {
      actor, plant_id, product_id, raw_text, price,
      price_currency_id = null, price_date = null, docs_included = null, notes = null,
      location_name = null,
    } = body;

    const [plant] = await sql`select id from plants where id = ${plant_id}`;
    if (!plant) return jsonResponse({ error: "unknown plant_id" }, 400);
    const [product] = await sql`select id from products where id = ${product_id}`;
    if (!product) return jsonResponse({ error: "unknown product_id" }, 400);

    const result = await sql.begin(async (tx) => {
      // A price list stating "FOB City, ST" on this exact line (Smithfield confirmed real shape:
      // a different city per product) resolves against the same closed city catalog every carrier
      // rate already uses — same rule as plant_locations, and the one deliberate auto-create
      // exception in the whole matching system (see matchOrCreateLocationId). No location_name on
      // this line (or nothing parseable) leaves whatever was already on file untouched via
      // coalesce below, rather than wiping out a location set by hand on a re-apply.
      const location_id = location_name ? await matchOrCreateLocationId(tx, location_name) : null;
      const [plantProduct] = await tx`
        insert into plant_products (plant_id, product_id, current_price, price_currency_id, price_date, docs_included, notes, location_id)
        values (${plant_id}, ${product_id}, ${price}, ${price_currency_id}, ${price_date}, ${docs_included}, ${notes}, ${location_id})
        on conflict (plant_id, product_id) do update set
          current_price = excluded.current_price,
          price_currency_id = excluded.price_currency_id,
          price_date = excluded.price_date,
          docs_included = excluded.docs_included,
          notes = excluded.notes,
          location_id = coalesce(excluded.location_id, plant_products.location_id),
          updated_at = now()
        returning *
      `;

      const [alias] = await tx`
        insert into plant_product_aliases (plant_id, product_id, raw_text)
        values (${plant_id}, ${product_id}, ${raw_text})
        on conflict (plant_id, raw_text) do update set product_id = excluded.product_id
        returning *
      `;

      await writeAuditLog(tx, HMAC_SECRET, {
        actor, action: "update", table_name: "plant_products", record_id: plantProduct.id,
        after: { plant_product: plantProduct, alias },
      });

      return { plantProduct, alias };
    });

    return jsonResponse({ applied: true, plant_product: result.plantProduct, alias: result.alias }, 200);
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
