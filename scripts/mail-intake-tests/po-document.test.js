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

// ---------- pickup location, delivery to the customs agency, notes
const smith = by('smithfield');
ok(po.pickupLocationLines(smith, { city: 'Denison', state: 'IA' }, geoOf(smith)).join('\n') === 'Smithfield Foods\nDenison, IA\nUnited States', 'PICK-UP location: the plant and the facility the load ships from (Denison, IA), not the headquarters address');
ok(po.plantIncoterm(smith, geoOf(smith), { city: 'Denison', state: 'IA' }) === 'FCA – Smithfield Foods, Denison, IA', 'FCA names the pick-up facility');
ok(po.pickupLocationLines(smith, null, geoOf(smith)).join('\n') === po.plantAddressLines(smith, geoOf(smith)).join('\n') && po.plantIncoterm(smith, geoOf(smith), null) === 'FCA – Smithfield Foods, Smithfield, VA', 'with no facility on record the plant\'s own address is used (never blank)');
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
