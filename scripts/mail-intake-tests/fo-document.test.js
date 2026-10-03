// What a Freight Order says — the pure rules (the handlers are exercised for every plant in pickup.test.js).
const P = require('./harness.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const facilitiesAllFO = require('./fixtures/plant-facilities.json');

// ---------- Freight Order rules
const fo = P.__load(P.__root + '_shared/foDocument.ts');
ok(fo.borderArrivalDate('2025-02-21') === '2025-02-24', 'border date: Friday 02/21 -> Monday 02/24 (the Freight Confirmation example)');
ok(fo.borderArrivalDate('2026-09-02') === '2026-09-04', 'border date: Wednesday + 2 days = Friday');
ok(fo.borderArrivalDate('2026-09-03') === '2026-09-07', 'border date: Thursday + 2 = Saturday -> Monday');
ok(fo.borderArrivalDate('2026-10-10') === '2026-10-12', 'border date: Saturday + 2 = Monday');
ok(fo.borderArrivalDate('2026-10-11') === '2026-10-13', 'border date: Sunday + 2 = Tuesday');
ok(fo.borderArrivalDate(null) === null && fo.borderArrivalDate('') === null, 'border date: no PU date -> none');
ok(fo.temperatureSetting('Frozen', -10) === '-10°F (Frozen)' && fo.temperatureSetting('Fresh', 20) === '20°F (Fresh)' && fo.temperatureSetting('Fresh', null) === null && fo.temperatureSetting(null, 20) === null, 'temperature: the degrees come with the name, nothing is invented when there is no setpoint');
const tf = (n) => facilitiesAllFO.filter((f) => f.plant.trim() === n);

const storm = tf('Tyson Foods').filter((f) => f.location_name === 'Storm Lake, IA');
ok(storm.length === 2 && fo.facilityPhones(tf('Tyson Foods'), storm[0]) === '712-749-5333 / 712-749-5285', 'Tyson Storm Lake: both docks\' phones are printed (two rows, one address) — one is never picked for the carrier');
const wat = tf('Tyson Foods').find((f) => f.location_name === 'Waterloo, IA');
ok(fo.facilityPhones(tf('Tyson Foods'), wat) === '319-236-9389 / 319-236-9386', 'a facility whose phone field has two numbers keeps both');
const smith = tf('Smithfield Foods')[0];
ok(fo.facilityPhones(tf('Smithfield Foods'), smith) === null, 'a facility with no phone prints none — the plant\'s general (Mexican sales) phone is never used');
ok(JSON.stringify(fo.facilityBlock('Tyson Foods ', storm[0])) === JSON.stringify(['Tyson Foods', '1009 Richland Dr, Storm Lake, IA 50588']), 'pick-up block: plant name + street address (the city is not repeated)');
ok(JSON.stringify(fo.facilityBlock('Smithfield Foods', smith)) === JSON.stringify(['Smithfield Foods', smith.city + ', ' + smith.state]), 'pick-up block without a street address: plant + City, ST');
ok(JSON.stringify(fo.agencyBlock({ name: 'Palos Garza Forwarding LLC', address: '12120 River Bank Dr', city: 'Laredo' })) === JSON.stringify(['Palos Garza Forwarding LLC', '12120 River Bank Dr', 'Laredo']), 'delivery block: agency, street address, city');
ok(JSON.stringify(fo.agencyBlock({ name: 'Al-Com', address: '14614 Archer Drive Suite C, Laredo, TX 78046', city: 'Laredo' })) === JSON.stringify(['Al-Com', '14614 Archer Drive Suite C, Laredo, TX 78046']), 'delivery block: the city is not repeated when the address has it');
ok(fo.agencyText({ name: 'Palos Garza Forwarding LLC', address: '12120 River Bank Dr', city: 'Laredo', country: 'United States' }) === 'Palos Garza Forwarding LLC, 12120 River Bank Dr, Laredo, United States', 'delivery text for the carrier\'s email');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
