// Quote more clients — shared by offers.html (row menu ⋮) and trading-tool.html (right after the Invoice is sent).
// Real ask 2026-09-26: when a load is closed, tell the OTHER customers who buy that product, with the real closed
// border price and where the load is going (the buyer's city, never the buyer's name) — a real closed deal is what
// makes it credible. Every message the trader confirms also creates a normal offer (sent_offers, status 'sent') for
// that customer, so if one of them bites it is worked from Offers like any other quote (expires in 10 days like any
// other). No frequency cap: two closed loads = two messages.
//
// sale_per_lb is always the BORDER price (the calculator stores sellBorder there, never the Mexico-side price). A load
// that carried Mexican freight or customs costs is refused, so "frontera" is never said about a price that isn't one.

const QMC_MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

// .45 / 1.09 — two decimals, no leading zero (approved format).
function qmcFmtPrice(n){
  return Number(n || 0).toFixed(2).replace(/^0(?=\.)/, '');
}
// "1 de oct"
function qmcFmtDateEs(d){
  if (!d) return '';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return '';
  return `${day} de ${QMC_MONTHS_ES[m - 1]}`;
}
function qmcFirstName(name){
  return (name || '').trim().split(/\s+/)[0] || '';
}
function qmcHasMexicanCosts(o){
  return !!(o.mexican_dest_rate_id || Number(o.mexican_freight_mxn) > 0 || Number(o.tramite_aduanal_amount) > 0 || Number(o.bodega_americana_amount) > 0);
}

// Loads the closed offer + the candidate customers. Returns { offer, candidates } or { error }.
async function qmcLoad(callApi, offerId){
  let offer = null;
  try { offer = ((await callApi('sent-offers-search', { id: offerId })).results || [])[0] || null; } catch (e) {}
  if (!offer) return { error: 'Could not load this offer.' };
  if (!offer.product_id) return { error: 'This order has no catalog product linked.' };
  if (qmcHasMexicanCosts(offer)) return { error: 'This load includes Mexican freight or customs costs, so its price is not a border price.' };

  let links = [];
  try { links = (await callApi('customer-products-search', { product_ids: [offer.product_id] })).results || []; } catch (e) {}
  const candidateIds = [...new Set(links.map(l => l.customer_id))].filter(id => id !== offer.customer_id);
  if (!candidateIds.length) return { offer, candidates: [] };

  let candidates = [];
  try { candidates = (await callApi('customers-search', { ids: candidateIds })).results || []; } catch (e) {}
  return { offer, candidates };
}

function qmcMessage(offer, customer, buyerCity){
  const hola = qmcFirstName(customer.contact_name); // no contact on file → plain "Hola," (a company name is not a first name)
  const product = offer.product_spec_es || offer.product_name_es || offer.product_spec || offer.product_name || '';
  const delivery = qmcFmtDateEs(offer.delivery_dates && offer.delivery_dates[0]);
  return `Hola${hola ? ' ' + hola : ''},\n\n`
    + `Quería que supieras que acabamos de cerrar una carga de ${product} marca ${(offer.plant_name || '').trim()}`
    + ` a ${qmcFmtPrice(offer.sale_per_lb)} USD/lb frontera`
    + (buyerCity ? ` para ${buyerCity}` : '')
    + (delivery ? ` la semana del ${delivery}` : '')
    + `. Si te interesa, avísame y revisamos con la planta si tienen más cargas. ¡Saludos!`;
}

// The new customer's offer: same product, plant, border price and US-side costs as the closed load. Mexican-side
// fields stay empty (a border price has none). Idempotency key per closed load + customer, so re-running this for
// the same load never creates the same offer twice.
function qmcOfferRow(offer, customer, channel, actor){
  return {
    actor, channel,
    idempotency_key: `quote-more-clients|${offer.id}|${customer.id}`,
    product_id: offer.product_id,
    product_name: offer.product_name, product_name_es: offer.product_name_es,
    product_spec: offer.product_spec, product_spec_es: offer.product_spec_es,
    plant_id: offer.plant_id, customer_id: customer.id,
    purchase_price: offer.purchase_price,
    us_freight_rate_id: offer.us_freight_rate_id, us_freight_amount: offer.us_freight_amount || 0,
    docs_on: offer.docs_on === true, inspection_amount: offer.inspection_amount || 0,
    mexican_dest_rate_id: null, mexican_freight_mxn: null, customs_agency_provider_id: null,
    tramite_aduanal_amount: 0, bodega_americana_amount: 0,
    extra_fields: offer.extra_fields || [], weight: offer.weight,
    cost_per_lb: offer.cost_per_lb, sale_per_lb: offer.sale_per_lb,
    total_cost: offer.total_cost, total_sale: offer.total_sale,
    delivery_dates: offer.delivery_dates || [],
    photo_url: offer.photo_url || null, spec_url: offer.spec_url || null,
  };
}

// opts: { callApi, actor, offerId, fromDisplay, notify(title, detail, isError), confirm(count) → Promise<bool> | null }
// confirm is the "Quote more clients?" gate (QT, after the Invoice); the Offers menu calls it without one.
async function qmcRun(opts){
  const { callApi, actor, offerId, fromDisplay, notify } = opts;
  const { offer, candidates, error } = await qmcLoad(callApi, offerId);
  if (error){ notify('Quote more clients', error, true); return; }
  if (!candidates.length){ notify('Quote more clients', 'No other customer is linked to this product.', false); return; }
  if (opts.confirm && !(await opts.confirm(candidates.length))) return;

  let buyerCity = '';
  try { buyerCity = (((await callApi('customers-search', { ids: [offer.customer_id] })).results || [])[0] || {}).city || ''; } catch (e) {}

  const productLabel = offer.product_spec_es || offer.product_name_es || offer.product_name || '';
  let created = 0;
  for (const c of candidates){
    const message = qmcMessage(offer, c, buyerCity);
    const phone = (c.whatsapp || c.phone || '').replace(/\D/g, '');
    let outcome = null, channel = null;
    if (c.email){
      outcome = await bcOpenEmailModal({
        title: `Quote more clients — ${c.trade_name}`, fromAlias: 'offers', fromDisplay,
        to: [c.email], subject: `Precio cerrado — ${productLabel}`, text: message,
        waInfo: phone ? { phone, message } : null,
      });
      channel = 'email';
    } else if (phone){
      outcome = await bcOpenWaOnlyModal({ title: `Quote more clients — ${c.trade_name}`, phone, message });
      channel = 'whatsapp';
    } else {
      continue; // no email, no phone on file — nothing to send this one
    }
    if (!(outcome && outcome.sent)) continue;
    try {
      await callApi('sent-offers-create', qmcOfferRow(offer, c, channel, actor));
      created++;
    } catch (e) {
      notify('Offer not saved', `${c.trade_name}: ${e.message}`, true);
    }
  }
  notify('Quote more clients', created ? `${created} offer${created === 1 ? '' : 's'} created — find them in Offers.` : 'No message sent.', false);
}
