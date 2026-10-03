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

// Where the cargo is picked up: the facility ("Denison, IA") the load ships from, which is not always the plant's headquarters address.
export type PickupLocation = { city?: string | null; state?: string | null } | null | undefined;
const locationLabel = (loc: PickupLocation) => [clean(loc?.city), clean(loc?.state)].filter(Boolean).join(", ");

// The PICK-UP location block of a PO: plant name, the facility "City, ST", the country. With no facility on record it falls back to the plant's
// own address (the only place the system knows about), never a blank.
export function pickupLocationLines(plant: PlantRow, loc: PickupLocation, geo: PlantGeo): string[] {
  const place = locationLabel(loc);
  if (!place) return plantAddressLines(plant, geo);
  return [clean(plant.name), place, clean(geo.country_name) || clean(plant.country)].filter(Boolean);
}

export function plantIncoterm(plant: PlantRow, geo: PlantGeo, loc?: PickupLocation): string {
  const place = locationLabel(loc) || cityState(plant, geo);
  return `FCA – ${[clean(plant.name) || "plant", place].filter(Boolean).join(", ")}`;
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
