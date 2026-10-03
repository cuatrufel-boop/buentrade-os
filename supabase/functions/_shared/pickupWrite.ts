// Where a FOB load is collected — the WRITE side: stores the trader's answer on the plant's facility (so each street address is asked once and is
// found from then on), on the shipment and on the Freight Order. Used by sent-offers-mark-won and shipments-set-pickup-location. The read side and
// the question are in pickup.ts; the rules are in poDocument.ts.

import { matchOrCreateLocationId, parseCityState, writeAuditLog } from "./matching.ts";
import { addressProblem, clean, pickupText } from "./poDocument.ts";
import type { Facility } from "./poDocument.ts";

export type PickupChoice = { pickup_location_id?: string | null; new_location_name?: string | null; address?: string | null };
export type PickupApplied = { facility: Facility } | { error: string; message: string };

// The same checks applyPickupChoice makes, run before anything is written (a refused order must not have taken an order number).
export async function checkPickupChoice(sql: any, plantId: string, choice: PickupChoice | null | undefined): Promise<{ error: string; message: string } | null> {
  const c = choice || {};
  const typed = clean(c.address);
  if (typed) { const problem = addressProblem(typed); if (problem) return { error: "invalid_address", message: problem }; }
  if (c.pickup_location_id) {
    const [f] = await sql`select plant_id from plant_locations where id = ${c.pickup_location_id}`;
    return f && f.plant_id === plantId ? null : { error: "pickup_location_not_of_this_plant", message: "That location is not one of this plant's locations." };
  }
  if (clean(c.new_location_name)) {
    if (!parseCityState(c.new_location_name)) return { error: "invalid_location_name", message: "Write the location as City, ST (for example Storm Lake, IA)." };
    if (!typed) return { error: "invalid_address", message: addressProblem("") as string };
    return null;
  }
  return { error: "missing_pickup_choice", message: "Choose the pickup location (or add it with its street address)." };
}

// Stores the trader's answer on the plant's facility and returns that facility: an existing facility of THIS plant (its street address is saved when
// typed), or a new facility ("City, ST" + street address) — or the existing one of that city when it is already registered.
export async function applyPickupChoice(tx: any, hmac: string, actor: string, plantId: string, choice: PickupChoice | null | undefined): Promise<PickupApplied> {
  const c = choice || {};
  const typed = clean(c.address);
  if (typed) { const problem = addressProblem(typed); if (problem) return { error: "invalid_address", message: problem }; }

  if (c.pickup_location_id) {
    const [f] = await tx`select pl.id, pl.location_id, pl.location_name, pl.address, l.city, l.state, pl.plant_id from plant_locations pl left join locations l on l.id = pl.location_id where pl.id = ${c.pickup_location_id}`;
    if (!f || f.plant_id !== plantId) return { error: "pickup_location_not_of_this_plant", message: "That location is not one of this plant's locations." };
    if (typed && clean(f.address) !== typed) {
      const [after] = await tx`update plant_locations set address = ${typed}, updated_at = now() where id = ${f.id} returning *`;
      await writeAuditLog(tx, hmac, { actor, action: "update", table_name: "plant_locations", record_id: f.id, before: { address: f.address }, after: { address: after.address } });
      f.address = after.address;
    }
    return { facility: f };
  }

  if (clean(c.new_location_name)) {
    const parsed = parseCityState(c.new_location_name);
    if (!parsed) return { error: "invalid_location_name", message: "Write the location as City, ST (for example Storm Lake, IA)." };
    if (!typed) return { error: "invalid_address", message: addressProblem("") as string };
    const locationId = await matchOrCreateLocationId(tx, c.new_location_name);
    const same = await tx`select pl.id, pl.location_id, pl.location_name, pl.address, l.city, l.state from plant_locations pl left join locations l on l.id = pl.location_id where pl.plant_id = ${plantId} and pl.location_id = ${locationId}`;
    const sameAddress = same.find((f: Facility) => clean(f.address).toLowerCase() === typed.toLowerCase());
    if (sameAddress) return { facility: sameAddress };
    const blank = same.find((f: Facility) => !clean(f.address));
    if (blank) {
      const [after] = await tx`update plant_locations set address = ${typed}, updated_at = now() where id = ${blank.id} returning *`;
      await writeAuditLog(tx, hmac, { actor, action: "update", table_name: "plant_locations", record_id: blank.id, before: { address: blank.address }, after: { address: after.address } });
      return { facility: { ...blank, address: after.address } };
    }
    const name = `${parsed.city}, ${parsed.state}`;
    // Natural key: the same plant + city + street address is one facility, even if the answer is sent twice at once.
    const idempotencyKey = `pickup-facility|${plantId}|${locationId}|${typed.toLowerCase()}`;
    const [created] = await tx`insert into plant_locations (plant_id, location_name, address, location_id, idempotency_key) values (${plantId}, ${name}, ${typed}, ${locationId}, ${idempotencyKey}) on conflict (idempotency_key) where idempotency_key is not null do nothing returning *`;
    const row = created || (await tx`select * from plant_locations where idempotency_key = ${idempotencyKey}`)[0];
    if (created) await writeAuditLog(tx, hmac, { actor, action: "insert", table_name: "plant_locations", record_id: created.id, after: created });
    return { facility: { id: row.id, location_id: locationId, location_name: name, address: typed, city: parsed.city, state: parsed.state } };
  }

  return { error: "missing_pickup_choice", message: "Choose the pickup location (or add it with its street address)." };
}

// The Freight Order's pick-up for the US leg (the leg that collects at the plant; the Mexican leg starts at the border) as the carrier reads it.
export async function setUsLegOrigin(tx: any, hmac: string, actor: string, orderNumber: string, plant: { name?: string | null }, facility: Facility) {
  const text = pickupText(plant, facility);
  const legs = await tx`select * from freight_orders where order_number = ${orderNumber} and lower(trim(coalesce(origin, ''))) not in ('border', '') and origin is distinct from ${text}`;
  for (const leg of legs) {
    const [after] = await tx`update freight_orders set origin = ${text} where id = ${leg.id} returning *`;
    await writeAuditLog(tx, hmac, { actor, action: "update", table_name: "freight_orders", record_id: leg.id, before: leg, after });
  }
}
