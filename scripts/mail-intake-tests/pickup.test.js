// Where a FOB load is collected, and the customs agency of a delivered one — through the REAL handlers (sent-offers-mark-won, orders-compose-po,
// orders-compose-fo, shipments-set-pickup-location), with the database faked, for EVERY plant (fixtures/plants-geo.json, plant-facilities.json).
// What it proves, per plant: an order is never created and a PO / FO never issued without the plant facility + its street address (or the customs
// agency + its street address); nothing is guessed from the offices or from "the only facility"; the question is the same for every plant; the
// answer is stored on the facility (found next time) and on the shipment; a refused order never takes an order number (the numbering never skips).
const P = require('./harness.js');
const plants = require('./fixtures/plants-geo.json').map((p, i) => ({ ...p, id: 'plant-' + i }));
const facilitiesAll = require('./fixtures/plant-facilities.json');
// A plant with exactly ONE registered facility (none of the real ones has just one today): it must still be asked, never assumed.
plants.push({ ...plants[0], id: 'plant-single', name: 'Single Site Foods' });
facilitiesAll.push({ plant: 'Single Site Foods', id: 'pl-single', location_id: 'loc-single', location_name: 'Guymon, OK', address: '1 Plant Way, Guymon, OK 73942', city: 'Guymon', state: 'OK' });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };

// ---------- a fake database that answers by the shape of the SQL and records every statement
let current = null;
const dispatcher = (...a) => current.run(...a);
dispatcher.begin = (fn) => fn(dispatcher);
dispatcher.json = (v) => v;
globalThis.__pgFactory = () => dispatcher;
const handlers = {};
globalThis.Deno.serve = (h) => { globalThis.__lastHandler = h; };
for (const [k, file] of [['markWon', 'sent-offers-mark-won'], ['composePo', 'orders-compose-po'], ['composeFo', 'orders-compose-fo'], ['setPickup', 'shipments-set-pickup-location']]) {
  P.__load(P.__root + file + '/index.ts'); handlers[k] = globalThis.__lastHandler;
}
const call = async (name, body) => { const res = await handlers[name](new Request('http://x', { method: 'POST', body: JSON.stringify(body) })); return { status: res.status, body: await res.json() }; };

