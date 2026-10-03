// What a Purchase Order says about the plant and the money, as one tested piece (used by orders-compose-po; the PDF screens just print it).
// The plant's country and state live in the countries / states tables (plants.country / plants.state text columns are empty for every plant), and
// plants.address is free text: sometimes a street only ("2200 W Don Tyson Pkwy"), sometimes the whole address ("200 Commerce Street, Smithfield,
// VA 23430,"). The block therefore never repeats the city when the address already has it, and always ends with the country.

export type PlantGeo = { country_name?: string | null; iso2?: string | null; state_name?: string | null; state_code?: string | null };
type PlantRow = { name?: string | null; address?: string | null; city?: string | null; country?: string | null };

export const clean = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").replace(/[\s,;]+$/, "").trim();

// US states read as their 2-letter code ("Springdale, AR"); any other country shows the state's name.
export function stateLabel(geo: PlantGeo): string {
  if (geo.iso2 === "US" && geo.state_code) return clean(geo.state_code);
  return clean(geo.state_name);
}

export function cityState(plant: PlantRow, geo: PlantGeo): string {
  return [clean(plant.city), stateLabel(geo)].filter(Boolean).join(", ");
}

export function plantAddressLines(plant: PlantRow, geo: PlantGeo): string[] {
  const address = clean(plant.address);
  const city = clean(plant.city);
  const lines = [clean(plant.name)].filter(Boolean);
  if (address) lines.push(address);
  const addressHasCity = !!city && address.toLowerCase().includes(city.toLowerCase());
  if (!addressHasCity) {
    const cs = cityState(plant, geo);
    if (cs) lines.push(cs);
  }
  const country = clean(geo.country_name) || clean(plant.country);
  if (country) lines.push(country);
  return lines;
}

// ---------- Where the cargo is collected
// The PICK-UP location of a PO is the plant's FACILITY the load is collected at (Storm Lake, IA), never the plant's offices (Springdale, AR):
// the offices only belong to the VENDOR block. The facility is a plant_locations row (its own street address) joined to the locations catalog
// (city / state). Nothing here ever falls back to the offices when the plant has facilities: when the facility is not known the PO is not
// issued and the trader is asked which one (resolvePickup -> "needs_pick").
export type Facility = { id?: string | null; location_id?: string | null; location_name?: string | null; address?: string | null; city?: string | null; state?: string | null };
const placeOf = (f: Facility) => [clean(f.city), clean(f.state)].filter(Boolean).join(", ") || clean(f.location_name);

// Plant name, the facility's street address, "City, ST" (only when the address does not already carry the city), the country.
export function facilityLines(plant: PlantRow, f: Facility, geo: PlantGeo): string[] {
  const address = clean(f.address);
  const place = placeOf(f);
  const city = clean(f.city);
  const addressHasCity = !!address && !!city && address.toLowerCase().includes(city.toLowerCase());
  return [clean(plant.name), address, addressHasCity ? "" : place, clean(geo.country_name) || clean(plant.country)].filter(Boolean);
}

export const facilityIncoterm = (plant: PlantRow, f: Facility): string => `FCA – ${[clean(plant.name) || "plant", placeOf(f)].filter(Boolean).join(", ")}`;

// Only for a plant with no facility registered at all: the plant's own address is then the one place the system knows.
export function plantIncoterm(plant: PlantRow, geo: PlantGeo): string {
  return `FCA – ${[clean(plant.name) || "plant", cityState(plant, geo)].filter(Boolean).join(", ")}`;
}

export type PickupInput = {
  facilities: Facility[];            // every facility registered for the plant (plant_locations joined to locations)
  manualId?: string | null;          // shipments.pickup_location_id — a plant_locations id the trader chose
  rateLocationId?: string | null;    // locations.id the freight rate booked on the offer ships from
  rateLocation?: Facility | null;    // that location's city / state
  productLocationId?: string | null; // locations.id the plant's price for this product ships from
  productLocation?: Facility | null;
};
export type PickupResolution =
  | { kind: "facility"; facility: Facility; source: "shipment" | "freight_rate" | "product" | "only_facility" }
  | { kind: "place"; facility: Facility; source: "freight_rate" | "product" }   // the origin is a known city that is not a registered facility of this plant
  | { kind: "plant"; source: "plant_without_facilities" }
  | { kind: "needs_pick"; options: Facility[] };

