// Where a FOB load is collected (the plant FACILITY with its street address) and, for a load the plant delivers at the border, the customs agency
// with its street address — asked from the trader BEFORE an order is created, and again when a Purchase Order / Freight Order is composed for an
// order that does not have it complete. The system never guesses it and never prints the plant's offices. Shared by trading-tool.html, offers.html
// and orders.html; needs the page's own callApi() and currentActor().
//
//   bcCallWithAsk(fn, body)           for endpoints that take the answer inline (sent-offers-mark-won): asks, then sends the call again with
//                                     `pickup` / `customs` in the body.
//   bcComposeDocument(fn, orderNumber) for the read-only composers (orders-compose-po / -fo): asks, saves the answer on the order
//                                     (shipments-set-pickup-location), then composes again.
// Cancelling rejects with an Error whose .cancelled is true — nothing is created or issued, nothing is saved.

let bcAskResolve = null;

function bcEscape(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function bcEnsureAskModal(){
  if (document.getElementById('bcAskOverlay')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
<div id="bcAskOverlay" class="email-modal-overlay" style="display:none;">
  <div class="email-modal-box" style="max-width:520px;">
    <h3 id="bcAskTitle"></h3>
    <div class="email-modal-from" id="bcAskText"></div>
    <div id="bcAskList" style="display:flex;flex-direction:column;gap:8px;margin-top:14px;"></div>
    <div id="bcAskNewWrap" style="display:none;margin-top:12px;">
      <div class="email-modal-field"><label id="bcAskNameLabel">Location (City, ST)</label><input type="text" id="bcAskName" autocomplete="off" placeholder="e.g. Storm Lake, IA"></div>
    </div>
    <div id="bcAskAddrWrap" style="display:none;margin-top:12px;">
      <div class="email-modal-field"><label>Street address</label><input type="text" id="bcAskAddr" autocomplete="off" placeholder="e.g. 1009 Richland Dr, Storm Lake, IA 50588"></div>
    </div>
    <div id="bcAskErr" style="display:none;color:#FF9C8A;font-size:12.5px;margin-top:4px;"></div>
    <div class="email-modal-actions">
      <button id="bcAskNewBtn" onclick="bcAskToggleNew()" style="margin-right:auto;background:var(--card);color:var(--blue-bright);border:1.5px solid var(--blue);border-radius:8px;padding:9px 16px;font-weight:600;font-size:13px;cursor:pointer;">+ New location</button>
      <button onclick="bcAskFinish(null)" style="background:var(--card);color:var(--blue-bright);border:1.5px solid var(--blue);border-radius:8px;padding:9px 16px;font-weight:600;font-size:13px;cursor:pointer;">Cancel</button>
      <button id="bcAskOk" onclick="bcAskConfirm()" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:600;font-size:13px;cursor:pointer;">Confirm</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(wrap.firstElementChild);
}

let bcAskState = null;

function bcAskFinish(value){
  document.getElementById('bcAskOverlay').style.display = 'none';
  const resolve = bcAskResolve;
  bcAskResolve = null; bcAskState = null;
  if (resolve) resolve(value);
}

function bcAskError(msg){ const el = document.getElementById('bcAskErr'); el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; }

function bcAskRender(){
  const st = bcAskState;
  const list = document.getElementById('bcAskList');
  list.innerHTML = st.options.map((o) => {
    const on = st.selectedId === o.id && !st.adding;
    return `<button type="button" data-id="${bcEscape(o.id)}" onclick="bcAskSelect('${bcEscape(o.id)}')" style="width:100%;text-align:left;padding:10px 14px;border-radius:8px;cursor:pointer;font-size:13.5px;font-family:inherit;background:${on ? 'var(--blue)' : 'var(--card)'};color:${on ? '#fff' : 'var(--blue-bright)'};border:1.5px solid var(--blue);">
      <strong>${bcEscape(o.label)}</strong><br><span style="opacity:.75;font-size:12.5px;">${o.sub ? bcEscape(o.sub) : 'street address not on file yet'}</span></button>`;
  }).join('');
  const picked = st.options.find((o) => o.id === st.selectedId);
  const needAddr = st.adding || st.mode === 'address' || (picked && !picked.sub);
  document.getElementById('bcAskNewWrap').style.display = st.adding ? 'block' : 'none';
  document.getElementById('bcAskAddrWrap').style.display = needAddr ? 'block' : 'none';
  document.getElementById('bcAskNewBtn').style.display = st.canAdd ? 'inline-block' : 'none';
  document.getElementById('bcAskNewBtn').textContent = st.adding ? 'Choose from the list' : '+ New location';
  st.needAddr = needAddr;
}

function bcAskSelect(id){ bcAskState.selectedId = id; bcAskState.adding = false; bcAskError(''); bcAskRender(); }
function bcAskToggleNew(){ bcAskState.adding = !bcAskState.adding; bcAskError(''); bcAskRender(); }

function bcAskConfirm(){
  const st = bcAskState;
  const address = document.getElementById('bcAskAddr').value.trim();
  const name = document.getElementById('bcAskName').value.trim();
  if (st.kind === 'customs'){
    if (!st.selectedId) return bcAskError('Choose the customs agency.');
    if (st.needAddr && !address) return bcAskError('Type the street address.');
    return bcAskFinish({ customs_agency_provider_id: st.selectedId, address: st.needAddr ? address : null });
  }
  if (st.adding){
    if (!name) return bcAskError('Type the location (City, ST).');
    if (!address) return bcAskError('Type the street address.');
    return bcAskFinish({ new_location_name: name, address });
  }
  if (!st.selectedId) return bcAskError('Choose the pickup location.');
  if (st.needAddr && !address) return bcAskError('Type the street address.');
  return bcAskFinish({ pickup_location_id: st.selectedId, address: st.needAddr ? address : null });
}

// info = the 409 body of pickup_location_required: { need: 'facility' | 'address', message, options: [{id, location_name, address}], facility, hint_name }
function bcAskPickup(info){
  bcEnsureAskModal();
  const options = info.need === 'address' && info.facility
    ? [{ id: info.facility.id, label: info.facility.location_name, sub: '' }]
    : (info.options || []).map((o) => ({ id: o.id, label: o.location_name, sub: o.address || '' }));
  bcAskState = { kind: 'pickup', mode: info.need, options, selectedId: info.need === 'address' && info.facility ? info.facility.id : null, adding: false, canAdd: info.need !== 'address', needAddr: false };
  if (info.need !== 'address' && !options.length) bcAskState.adding = true;
  document.getElementById('bcAskTitle').textContent = 'Pickup location';
  document.getElementById('bcAskText').textContent = info.message;
  document.getElementById('bcAskName').value = info.hint_name || '';
  document.getElementById('bcAskAddr').value = '';
  bcAskError('');
  bcAskRender();
  document.getElementById('bcAskOverlay').style.display = 'flex';
  return new Promise((resolve) => { bcAskResolve = resolve; });
}

// info = the 409 body of customs_agency_required: { need: 'agency' | 'address', message, options: [{id, name, address}], agency }
function bcAskCustoms(info){
  bcEnsureAskModal();
  const options = info.need === 'address' && info.agency
    ? [{ id: info.agency.id, label: info.agency.name, sub: '' }]
    : (info.options || []).map((o) => ({ id: o.id, label: o.name, sub: o.address || '' }));
  bcAskState = { kind: 'customs', mode: info.need, options, selectedId: info.need === 'address' && info.agency ? info.agency.id : null, adding: false, canAdd: false, needAddr: false };
  document.getElementById('bcAskTitle').textContent = 'Customs agency';
  document.getElementById('bcAskText').textContent = info.message;
  document.getElementById('bcAskAddr').value = '';
  bcAskError('');
  bcAskRender();
  document.getElementById('bcAskOverlay').style.display = 'flex';
  return new Promise((resolve) => { bcAskResolve = resolve; });
}

const bcCancelled = (what) => Object.assign(new Error(`Nothing was ${what}: the ${what === 'created' ? 'pickup / customs details were' : 'pickup location was'} not confirmed.`), { cancelled: true });

// The trader's answers are kept while the order is still being created, so the credit-limit "create anyway" retry never asks again.
const bcAnswerMemo = {};

async function bcCallWithAsk(fn, body){
  const key = fn + '|' + (body.sent_offer_id || '');
  const extra = bcAnswerMemo[key] || (bcAnswerMemo[key] = {});
  for (let attempt = 0; attempt < 4; attempt++){
    try { const result = await callApi(fn, { ...body, ...extra }); delete bcAnswerMemo[key]; return result; }
    catch (e) {
      const code = e.data && e.data.error;
      if (code === 'pickup_location_required'){
        const answer = await bcAskPickup(e.data);
        if (!answer){ delete bcAnswerMemo[key]; throw bcCancelled('created'); }
        extra.pickup = answer; continue;
      }
      if (code === 'customs_agency_required' && e.data.need){
        const answer = await bcAskCustoms(e.data);
        if (!answer){ delete bcAnswerMemo[key]; throw bcCancelled('created'); }
        extra.customs = answer; continue;
      }
      if ((code === 'invalid_address' || code === 'invalid_location_name' || code === 'pickup_location_not_of_this_plant') && (extra.pickup || extra.customs)){
        await btAlert(e.data.message || e.message);
        delete extra.pickup; delete extra.customs; continue;
      }
      throw e;
    }
  }
  throw new Error('The pickup / customs details could not be confirmed.');
}

async function bcComposeDocument(fn, orderNumber){
  for (let attempt = 0; attempt < 3; attempt++){
    try { return await callApi(fn, { order_number: orderNumber }); }
    catch (e) {
      if (!(e.data && e.data.error === 'pickup_location_required')) throw e;
      const answer = await bcAskPickup(e.data);
      if (!answer) throw bcCancelled('issued');
      try { await callApi('shipments-set-pickup-location', { actor: currentActor(), order_number: orderNumber, ...answer }); }
      catch (err) { throw new Error('Could not save the pickup location: ' + ((err.data && err.data.message) || err.message)); }
    }
  }
  throw new Error('The pickup location could not be confirmed.');
}
