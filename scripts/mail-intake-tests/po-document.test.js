// What a Purchase Order says about the plant and the money — checked against EVERY plant in the system (fixtures/plants-geo.json is a dump of
// the real plants with their country/state lookups) and the formats the PDF prints.
const P = require('./harness.js');
const po = P.__load(P.__root + '_shared/poDocument.ts');
const plants = require('./fixtures/plants-geo.json');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const geoOf = (p) => ({ country_name: p.country_name, iso2: p.iso2, state_name: p.state_name, state_code: p.state_code });

const bad = { notTrimmed: [], noCountryLast: [], emptyOrComma: [], duplicatedCity: [], noState: [], badIncoterm: [], noOrigin: [] };
for (const p of plants) {
  const lines = po.plantAddressLines(p, geoOf(p));
  const label = p.name.trim();
  if (lines[0] !== p.name.trim().replace(/\s+/g, ' ')) bad.notTrimmed.push(label);
  if (lines[lines.length - 1] !== p.country_name) bad.noCountryLast.push(label);
  if (lines.some((l) => !l || /,\s*$/.test(l) || l !== l.trim())) bad.emptyOrComma.push(label);
  const city = (p.city || '').trim();
  const cityOnlyLines = lines.slice(1).filter((l) => city && l.toLowerCase().startsWith(city.toLowerCase()) && !/\d/.test(l));
  const addr = (p.address || '').toLowerCase();
  if (city && addr.includes(city.toLowerCase()) && cityOnlyLines.some((l) => l.toLowerCase() !== addr.replace(/[\s,;]+$/, ''))) bad.duplicatedCity.push(label);
  const block = lines.join(' | ').toLowerCase();
  if (!(block.includes((p.state_name || '').toLowerCase()) || new RegExp('\\b' + (p.state_code || '@@').toLowerCase() + '\\b').test(block))) bad.noState.push(label);
  const inc = po.plantIncoterm(p, geoOf(p));
  const wantState = p.iso2 === 'US' ? p.state_code : p.state_name;
  if (!inc.startsWith('FCA – ' + p.name.trim().replace(/\s+/g, ' ')) || (p.city && !inc.includes(p.city.trim())) || (wantState && !inc.endsWith(wantState)) || /\s,|,\s*$|\s{2}/.test(inc)) bad.badIncoterm.push(label + ' => ' + inc);
  if (!po.countryOfOrigin(p, geoOf(p))) bad.noOrigin.push(label);
}
ok(plants.length >= 30, `all ${plants.length} plants checked`);
ok(!bad.notTrimmed.length, 'every vendor block starts with the plant name, trimmed' + (bad.notTrimmed.length ? ' — ' + bad.notTrimmed : ''));
ok(!bad.noCountryLast.length, 'every vendor block ends with the country' + (bad.noCountryLast.length ? ' — ' + bad.noCountryLast : ''));
ok(!bad.emptyOrComma.length, 'no empty line, no trailing comma' + (bad.emptyOrComma.length ? ' — ' + bad.emptyOrComma : ''));
ok(!bad.duplicatedCity.length, 'the city is never repeated on its own line when the address already has it' + (bad.duplicatedCity.length ? ' — ' + bad.duplicatedCity : ''));
ok(!bad.noState.length, 'every block carries the state (inside the address or as its own "City, ST" line)' + (bad.noState.length ? ' — ' + bad.noState : ''));
ok(!bad.badIncoterm.length, 'every incoterm reads "FCA – Plant, City, ST" with no stray spaces or commas' + (bad.badIncoterm.length ? ' — ' + bad.badIncoterm : ''));
ok(!bad.noOrigin.length, 'every plant has a country of origin' + (bad.noOrigin.length ? ' — ' + bad.noOrigin : ''));

const by = (n) => plants.find((p) => p.name.toLowerCase().includes(n));
ok(po.plantAddressLines(by('smithfield'), geoOf(by('smithfield'))).join('\n') === 'Smithfield Foods\n200 Commerce Street, Smithfield, VA 23430\nUnited States', 'Smithfield: one clean address, no repeated city, with the country');
ok(po.plantAddressLines(by('tyson'), geoOf(by('tyson'))).join('\n') === 'Tyson Foods\n2200 W Don Tyson Pkwy\nSpringdale, AR\nUnited States', 'Tyson: street, then "Springdale, AR", then the country');
ok(po.plantIncoterm(by('tyson'), geoOf(by('tyson'))) === 'FCA – Tyson Foods, Springdale, AR', 'Tyson incoterm');
ok(po.plantAddressLines(by('bachoco'), geoOf(by('bachoco'))).slice(-1)[0] === 'Mexico' && po.plantIncoterm(by('bachoco'), geoOf(by('bachoco'))).endsWith('Guanajuato'), 'a plant outside the US shows the state name, not a code');
ok(po.agencyIncoterm({ name: 'Agency ', city: null }) === 'DAP – Agency' && po.agencyIncoterm({ name: 'A', city: 'Laredo' }) === 'DAP – A, Laredo', 'customs-agency incoterm has no trailing comma when the city is empty');
ok(po.fmtWeight(40000) === '40,000' && po.fmtUnitCost(1.72) === '$1.7200' && po.fmtAmount(68800) === '$68,800.00' && po.fmtAmount(51200.5) === '$51,200.50' && po.fmtAmount(null) === '$0.00', 'weight, unit cost and amount are printed like the PDF (thousands, 4 and 2 decimals)');
ok(po.fmtDate('2026-09-27T01:30:00Z') === '9/26/2026', 'a PO created in the US evening keeps its US (Miami) date');