// Two facility rows that print the same (Tyson's two Storm Lake plants share one address) are one choice.
const printKey = (f: Facility) => `${clean(f.address).toLowerCase()}|${placeOf(f).toLowerCase()}`;
const distinct = (list: Facility[]): Facility[] => { const seen = new Set<string>(); return list.filter((f) => { const k = printKey(f); if (seen.has(k)) return false; seen.add(k); return true; }); };

// In order of certainty: the facility the trader chose for this shipment; the origin of the freight rate booked for the offer; the location the
// plant's price for the product ships from; the plant's only facility. A plant with no facility registered uses its own address. Anything else
// is "needs_pick" — the system never guesses between facilities and never prints the offices as the pick-up place.
export function resolvePickup(i: PickupInput): PickupResolution {
  const facilities = i.facilities || [];
  if (i.manualId) {
    const chosen = facilities.find((f) => f.id === i.manualId);
    if (chosen) return { kind: "facility", facility: chosen, source: "shipment" };
  }
  const origins: Array<[string | null | undefined, Facility | null | undefined, "freight_rate" | "product"]> = [
    [i.rateLocationId, i.rateLocation, "freight_rate"], [i.productLocationId, i.productLocation, "product"],
  ];
  for (const [locationId, location, source] of origins) {
    if (!locationId) continue;
    const here = distinct(facilities.filter((f) => f.location_id && f.location_id === locationId));
    if (here.length === 1) return { kind: "facility", facility: here[0], source };
    if (here.length > 1) return { kind: "needs_pick", options: here };
    if (location && placeOf(location)) return { kind: "place", facility: location, source };
  }
  const all = distinct(facilities);
  if (all.length === 0) return { kind: "plant", source: "plant_without_facilities" };
  if (all.length === 1) return { kind: "facility", facility: all[0], source: "only_facility" };
  return { kind: "needs_pick", options: all };
}

// A delivered order goes to the customer's customs agency at the border (Laredo, McAllen...): its name and street address.
export function agencyAddressLines(agency: { name?: string | null; address?: string | null; city?: string | null; country?: string | null }, countryName?: string | null): string[] {
  const address = clean(agency.address);
  const city = clean(agency.city);
  const lines = [clean(agency.name)].filter(Boolean);
  if (address) lines.push(address);
  if (city && !address.toLowerCase().includes(city.toLowerCase())) lines.push(city);
  const country = clean(countryName) || clean(agency.country);
  if (country) lines.push(country);
  return lines;
}

export function agencyIncoterm(agency: { name?: string | null; city?: string | null }): string {
  return `DAP – ${[clean(agency.name), clean(agency.city)].filter(Boolean).join(", ")}`;
}

export const countryOfOrigin = (plant: PlantRow, geo: PlantGeo): string | null => clean(geo.country_name) || clean(plant.country) || null;

// Money and weight the way the PDF prints them.
export const fmtWeight = (n: unknown) => Number(n || 0).toLocaleString("en-US");
export const fmtUnitCost = (n: unknown) => "$" + Number(n || 0).toFixed(4);
export const fmtAmount = (n: unknown) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// The business runs on Miami time (project rule): a PO created late in the evening in the US keeps its US date.
export const fmtDate = (d: unknown) => new Date(d as string).toLocaleDateString("en-US", { timeZone: "America/New_York" });

// The notes printed on a PO: the temperature to hold the load at (from the product's own temperature, when it has a setpoint) and the export-docs line.
export function poNotes(opts: { temperature?: string | null; setpointF?: number | null; docsOn: boolean }): string[] {
  const notes: string[] = [];
  if (opts.setpointF != null && clean(opts.temperature)) notes.push(`Temperature: ${opts.setpointF}°F (${clean(opts.temperature)})`);
  notes.push(opts.docsOn ? "Docs included by vendor." : "No docs approved for Mexico to export.");
  return notes;
}
