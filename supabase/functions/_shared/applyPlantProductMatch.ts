// plant_products.applyMatch's real write logic, extracted the same way and for the same reason as
// productMatcher.ts — so plant-price-emails-poll can call it in-process, sharing one connection,
// instead of one fresh HTTP round trip (and fresh Postgres connection) per line of a real email.
// The ONLY way a price gets attached to a plant+product, and the ONLY way plant_product_aliases
// learns how a plant writes something — see the original file's own header for the full reasoning
// (upserts both tables in one transaction, on purpose, so a price with no alias or an alias with
// no price can never happen from a partial failure).

import { writeAuditLog, matchOrCreateLocationId } from "./matching.ts";

export type ApplyMatchResult =
  | { applied: true; plant_product: Record<string, any>; alias: Record<string, any> }
  | { error: string };

export async function applyPlantProductMatch(
  sql: any,
  hmacSecret: string,
  {
    actor, plant_id, product_id, raw_text, price,
    price_currency_id = null, price_date = null, docs_included = null, notes = null,
    location_name = null, freight_included = false,
  }: {
    actor: string; plant_id: string; product_id: string; raw_text: string; price: number;
    price_currency_id?: string | null; price_date?: string | null; docs_included?: boolean | null;
    notes?: string | null; location_name?: string | null; freight_included?: boolean;
  },
): Promise<ApplyMatchResult> {
  if (!actor || !plant_id || !product_id || !raw_text || price == null) {
    return { error: "missing required fields" };
  }

  const [plant] = await sql`select id from plants where id = ${plant_id}`;
  if (!plant) return { error: "unknown plant_id" };
  const [product] = await sql`select id from products where id = ${product_id}`;
  if (!product) return { error: "unknown product_id" };

  const result = await sql.begin(async (tx: any) => {
    const location_id = location_name ? await matchOrCreateLocationId(tx, location_name) : null;
    const [plantProduct] = await tx`
      insert into plant_products (plant_id, product_id, current_price, price_currency_id, price_date, docs_included, notes, location_id, freight_included)
      values (${plant_id}, ${product_id}, ${price}, ${price_currency_id}, ${price_date}, ${docs_included}, ${notes}, ${location_id}, ${freight_included})
      on conflict (plant_id, product_id) do update set
        current_price = excluded.current_price,
        price_currency_id = excluded.price_currency_id,
        price_date = excluded.price_date,
        docs_included = excluded.docs_included,
        notes = excluded.notes,
        location_id = excluded.location_id,
        freight_included = excluded.freight_included,
        updated_at = now()
      returning *
    `;

    const [alias] = await tx`
      insert into plant_product_aliases (plant_id, product_id, raw_text)
      values (${plant_id}, ${product_id}, ${raw_text})
      on conflict (plant_id, raw_text) do update set product_id = excluded.product_id
      returning *
    `;

    await writeAuditLog(tx, hmacSecret, {
      actor, action: "update", table_name: "plant_products", record_id: plantProduct.id,
      after: { plant_product: plantProduct, alias },
    });

    return { plantProduct, alias };
  });

  return { applied: true, plant_product: result.plantProduct, alias: result.alias };
}
