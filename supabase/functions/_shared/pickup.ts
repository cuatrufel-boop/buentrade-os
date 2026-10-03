// Where a FOB load is collected — the READ side, used by every module that needs it: creating the order (sent-offers-mark-won), the Purchase Order and
// the Freight Order (orders-compose-po / orders-compose-fo). The pure rules are in poDocument.ts (resolvePickup); this file reads what the quote
// recorded and builds the question the trader is asked when the quote did not say. The answer is stored by pickupWrite.ts.

import { clean, placeOf } from "./poDocument.ts";
import type { Facility, PickupInput, PickupResolution } from "./poDocument.ts";

// What the system recorded for this order: the plant's facilities, the facility already chosen for the order's shipment, the origin of the freight
// rate booked on the offer and the location the plant's price for this product ships from.
export async function loadPickupInput(sql: any, o: { plantId: string; productId: string | null; orderNumber: string | null; rateId: string | null }): Promise<PickupInput> {
  const facilities = await sql`
    select pl.id, pl.location_id, pl.location_name, pl.address, l.city, l.state
    from plant_locations pl left join locations l on l.id = pl.location_id
    where pl.plant_id = ${o.plantId} order by pl.location_name, pl.created_at`;
  const [shipment] = o.orderNumber ? await sql`select pickup_location_id from shipments where order_number = ${o.orderNumber}` : [];
  const [rate] = o.rateId ? await sql`select r.location_id, l.city, l.state from provider_rates r left join locations l on l.id = r.location_id where r.id = ${o.rateId}` : [];
  const [productPlace] = o.productId ? await sql`select pp.location_id, l.city, l.state from plant_products pp left join locations l on l.id = pp.location_id where pp.plant_id = ${o.plantId} and pp.product_id = ${o.productId}` : [];
  return {
    facilities, manualId: shipment?.pickup_location_id ?? null,
    rateLocationId: rate?.location_id ?? null, rateLocation: rate ? { city: rate.city, state: rate.state } : null,
    productLocationId: productPlace?.location_id ?? null, productLocation: productPlace ? { city: productPlace.city, state: productPlace.state } : null,
  };
}

const facilityChoice = (f: Facility) => ({ id: f.id, location_name: clean(f.location_name) || placeOf(f), address: clean(f.address) || null });

// The question for the trader when the pickup is not complete, or null when it is. One shape for every caller (HTTP 409 "pickup_location_required").
export function pickupRefusal(plantId: string, plantName: string, res: PickupResolution, orderNumber?: string | null) {
  if (res.kind === "ready") return null;
  const plant = clean(plantName) || "the plant";
  if (res.kind === "needs_address") {
    return {
      error: "pickup_location_required", need: "address", order_number: orderNumber ?? null, plant_id: plantId, plant_name: plant,
      message: `The street address of ${plant} — ${placeOf(res.facility)} is not on file yet: type it, so the carrier and the plant get the exact pickup place.`,
      facility: facilityChoice(res.facility), options: [], hint_name: null,
    };
  }
  return {
    error: "pickup_location_required", need: "facility", order_number: orderNumber ?? null, plant_id: plantId, plant_name: plant,
    message: res.options.length
      ? `The quote did not say which ${plant} location this load is collected from: choose it, or add the location with its street address.`
      : `No pickup location of ${plant} is on file: add the location the truck collects from, with its street address.`,
    facility: null, options: res.options.map(facilityChoice), hint_name: res.hintName,
  };
}
