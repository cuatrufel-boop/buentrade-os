// Market Flash v2 — shared by quotes.html, orders.html and trading-tool.html.
// When a customer message that carries Market Flash bullets goes out, record that those bullets reached that
// customer (unique per bullet+customer server-side, so a retry can never double-count) — that is what keeps the
// next message from repeating them. Same "log when the message is built for sending" moment the offers
// themselves are logged (sent_offers). Never throws into a send flow: a failed log only means a bullet could
// be picked again later.
async function mfLogSends(callApi, marketNote, customerId, channel, actor){
  if (!marketNote || !marketNote.bulletIds || !marketNote.bulletIds.length || !customerId) return;
  try {
    await callApi('customer-product-signal', { log_market_flash_sends: { bullet_ids: marketNote.bulletIds, customer_id: customerId, channel: channel, actor: actor } });
  } catch (e) { console.error('market flash send log failed', e); }
}