function world(w) {
  const log = [];
  const norm = (strings, vals) => strings.reduce((a, s, i) => a + s + (i < vals.length ? '$' + (i + 1) : ''), '').replace(/\s+/g, ' ').trim().toLowerCase();
  const facs = w.facilities.map((f) => ({ id: f.id, location_id: f.location_id, location_name: f.location_name, address: f.address || null, city: f.city, state: f.state, plant_id: w.plant.id }));
  const routes = [
    [/^select \* from sent_offers where id =/, () => [w.offer]],
    [/^select \* from purchase_orders where order_number/, () => [w.po]],
    [/^select \* from plants where id/, () => [w.plantRow]],
    [/from plants p left join countries c/, () => [{ country_name: w.plant.country_name, iso2: w.plant.iso2, state_name: w.plant.state_name, state_code: w.plant.state_code }]],
    [/^select name from plants where id/, () => [{ name: w.plant.name }]],
    [/^select o\.plant_id, o\.product_id, o\.us_freight_rate_id, p\.name as plant_name from sent_offers/, () => [{ plant_id: w.plant.id, product_id: 'prod-1', us_freight_rate_id: w.offer.us_freight_rate_id, plant_name: w.plant.name }]],
    [/^select o\.plant_id, p\.name as plant_name from sent_offers/, () => [{ plant_id: w.plant.id, plant_name: w.plant.name }]],
    [/from plant_locations pl left join locations l on l\.id = pl\.location_id where pl\.plant_id = \$1 order by/, () => facs],
    [/from plant_locations pl left join locations l on l\.id = pl\.location_id where pl\.plant_id = \$1 and pl\.location_id = \$2/, (v) => facs.filter((f) => f.location_id === v[1])],
    [/from plant_locations pl left join locations l on l\.id = pl\.location_id where pl\.id = \$1/, (v) => facs.filter((f) => f.id === v[0]).concat(w.created.filter((f) => f.id === v[0]))],
    [/^select plant_id from plant_locations where id/, (v) => facs.concat(w.created).filter((f) => f.id === v[0]).map((f) => ({ plant_id: f.plant_id }))],
    [/^select pickup_location_id from shipments where order_number/, () => [{ pickup_location_id: w.manualId || null }]],
    [/^select \* from shipments where order_number/, () => [{ id: 'sh1', order_number: 'BT-2026-9000', sent_offer_id: w.offer.id, pickup_location_id: null }]],
    [/from provider_rates r left join locations l/, () => (w.rate ? [w.rate] : [])],
    [/from plant_products pp left join locations l/, () => (w.productPlace ? [w.productPlace] : [])],
    [/^select customs_agency_provider_id from customers/, () => [{ customs_agency_provider_id: w.customerAgencyId || null }]],
    [/^select id, name, address from providers where id/, (v) => (w.agencies.filter((a) => a.id === v[0]))],
    [/^select distinct p\.id, p\.name, p\.address from providers p join provider_roles/, () => w.agencies],
    [/^select a\.\*, c\.name_en as country_name from providers a/, () => { const id = w.offer.customs_agency_provider_id || w.customerAgencyId; const a = w.agencies.find((x) => x.id === id); return a ? [{ ...a, country_name: 'United States' }] : []; }],
    [/^select t\.name_en as temperature/, () => [{ temperature: 'Frozen', po_setpoint_f: -10 }]],
    [/^select hash from audit_log/, () => []],
    [/^insert into audit_log/, () => []],
    [/^select next_order_number\(\)/, () => [{ next_order_number: 'BT-2026-9000' }]],
    [/^update sent_offers set status = 'won'/, () => [{ ...w.offer, status: 'won', order_number: 'BT-2026-9000' }]],
    [/^update sent_offers set customs_agency_provider_id/, (v) => [{ ...w.offer, customs_agency_provider_id: v[0] }]],
    [/^update providers set address/, (v) => [{ id: v[1], address: v[0] }]],
    [/^insert into purchase_orders/, () => [{ id: 'po1' }]],
    [/^insert into sales_orders/, () => [{ id: 'so1' }]],
    [/^select \* from provider_rates where id/, () => (w.rate ? [{ ...w.rate, id: w.offer.us_freight_rate_id, provider_id: 'carrier-1', origin: 'Freight Origin IA', destination: 'Border', rate: 4000, currency: 'USD', currency_id: null }] : [])],
    [/^insert into freight_orders/, (v) => [{ id: 'fo1', carrier_provider_id: v[2], origin: v[3] }]],
    [/^select name from providers where id/, () => [{ name: 'Agency' }]],
    [/^insert into shipments/, () => [{ id: 'sh1' }]],
    [/^insert into shipment_events/, () => []],
    [/^select \* from freight_orders where order_number = \$1 and lower\(trim/, () => (w.freightRows || [])],
    [/^update freight_orders set origin/, (v) => [{ id: v[1], origin: v[0] }]],
    [/^update shipments set pickup_location_id/, (v) => [{ id: 'sh1', pickup_location_id: v[0] }]],
    [/^select \* from freight_orders where order_number = \$1$/, () => w.freightRows || []],
    [/^select \* from providers where id/, () => [{ id: 'carrier-1', name: 'Carrier' }]],
    [/^select id from locations where lower\(city\)/, () => w.knownLocationId ? [{ id: w.knownLocationId }] : []],
    [/^insert into locations/, () => [{ id: 'loc-new' }]],
    [/^update plant_locations set address/, (v) => [{ id: v[1], address: v[0] }]],
    [/^insert into plant_locations/, (v) => { const f = { id: 'pl-new', plant_id: v[0], location_name: v[1], address: v[2], location_id: v[3], idempotency_key: v[4] }; w.created.push(f); return [f]; }],
  ];
  const run = async (strings, ...vals) => {
    const text = norm(strings, vals);
    log.push({ text, vals });
    for (const [re, fn] of routes) if (re.test(text)) return fn(vals, text);
    throw new Error('unrouted SQL in test: ' + text.slice(0, 140));
  };
  w.created = [];
  current = { run, log };
  return log;
}

const shipmentInsert = (log) => log.find((l) => l.text.startsWith('insert into shipments'));
const foInsert = (log) => log.find((l) => l.text.startsWith('insert into freight_orders'));
const tookNumber = (log) => log.some((l) => l.text.startsWith('select next_order_number'));
const wrote = (log) => log.filter((l) => /^(insert|update) /.test(l.text) && !l.text.startsWith('insert into audit_log'));

const mkWorld = (plant, over = {}) => {
  const facilities = facilitiesAll.filter((f) => f.plant === plant.name);
  const offer = { id: 'offer-1', status: 'sent', plant_id: plant.id, plant_name: plant.name, product_id: 'prod-1', product_name: 'Item', product_spec: 'Item, Box', customer_id: 'cust-1', customer_name: 'Customer', us_freight_amount: 4000, us_freight_rate_id: null, customs_agency_provider_id: null, docs_on: false, purchase_price: 1, total_cost: 40000, total_sale: 50000, sale_per_lb: 1.25, weight: 40000, delivery_dates: ['2026-10-10'], ...over.offer };
  return { plant, facilities, offer, plantRow: { id: plant.id, name: plant.name, address: plant.address, city: plant.city }, po: { order_number: 'BT-2026-9000', sent_offer_id: 'offer-1', plant_id: plant.id, product_id: 'prod-1', product_name: 'Item', product_spec: 'Item, Box', docs_on: false, delivery_dates: ['2026-10-10'], weight: 40000, purchase_price: 1, total_cost: 40000, created_at: '2026-10-03T12:00:00Z' }, rate: null, productPlace: null, agencies: [], customerAgencyId: null, ...over.world };
};
const MARK = { actor: 'test@bt', sent_offer_id: 'offer-1', confirmed_delivery_date: '2026-10-10', override_credit_check: true };

(async () => {
  const bad = [];
  let facilitiesChecked = 0;

  for (const plant of plants) {
    const facs = facilitiesAll.filter((f) => f.plant === plant.name);
    const withAddr = facs.find((f) => (f.address || '').trim());
    const noAddr = facs.find((f) => !(f.address || '').trim());

    // 1. FOB, the quote carries nothing: the order is NOT created, nothing written, no order number taken; the question offers only this plant's own facilities
    let w = mkWorld(plant); let log = world(w);
    let r = await call('markWon', MARK);
    const own = new Set(facs.map((f) => f.id));
    if (r.status !== 409 || r.body.error !== 'pickup_location_required' || r.body.need !== 'facility' || r.body.options.some((o) => !own.has(o.id)) || tookNumber(log) || wrote(log).length) bad.push(plant.name + ': FOB with nothing in the quote must ask and write nothing — ' + r.status + ' ' + r.body.error);
    if (r.body.plant_name !== plant.name.trim().replace(/\s+/g, ' ')) bad.push(plant.name + ': the question names the plant');
    // dry run says the same, writes nothing
    r = await call('markWon', { ...MARK, dry_run: true });
    if (r.status !== 409) bad.push(plant.name + ': dry_run asks too');

    // 2. FOB, answered with a NEW facility (City, ST + street address): the facility is created for THIS plant, the shipment and the FO carry it
    w = mkWorld(plant); log = world(w);
    r = await call('markWon', { ...MARK, pickup: { new_location_name: 'Springfield, IL', address: '100 Plant Rd, Springfield, IL 62701' } });
    const created = log.find((l) => l.text.startsWith('insert into plant_locations'));
    const sh = shipmentInsert(log); const fo = foInsert(log);
    if (r.status !== 200 || !created || created.vals[0] !== plant.id || created.vals[2] !== '100 Plant Rd, Springfield, IL 62701' || !sh || !sh.vals.includes('pl-new') || !fo || !fo.vals.includes(plant.name.trim().replace(/\s+/g, ' ') + ', 100 Plant Rd, Springfield, IL 62701')) bad.push(plant.name + ': answered with a new facility -> created for the plant, on the shipment and in the FO — ' + r.status + JSON.stringify(r.body).slice(0, 120));

    // 2b. a typed address that is not an address, or a location that is not City, ST: refused BEFORE the order number is taken
    w = mkWorld(plant); log = world(w);
    r = await call('markWon', { ...MARK, pickup: { new_location_name: 'Springfield, IL', address: 'asdf' } });
    if (r.status !== 400 || tookNumber(log) || wrote(log).length) bad.push(plant.name + ': a bad address must be refused before taking an order number');
    w = mkWorld(plant); log = world(w);
    r = await call('markWon', { ...MARK, pickup: { new_location_name: 'Midwest', address: '100 Plant Rd, Springfield, IL 62701' } });
    if (r.status !== 400 || tookNumber(log)) bad.push(plant.name + ': a location that is not City, ST must be refused before taking an order number');

    for (const f of facs) {
      facilitiesChecked++;
      const hasAddr = !!(f.address || '').trim();
      // 3. the quote carries the freight origin of this facility
      w = mkWorld(plant, { offer: { us_freight_rate_id: 'rate-1' }, world: { rate: { location_id: f.location_id, city: f.city, state: f.state } } }); log = world(w);
      r = await call('markWon', MARK);
      if (hasAddr) {
        const s2 = shipmentInsert(log); const f2 = foInsert(log);
        if (r.status !== 200 || !s2 || !s2.vals.includes(f.id) && !facs.some((x) => x.location_id === f.location_id && s2.vals.includes(x.id)) || !f2 || !f2.vals.some((v) => typeof v === 'string' && v.includes(f.address.trim()))) bad.push(plant.name + ' / ' + f.location_name + ': freight origin with an address -> order created with this facility fixed on the shipment and its address in the FO — ' + r.status);
        if (log.some((l) => l.text.startsWith('insert into plant_locations'))) bad.push(plant.name + ' / ' + f.location_name + ': nothing new should be created');
      } else {
        // the facility is known but has no street address: asked, never created without it
        if (r.status !== 409 || r.body.need !== 'address' || r.body.facility.id !== f.id || tookNumber(log) || wrote(log).length) bad.push(plant.name + ' / ' + f.location_name + ': facility without a street address must ask for it — ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 100));
        // answered with the address: stored on the facility (found next time), order created with it
        w = mkWorld(plant, { offer: { us_freight_rate_id: 'rate-1' }, world: { rate: { location_id: f.location_id, city: f.city, state: f.state } } }); log = world(w);
        r = await call('markWon', { ...MARK, pickup: { address: '1 Dock Rd, Anytown, ST 12345' } });
        const upd = log.find((l) => l.text.startsWith('update plant_locations set address'));
        const s3 = shipmentInsert(log);
        if (r.status !== 200 || !upd || upd.vals[0] !== '1 Dock Rd, Anytown, ST 12345' || upd.vals[1] !== f.id || !s3 || !s3.vals.includes(f.id)) bad.push(plant.name + ' / ' + f.location_name + ': address typed for a known facility -> saved on the facility and the order created — ' + r.status);
      }
      // 4. the price's location (pricing) carries it, no freight origin
      w = mkWorld(plant, { world: { productPlace: { location_id: f.location_id, city: f.city, state: f.state } } }); log = world(w);
      r = await call('markWon', MARK);
      if (hasAddr ? r.status !== 200 : (r.status !== 409 || r.body.need !== 'address')) bad.push(plant.name + ' / ' + f.location_name + ': the price\'s location resolves the same way — ' + r.status);
    }

    // 5. delivered by the plant at the border: customs agency + street address, asked before the order exists
    const agencyOk = { id: 'ag-1', name: 'Agency Ok', address: '12120 River Bank Dr, Laredo, TX 78045' };
    const agencyBlank = { id: 'ag-2', name: 'Agency Blank', address: null };
    w = mkWorld(plant, { offer: { us_freight_amount: 0 }, world: { agencies: [agencyOk, agencyBlank] } }); log = world(w);
    r = await call('markWon', MARK);
    if (r.status !== 409 || r.body.need !== 'agency' || r.body.options.length !== 2 || tookNumber(log) || wrote(log).length) bad.push(plant.name + ': delivered with no customs agency must ask which one and write nothing — ' + r.status);
    w = mkWorld(plant, { offer: { us_freight_amount: 0 }, world: { agencies: [agencyOk, agencyBlank], customerAgencyId: 'ag-2' } }); log = world(w);
    r = await call('markWon', MARK);
    if (r.status !== 409 || r.body.need !== 'address' || r.body.agency.id !== 'ag-2' || tookNumber(log)) bad.push(plant.name + ': delivered with an agency that has no street address must ask for it — ' + r.status);
    w = mkWorld(plant, { offer: { us_freight_amount: 0 }, world: { agencies: [agencyOk, agencyBlank], customerAgencyId: 'ag-2' } }); log = world(w);
    r = await call('markWon', { ...MARK, customs: { customs_agency_provider_id: 'ag-2', address: '200 Customs Ave, Laredo, TX 78041' } });
    const upAg = log.find((l) => l.text.startsWith('update providers set address'));
    if (r.status !== 200 || !upAg || upAg.vals[0] !== '200 Customs Ave, Laredo, TX 78041' || upAg.vals[1] !== 'ag-2' || shipmentInsert(log).vals.includes('pl-new')) bad.push(plant.name + ': delivered, address typed -> saved on the agency, order created — ' + r.status);
    w = mkWorld(plant, { offer: { us_freight_amount: 0 }, world: { agencies: [agencyOk, agencyBlank] } }); log = world(w);
    r = await call('markWon', { ...MARK, customs: { customs_agency_provider_id: 'ag-1' } });
    const upOffer = log.find((l) => l.text.startsWith('update sent_offers set customs_agency_provider_id'));
    if (r.status !== 200 || !upOffer || upOffer.vals[0] !== 'ag-1' || wrote(log).some((l) => l.text.startsWith('insert into plant_locations'))) bad.push(plant.name + ': delivered, agency chosen -> stored on the offer, order created without any pickup question — ' + r.status);
    w = mkWorld(plant, { offer: { us_freight_amount: 0 }, world: { agencies: [agencyOk], customerAgencyId: 'ag-1' } }); log = world(w);
    r = await call('markWon', MARK);
    if (r.status !== 200 || shipmentInsert(log).vals.some((v) => v && String(v).startsWith('pl-')) || log.some((l) => l.text.includes('plant_locations'))) bad.push(plant.name + ': delivered with a complete agency is created and never asks a pickup — ' + r.status);

    // 6. the Purchase Order and the Freight Order for an EXISTING order: same rule, nothing printed from the offices
    for (const f of facs) {
      const hasAddr = !!(f.address || '').trim();
      const wq = { offer: { us_freight_rate_id: 'rate-1' }, world: { rate: { location_id: f.location_id, city: f.city, state: f.state } } };
      w = mkWorld(plant, wq); log = world(w);
      r = await call('composePo', { order_number: 'BT-2026-9000' });
      if (hasAddr) {
        const officesStreet = (plant.address || '').toLowerCase().replace(/[\s,;]+$/, '');
        const shipTo = (r.body.document && r.body.document.ship_to || '');
        if (r.status !== 200 || !shipTo.includes(f.address.trim().replace(/[\s,;]+$/, '')) || !shipTo.startsWith(plant.name.trim().replace(/\s+/g, ' ')) || (officesStreet && !f.address.toLowerCase().includes(officesStreet) && shipTo.toLowerCase().includes(officesStreet)) || !r.body.document.incoterms.startsWith('FCA – ') || !r.body.document.incoterms.includes(f.city)) bad.push(plant.name + ' / ' + f.location_name + ': PO prints the facility with its street address, never the offices — ' + r.status + ' ' + shipTo.slice(0, 80));
      } else if (r.status !== 409 || r.body.need !== 'address') bad.push(plant.name + ' / ' + f.location_name + ': PO of a facility without a street address must ask — ' + r.status);
    }
    w = mkWorld(plant); log = world(w);
    r = await call('composePo', { order_number: 'BT-2026-9000' });
    if (r.status !== 409 || r.body.error !== 'pickup_location_required' || r.body.need !== 'facility') bad.push(plant.name + ': PO with no pickup in the quote must ask — ' + r.status);
    w = mkWorld(plant, { offer: { us_freight_amount: 0 }, world: { agencies: [agencyOk], customerAgencyId: 'ag-1' } }); log = world(w);
    r = await call('composePo', { order_number: 'BT-2026-9000' });
    if (r.status !== 200 || !r.body.document.ship_to.startsWith('Agency Ok\n12120 River Bank Dr') || !r.body.document.incoterms.startsWith('DAP – Agency Ok')) bad.push(plant.name + ': delivered PO prints the customs agency with its street address — ' + r.status);
    w = mkWorld(plant, { offer: { us_freight_amount: 0 }, world: { agencies: [] } }); log = world(w);
    r = await call('composePo', { order_number: 'BT-2026-9000' });
    if (r.status !== 409 || r.body.error !== 'customs_agency_required') bad.push(plant.name + ': delivered PO with no agency must refuse — ' + r.status);
    w = mkWorld(plant, { offer: { us_freight_amount: 0 }, world: { agencies: [agencyBlank], customerAgencyId: 'ag-2' } }); log = world(w);
    r = await call('composePo', { order_number: 'BT-2026-9000' });
    if (r.status !== 409 || r.body.error !== 'customs_agency_required') bad.push(plant.name + ': delivered PO with an agency without a street address must refuse — ' + r.status);

    // FO: the carrier reads the facility with its street address; unresolved -> asks
    if (withAddr) {
      const fr = [{ id: 'fo1', order_number: 'BT-2026-9000', sent_offer_id: 'offer-1', carrier_provider_id: 'carrier-1', origin: plant.name, destination: 'Border', quoted_rate: 4000 }];
      w = mkWorld(plant, { offer: { us_freight_rate_id: 'rate-1' }, world: { rate: { location_id: withAddr.location_id, city: withAddr.city, state: withAddr.state }, freightRows: fr } }); log = world(w);
      r = await call('composeFo', { order_number: 'BT-2026-9000' });
      const doc = r.body.documents && r.body.documents[0];
      if (r.status !== 200 || !doc || !doc.document.pick_up_address.includes(withAddr.address.trim().replace(/[\s,;]+$/, '')) || doc.fo.origin !== doc.document.pick_up_address) bad.push(plant.name + ': the Freight Order tells the carrier the facility with its street address — ' + r.status);
    }
    const fr2 = [{ id: 'fo1', order_number: 'BT-2026-9000', sent_offer_id: 'offer-1', carrier_provider_id: 'carrier-1', origin: plant.name, destination: 'Border', quoted_rate: 4000 }];
    w = mkWorld(plant, { world: { freightRows: fr2 } }); log = world(w);
    r = await call('composeFo', { order_number: 'BT-2026-9000' });
    if (r.status !== 409 || r.body.error !== 'pickup_location_required') bad.push(plant.name + ': the Freight Order of an order with no pickup must ask — ' + r.status);
    // the Mexican leg (starts at the border) is left as it is
    w = mkWorld(plant, { world: { freightRows: [{ id: 'fo2', order_number: 'BT-2026-9000', sent_offer_id: 'offer-1', carrier_provider_id: 'carrier-1', origin: 'Border', destination: 'Monterrey', quoted_rate: 1000 }] } }); log = world(w);
    r = await call('composeFo', { order_number: 'BT-2026-9000' });
    if (r.status !== 200 || r.body.documents[0].fo.origin !== 'Border') bad.push(plant.name + ': the Mexican leg keeps its own origin — ' + r.status);

    // 7. the picker's save (existing order): a facility of ANOTHER plant is refused; a facility of this plant (+ address) is stored on shipment + FO
    if (withAddr || noAddr) {
      const pick = withAddr || noAddr;
      w = mkWorld(plant, { world: { freightRows: [{ id: 'fo1', order_number: 'BT-2026-9000', origin: plant.name, destination: 'Border' }] } }); log = world(w);
      const foreign = facilitiesAll.find((f) => f.plant !== plant.name);
      w.created.push({ id: foreign.id, plant_id: 'someone-else' });
      r = await call('setPickup', { actor: 'test@bt', order_number: 'BT-2026-9000', pickup_location_id: foreign.id });
      if (r.status !== 400 || wrote(log).length) bad.push(plant.name + ': another plant\'s facility must be refused — ' + r.status);
      w = mkWorld(plant, { world: { freightRows: [{ id: 'fo1', order_number: 'BT-2026-9000', origin: plant.name, destination: 'Border' }] } }); log = world(w);
      r = await call('setPickup', { actor: 'test@bt', order_number: 'BT-2026-9000', pickup_location_id: pick.id, address: '1 Dock Rd, Anytown, ST 12345' });
      const setSh = log.find((l) => l.text.startsWith('update shipments set pickup_location_id'));
      const setFo = log.find((l) => l.text.startsWith('update freight_orders set origin'));
      if (r.status !== 200 || !setSh || setSh.vals[0] !== pick.id || !setFo || !setFo.vals[0].includes('1 Dock Rd, Anytown, ST 12345')) bad.push(plant.name + ': the picker\'s answer is stored on the shipment and in the FO — ' + r.status + JSON.stringify(r.body).slice(0, 100));
    }
  }

  ok(plants.length >= 31 && facilitiesChecked >= 19, `${plants.length} plants and ${facilitiesChecked} real facilities run through the real handlers (mark-won, PO, FO, picker save)`);
  ok(!bad.length, 'every plant, every case: FOB asks the facility + street address when the quote lacks it (nothing written, no order number taken), resolves it from the freight origin / the price location, stores the answer on the facility, the shipment and the FO; delivered asks the customs agency + street address; PO and FO never print the offices' + (bad.length ? '\n  ' + bad.slice(0, 25).join('\n  ') : ''));
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