// ---------- pickup facility (never the plant's offices), delivery to the customs agency, notes
const facilitiesAll = require('./fixtures/plant-facilities.json');
const facsOf = (p) => facilitiesAll.filter((f) => f.plant === p.name);
const smith = by('smithfield'); const tyson = by('tyson');
const denison = facsOf(smith).find((f) => f.location_name === 'Denison, IA');
ok(po.facilityLines(smith, denison, geoOf(smith)).join('\n') === 'Smithfield Foods\nDenison, IA\nUnited States' && po.facilityIncoterm(smith, denison) === 'FCA – Smithfield Foods, Denison, IA', 'a facility with no street address prints plant + "City, ST" + country (no invented street) and FCA names it');
const storm = facsOf(tyson).filter((f) => f.location_name === 'Storm Lake, IA');
ok(storm.length === 2 && po.facilityLines(tyson, storm[0], geoOf(tyson)).join('\n') === 'Tyson Foods\n1009 Richland Dr, Storm Lake, IA 50588\nUnited States' && po.facilityIncoterm(tyson, storm[0]) === 'FCA – Tyson Foods, Storm Lake, IA', 'Tyson Storm Lake prints its own street address (the city is not repeated) — not Springdale, AR');
ok(po.plantIncoterm(smith, geoOf(smith)) === 'FCA – Smithfield Foods, Smithfield, VA', 'a plant with no facility registered uses its own address');

const noOffices = [], badRes = [];
for (const p of plants) {
  const facs = facsOf(p);
  const distinctPrints = new Set(facs.map((f) => (f.address || '').toLowerCase() + '|' + f.city + ', ' + f.state)).size;
  const none = po.resolvePickup({ facilities: facs });
  if (facs.length === 0) { if (none.kind !== 'plant') badRes.push(p.name + ': no facilities should use the plant'); continue; }
  if (distinctPrints === 1) { if (none.kind !== 'facility' || none.source !== 'only_facility') badRes.push(p.name + ': single facility not used'); }
  else {
    if (none.kind !== 'needs_pick' || none.options.length !== distinctPrints || none.options.some((o) => !facs.find((f) => f.id === o.id))) badRes.push(p.name + ': several facilities and nothing recorded must ask, offering only this plant\'s own');
  }
  // every facility, chosen by hand / by freight origin / by product location, resolves to itself and never prints the offices
  for (const f of facs) {
    const printsOk = (r) => r.kind === 'facility' && (r.facility.id === f.id || (r.facility.address || '') === (f.address || '') && r.facility.city === f.city);
    const lines = po.facilityLines(p, f, geoOf(p)).join('\n').toLowerCase();
    const officesStreet = (p.address || '').toLowerCase().replace(/[\s,;]+$/, '');
    if (officesStreet && !(f.address || '').toLowerCase().includes(officesStreet) && lines.includes(officesStreet)) noOffices.push(p.name + ' / ' + f.location_name);
    if (!printsOk(po.resolvePickup({ facilities: facs, manualId: f.id }))) badRes.push(p.name + ' / ' + f.location_name + ': manual pick');
    if (f.location_id) {
      if (!printsOk(po.resolvePickup({ facilities: facs, rateLocationId: f.location_id, rateLocation: { city: f.city, state: f.state } }))) badRes.push(p.name + ' / ' + f.location_name + ': freight origin');
      if (!printsOk(po.resolvePickup({ facilities: facs, productLocationId: f.location_id }))) badRes.push(p.name + ' / ' + f.location_name + ': product location');
    }
  }
}
ok(facilitiesAll.length >= 19, `${facilitiesAll.length} real facilities of ${new Set(facilitiesAll.map((f) => f.plant)).size} plants checked`);
ok(!badRes.length, 'every plant: no facility -> the plant, one -> that one, several and nothing recorded -> ask (only its own facilities), a manual pick / freight origin / product location resolves to the facility itself' + (badRes.length ? ' — ' + badRes : ''));
ok(!noOffices.length, 'no facility ever prints the plant\'s offices address' + (noOffices.length ? ' — ' + noOffices : ''));

