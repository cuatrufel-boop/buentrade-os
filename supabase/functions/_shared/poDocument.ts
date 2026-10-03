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

export function plantIncoterm(plant: PlantRow, geo: PlantGeo): string {
  return `FCA – ${[clean(plant.name) || "plant", cityState(plant, geo)].filter(Boolean).join(", ")}`;
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
