// What a Freight Order (the document for the carrier) says, as small tested pieces used by orders-compose-fo; the PDF screens just print it.
// The Purchase Order has its own rules in poDocument.ts and is not touched by these.

import { clean, placeOf } from "./poDocument.ts";
import type { Facility } from "./poDocument.ts";

type FacilityRow = Facility & { phone?: string | null };

// The day a load picked up on `pickUp` (YYYY-MM-DD) reaches the border: two calendar days later, a Saturday or Sunday rolls to Monday (the business
// rule the Status tab already uses). Plain calendar arithmetic in UTC, so the day never shifts with the server's time zone.
export function borderArrivalDate(pickUp: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(pickUp ?? ""));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + 2));
  const dow = d.getUTCDay(); // 0 Sunday, 6 Saturday
  if (dow === 6) d.setUTCDate(d.getUTCDate() + 2);
  else if (dow === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// "-10°F (Frozen)" — the temperature a load is held at: the product's own temperature and its setpoint (null when it has none).
export function temperatureSetting(temperature?: string | null, setpointF?: number | null): string | null {
  return setpointF != null && clean(temperature) ? `${setpointF}°F (${clean(temperature)})` : null;
}

// The pick-up block: plant name, the facility's street address, "City, ST" only when the address lacks the city. No country line (the carrier is in the US).
export function facilityBlock(plantName: string | null | undefined, f: Facility): string[] {
  const address = clean(f.address);
  const city = clean(f.city);
  const addressHasCity = !!address && !!city && address.toLowerCase().includes(city.toLowerCase());
  return [clean(plantName), address, addressHasCity ? "" : placeOf(f)].filter(Boolean);
}

// The phone(s) of the pick-up place, taken only from the facility rows themselves — never the plant's general sales phone. Two rows at the same
// address (Tyson's two Storm Lake plants) both belong to that site, so the carrier gets both numbers instead of one of them chosen for him.
export function facilityPhones(facilities: FacilityRow[], f: FacilityRow): string | null {
  const here = facilities.filter((x) => (x.id && x.id === f.id) || (clean(x.address).toLowerCase() === clean(f.address).toLowerCase() && placeOf(x).toLowerCase() === placeOf(f).toLowerCase()));
  const phones = [...new Set(here.map((x) => clean(x.phone)).filter(Boolean))];
  return phones.length ? phones.join(" / ") : null;
}

// The delivery block: the customs agency's name, street address and city.
export function agencyBlock(agency: { name?: string | null; address?: string | null; city?: string | null }): string[] {
  const address = clean(agency.address);
  const city = clean(agency.city);
  const addressHasCity = !!address && !!city && address.toLowerCase().includes(city.toLowerCase());
  return [clean(agency.name), address, addressHasCity ? "" : city].filter(Boolean);
}

// The same place as the one-line text the carrier's email carries ("Palos Garza Forwarding LLC, 12120 River Bank Dr, Laredo, United States").
export const agencyText = (agency: { name?: string | null; address?: string | null; city?: string | null; country?: string | null }): string =>
  [clean(agency.name), clean(agency.address), clean(agency.city), clean(agency.country)].filter(Boolean).join(", ");
