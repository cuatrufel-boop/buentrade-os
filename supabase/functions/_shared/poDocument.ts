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
// A FOB load is collected at a plant FACILITY with a street address (Storm Lake, IA — 1009 Richland Dr), never at the plant's offices (the
// offices are only the VENDOR block). The place comes from the quote: the freight rate booked on the offer (its origin) and the location the
// plant's price ships from. When the quote did not carry it, or the facility has no street address yet, nothing is guessed: the order is not
// created / the PO is not issued until the trader answers (resolvePickup -> needs_facility / needs_address), and the answer is kept on the
// facility, so each address is asked once and then always found.
export type Facility = { id?: string | null; location_id?: string | null; location_name?: string | null; address?: string | null; city?: string | null; state?: string | null };
export const placeOf = (f: Facility) => [clean(f.city), clean(f.state)].filter(Boolean).join(", ") || clean(f.location_name);

// Plant name, the facility's street address, "City, ST" (only when the address does not already carry the city), the country.
export function facilityLines(plant: PlantRow, f: Facility, geo: PlantGeo): string[] {
  const address = clean(f.address);
  const place = placeOf(f);
  const city = clean(f.city);
  const addressHasCity = !!address && !!city && address.toLowerCase().includes(city.toLowerCase());
  return [clean(plant.name), address, addressHasCity ? "" : place, clean(geo.country_name) || clean(plant.country)].filter(Boolean);
}

export const facilityIncoterm = (plant: PlantRow, f: Facility): string => `FCA – ${[clean(plant.name) || "plant", placeOf(f)].filter(Boolean).join(", ")}`;

// The same place as one line for the carrier ("Tyson Foods, 1009 Richland Dr, Storm Lake, IA 50588").
export function pickupText(plant: PlantRow, f: Facility): string {
  const address = clean(f.address);
  const city = clean(f.city);
  const addressHasCity = !!address && !!city && address.toLowerCase().includes(city.toLowerCase());
  return [clean(plant.name), address, addressHasCity ? "" : placeOf(f)].filter(Boolean).join(", ");
}

// A street address the trader typed: something with a number and letters ("1009 Richland Dr, Storm Lake, IA 50588"). Returns the problem, or null.
export function addressProblem(addr: unknown): string | null {
  const a = clean(addr);
  if (a.length < 8 || !/\d/.test(a) || !/[A-Za-z]{3}/.test(a)) return "Type the street address of the pickup location (number, street, city, state).";
  return null;
}

export type PickupInput = {
  facilities: Facility[];            // every facility registered for the plant (plant_locations joined to locations)
  manualId?: string | null;          // shipments.pickup_location_id — a plant_locations id chosen for this order
  rateLocationId?: string | null;    // locations.id the freight rate booked on the offer ships from
  rateLocation?: Facility | null;    // that location's city / state
  productLocationId?: string | null; // locations.id the plant's price for this product ships from
  productLocation?: Facility | null;
};
export type PickupSource = "shipment" | "freight_rate" | "product";
export type PickupResolution =
  | { kind: "ready"; facility: Facility; source: PickupSource }          // known, with its street address
  | { kind: "needs_address"; facility: Facility; source: PickupSource }  // known, its street address is not on file yet
  | { kind: "needs_facility"; options: Facility[]; hintName: string | null }; // the quote did not say (or says a city that is not a registered facility)

// Two facility rows that print the same (Tyson's two Storm Lake plants share one address) are one choice.
const printKey = (f: Facility) => `${clean(f.address).toLowerCase()}|${placeOf(f).toLowerCase()}`;
export const distinctFacilities = (list: Facility[]): Facility[] => { const seen = new Set<string>(); return list.filter((f) => { const k = printKey(f); if (seen.has(k)) return false; seen.add(k); return true; }); };

// In order of certainty: the facility chosen for this order; the origin of the freight rate booked on the offer; the location the plant's price for
// the product ships from. Both origins are matched to the plant's OWN facilities. Nothing else is assumed — not "the plant's only facility", never
// the offices.
export function resolvePickup(i: PickupInput): PickupResolution {
  const facilities = i.facilities || [];
  const settle = (facility: Facility, source: PickupSource): PickupResolution => clean(facility.address) ? { kind: "ready", facility, source } : { kind: "needs_address", facility, source };
  if (i.manualId) {
    const chosen = facilities.find((f) => f.id === i.manualId);
    if (chosen) return settle(chosen, "shipment");
  }
  let hintName: string | null = null;
  const origins: Array<[string | null | undefined, Facility | null | undefined, PickupSource]> = [
    [i.rateLocationId, i.rateLocation, "freight_rate"], [i.productLocationId, i.productLocation, "product"],
  ];
  for (const [locationId, location, source] of origins) {
    if (!locationId) continue;
    const here = distinctFacilities(facilities.filter((f) => f.location_id && f.location_id === locationId));
    if (here.length === 1) return settle(here[0], source);
    if (here.length > 1) return { kind: "needs_facility", options: here, hintName: placeOf(here[0]) };
    if (!hintName && location && placeOf(location)) hintName = placeOf(location);
  }
  return { kind: "needs_facility", options: distinctFacilities(facilities), hintName };
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
