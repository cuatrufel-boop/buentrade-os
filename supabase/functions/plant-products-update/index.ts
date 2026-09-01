// plant_products.update — edits the per-plant attributes of an existing plant+product link:
// brand, photo, spec sheet. Never touches the shared product row (name/category/temperature/
// packaging) — that stays products.update's job. Partial update: only fields present in the body
// change.

import postgres from "npm:postgres@3.4.4";
import { jsonResponse, writeAuditLog } from "../_shared/matching.ts";

const sql = postgres(Deno.env.get("API_SERVICE_DB_URL")!, { ssl: "require", max: 1, idle_timeout: 10, prepare: false, types: { numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => parseFloat(x) } } });
const HMAC_SECRET = Deno.env.get("AUDIT_HMAC_SECRET")!;

// declined_at: real business need 2026-08-31 — a plant asked for a price on something it doesn't
// make gets marked here (permanent, never re-asked) instead of sitting in Pending Quotes forever
// or getting asked again later by someone who doesn't know it was already declined.
//
// current_price: real gap fixed 2026-09-01 — a price typed by hand into the Trading Tool (phoned
// in, emailed as a one-liner, a plant asked for the first time with nothing on file yet) had
// nowhere to actually land: plant-products.applyMatch is the price-list-ingestion path (needs a
// raw_text line to learn an alias from, which doesn't exist for a hand-typed number), and nothing
// else ever wrote current_price/price_date at all — confirmed by a stale comment in quotes.html
// describing exactly this feature attached to a function that never implemented it. Setting
// price_date here to now() whenever current_price is provided keeps it consistent with
// applyMatch's own behavior — a price entered right now IS current as of right now.
const UPDATABLE_FIELDS = ["brand_id", "photo_url", "spec_url", "notes", "location_id", "declined_at", "current_price"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  try {
    const body = await req.json();
    const missing = ["actor", "id"].filter((k) => !body[k]);
    if (missing.length) return jsonResponse({ error: "missing required fields", missing }, 400);
    const { actor, id } = body;

    const [existing] = await sql`select * from plant_products where id = ${id}`;
    if (!existing) return jsonResponse({ error: "unknown plant_product id" }, 404);

    const merged: any = { ...existing };
    for (const f of UPDATABLE_FIELDS) if (f in body) merged[f] = body[f];
    // A price written through this endpoint is always "as of right now" — there's no other date
    // to attach to a number someone just typed in, same rule applyMatch already follows for a
    // price read straight off a real price list.
    const priceDate = "current_price" in body ? new Date().toISOString() : merged.price_date;

    const link = await sql.begin(async (tx) => {
      const [link] = await tx`
        update plant_products set
          brand_id = ${merged.brand_id}, photo_url = ${merged.photo_url}, spec_url = ${merged.spec_url}, notes = ${merged.notes},
          location_id = ${merged.location_id}, declined_at = ${merged.declined_at},
          current_price = ${merged.current_price}, price_date = ${priceDate},
          updated_at = now()
        where id = ${id}
        returning *
      `;
      await writeAuditLog(tx, HMAC_SECRET, { actor, action: "update", table_name: "plant_products", record_id: id, before: existing, after: link });
      return link;
    });

    return jsonResponse({ updated: true, plant_product: link });
  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
