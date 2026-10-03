// Composing a Purchase Order, shared by orders.html and offers.html. The PO prints the plant FACILITY where the load is collected (never the
// plant's offices). When the system has no record of which facility that is, orders-compose-po refuses with "pickup_location_required" and
// this asks the trader to choose one of the plant's own facilities, saves the choice on the shipment (the same field the Status tab and the
// release-number request read) and composes again — so a PO is never issued with a guessed or missing pick-up place.
// Needs the page's own callApi() and currentActor().

let bcPoPickupResolve = null;

function bcEnsurePoPickupModal(){
  if (document.getElementById('poPickupModalOverlay')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
<div id="poPickupModalOverlay" class="email-modal-overlay" style="display:none;">
  <div class="email-modal-box" style="max-width:520px;">
    <h3>Pick a pickup location</h3>
    <div class="email-modal-from" id="poPickupModalText"></div>
    <div id="poPickupModalList" style="display:flex;flex-direction:column;gap:8px;margin-top:14px;"></div>
    <div class="email-modal-actions">
      <button onclick="bcPoPickupChoose(null)" style="background:var(--card);color:var(--blue-bright);border:1.5px solid var(--blue);border-radius:8px;padding:9px 16px;font-weight:600;font-size:13px;cursor:pointer;">Cancel</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(wrap.firstElementChild);
}

function bcPoPickupChoose(id){
  document.getElementById('poPickupModalOverlay').style.display = 'none';
  const resolve = bcPoPickupResolve;
  bcPoPickupResolve = null;
  if (resolve) resolve(id);
}

function bcAskPoPickupLocation(info){
  bcEnsurePoPickupModal();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  document.getElementById('poPickupModalText').textContent = info.message;
  document.getElementById('poPickupModalList').innerHTML = (info.options || []).map((o) => `
    <button type="button" class="btn secondary" style="width:100%;text-align:left;padding:10px 14px;" onclick="bcPoPickupChoose('${esc(o.id)}')">
      ${esc(o.location_name)}${o.address ? `<br><span style="opacity:.7;font-weight:400;">${esc(o.address)}</span>` : ''}
    </button>`).join('');
  document.getElementById('poPickupModalOverlay').style.display = 'flex';
  return new Promise((resolve) => { bcPoPickupResolve = resolve; });
}

async function bcComposePO(orderNumber){
  try { return await callApi('orders-compose-po', { order_number: orderNumber }); }
  catch (e) {
    if (!(e.data && e.data.error === 'pickup_location_required')) throw e;
    const pickedId = await bcAskPoPickupLocation(e.data);
    if (!pickedId) throw new Error('The PO was not issued: the pickup location was not chosen.');
    try { await callApi('shipments-set-pickup-location', { actor: currentActor(), order_number: orderNumber, pickup_location_id: pickedId }); }
    catch (err) { throw new Error('Could not save the pickup location: ' + err.message); }
    return await callApi('orders-compose-po', { order_number: orderNumber });
  }
}