const tFacs = facsOf(tyson);
const tAsk = po.resolvePickup({ facilities: tFacs });
ok(tAsk.kind === 'needs_pick' && tAsk.options.length === 4 && tAsk.options.filter((o) => o.location_name === 'Storm Lake, IA').length === 1, 'Tyson with no pick-up recorded: the PO asks, offering its 4 distinct facilities (the two Storm Lake plants share one address, so they are one choice)');
ok(po.resolvePickup({ facilities: tFacs, rateLocationId: storm[0].location_id, rateLocation: { city: 'Storm Lake', state: 'IA' } }).kind === 'facility', 'a freight rate booked from Storm Lake resolves to the Tyson Storm Lake facility');
const otherPlantFac = facsOf(smith)[0];
ok(po.resolvePickup({ facilities: tFacs, manualId: otherPlantFac.id }).kind === 'needs_pick', 'a pick that is not a facility of this plant is ignored (never prints another plant\'s facility)');
ok(po.resolvePickup({ facilities: tFacs, rateLocationId: 'loc-unknown', rateLocation: { city: 'Sioux Center', state: 'IA' } }).kind === 'place', 'a freight origin city that is not a registered facility prints that city (the real origin of the booked truck), not the offices');
ok(po.resolvePickup({ facilities: [{ id: 'a', location_id: 'L', location_name: 'X, IA', city: 'X', state: 'IA', address: '1 A St' }, { id: 'b', location_id: 'L', location_name: 'X, IA', city: 'X', state: 'IA', address: '2 B St' }], rateLocationId: 'L' }).kind === 'needs_pick', 'two facilities in one city with different addresses and no pick: ask, never guess');
const agencies = require('./fixtures/customs-agencies.json');
const badAg = [];
for (const a of agencies) {
  const lines = po.agencyAddressLines(a, a.country_name);
  const name = a.name.trim().replace(/\s+/g, ' ');
  if (lines[0] !== name) badAg.push(name + ': first line');
  if (a.address && !lines.some((l) => l.includes(a.address.trim().replace(/[\s,;]+$/, '')))) badAg.push(name + ': address missing');
  if (a.city && a.address && a.address.toLowerCase().includes(a.city.trim().toLowerCase()) && lines.filter((l) => l.toLowerCase() === a.city.trim().toLowerCase()).length) badAg.push(name + ': city repeated');
  if (lines.some((l) => !l || /,\s*$/.test(l) || l !== l.trim())) badAg.push(name + ': empty line or trailing comma');
  const inc = po.agencyIncoterm(a);
  if (!inc.startsWith('DAP – ' + name) || /,\s*$/.test(inc) || /\s{2}/.test(inc)) badAg.push(name + ': incoterm ' + inc);
}
ok(agencies.length >= 5 && !badAg.length, `all ${agencies.length} customs agencies print name + street address (no repeated city, no stray commas)` + (badAg.length ? ' — ' + badAg : ''));
const palos = agencies.find((a) => /palos garza/i.test(a.name));
ok(po.agencyAddressLines(palos, palos.country_name).join('\n') === 'Palos Garza Forwarding LLC\n12120 River Bank Dr\nLaredo\nUnited States' && po.agencyIncoterm(palos) === 'DAP – Palos Garza Forwarding LLC, Laredo', 'a delivery to Laredo shows the customs agency\'s address');
const alcom = agencies.find((a) => /al-com/i.test(a.name));
ok(po.agencyAddressLines(alcom, alcom.country_name).join('\n') === 'Al-Com International Trade, Inc.\n14614 Archer Drive Suite C, Laredo, TX 78046\nUnited States', 'an agency whose address already has the city, state and zip is printed as it is');
ok(JSON.stringify(po.poNotes({ temperature: 'Fresh', setpointF: 20, docsOn: false })) === JSON.stringify(['Temperature: 20°F (Fresh)', 'No docs approved for Mexico to export.']), 'fresh product, no docs: 20°F and "No docs approved for Mexico to export."');
ok(JSON.stringify(po.poNotes({ temperature: 'Frozen', setpointF: -10, docsOn: true })) === JSON.stringify(['Temperature: -10°F (Frozen)', 'Docs included by vendor.']), 'frozen product, with docs: -10°F and "Docs included by vendor."');
ok(JSON.stringify(po.poNotes({ temperature: null, setpointF: null, docsOn: false })) === JSON.stringify(['No docs approved for Mexico to export.']), 'a product with no temperature setpoint prints no temperature line');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
