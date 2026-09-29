// Profile History — shared by Clients, Plants and Logistics (carriers / customs agencies).
// 2026-09-29 (user): "deberían quedar todos los movimientos hechos con la carga, lo que incumbe a
// cada perfil en orden de fecha en cada perfil. Si hay que buscar, poder ir a encontrarlo fácil y
// contrastar con facturas." Every movement of every load that concerns this profile — documents,
// flow steps, surcharges, provider invoices (with call notes and PDF) and payments — newest first,
// with search (load # / invoice # / text), type filter and date range.
// Uses the page's own callApi, escapeHtml, openDocPdf and btEnhanceSelect, and its own search-box
// classes (prefix cu / pl / pv), so it looks exactly like the rest of that page.
(function(){
  const TYPES = [['', 'All movements'], ['document', 'Documents'], ['invoice', 'Invoices'], ['payment', 'Payments'], ['charge', 'Surcharges'], ['step', 'Steps']];
  // money movements get a badge; documents and steps stay quiet text so payments and invoices stand out
  const BADGE = { document: [null, 'Document'], step: [null, 'Step'], charge: ['due-soon', 'Surcharge'], invoice: ['due-soon', 'Invoice'], payment: ['ok', 'Payment'] };
  const state = {};
  const money = v => v == null ? '' : '$' + Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // date columns come back as midnight UTC — show them as that calendar day; timestamps in Miami time
  const ymd = at => { const s = String(at); if (/^\d{4}-\d{2}-\d{2}(T00:00:00(\.000)?Z)?$/.test(s)) return s.slice(0, 10); return new Date(at).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); };
  const show = d => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;

  window.renderEntityHistory = async function(containerId, entityType, entityId, searchPrefix){
    const el = document.getElementById(containerId); if (!el) return;
    el.innerHTML = '<div class="empty">Loading…</div>';
    let data;
    try { data = await callApi('order-documents-history', { entity_type: entityType, entity_id: entityId }); }
    catch (e) { el.innerHTML = `<div class="empty">Error loading history: ${escapeHtml(e.message)}</div>`; return; }
    state[containerId] = { rows: (data.movements || []).map(m => ({ ...m, day: ymd(m.at) })), inPR: new Set(data.pay_receive_orders || []), q: '', type: '', from: '', to: '', p: searchPrefix };
    draw(containerId);
  };
  window.entityHistorySet = function(containerId, key, value){ state[containerId][key] = value; draw(containerId, key === 'q'); };

  function draw(id, keepFocus){
    const s = state[id], el = document.getElementById(id), q = s.q.trim().toLowerCase();
    const rows = s.rows.filter(m => (!s.type || m.kind === s.type) && (!s.from || m.day >= s.from) && (!s.to || m.day <= s.to)
      && (!q || [m.order_number, m.label, m.ref].some(v => v && String(v).toLowerCase().includes(q))));
    const date = (key, lab) => `<label class="muted" style="font-size:12px;font-weight:600;display:inline-flex;align-items:center;gap:6px;">${lab}<input type="date" value="${s[key]}" onchange="entityHistorySet('${id}','${key}',this.value)" style="height:38px;box-sizing:border-box;padding:0 8px;border-radius:7px;border:1.5px solid rgba(90,170,255,.4);background:rgba(255,255,255,.05);color:var(--blue-bright);font-weight:700;font-size:12px;font-family:'Inter',sans-serif;color-scheme:dark;"></label>`;
    const loadLink = n => n.split(', ').map(o => `<a href="${s.inPR.has(o) ? 'collections.html?focus=' : 'orders.html?open='}${encodeURIComponent(o)}" style="color:var(--blue-bright);">${escapeHtml(o)}</a>`).join(', ');
    const docCell = m => m.file_url ? `<a href="${m.file_url}" target="_blank" style="color:var(--blue-bright);">Invoice PDF</a>`
      : m.doc ? `<a href="#" onclick="openDocPdf('${m.doc}','${m.order_number}');return false;" style="color:var(--blue-bright);">${m.doc} PDF</a>` : '';
    const total = rows.filter(m => m.kind === 'payment').reduce((n, m) => n + (m.amount || 0), 0);
    el.innerHTML = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0 12px;">
        <div class="${s.p}-search-wrap" style="width:220px;height:38px;"><svg class="${s.p}-search-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg><input id="${id}_q" class="${s.p}-search-input" placeholder="Load # or invoice #" value="${escapeHtml(s.q)}" oninput="entityHistorySet('${id}','q',this.value)"></div>
        <select id="${id}_type" style="width:160px;" onchange="entityHistorySet('${id}','type',this.value)">${TYPES.map(([v, l]) => `<option value="${v}"${s.type === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <span style="display:inline-flex;align-items:center;gap:8px;white-space:nowrap;">${date('from', 'From')}${date('to', 'to')}</span>
        <span class="muted" style="margin-left:auto;font-size:12px;">${rows.length} movement${rows.length === 1 ? '' : 's'}${total ? ` · payments <b style="color:var(--ink);">${money(total)}</b>` : ''}</span></div>
      <div class="table-scroll"><table><thead><tr><th>Date</th><th>Load</th><th>Type</th><th>Movement</th><th>Amount</th><th>Reference</th><th></th></tr></thead><tbody>
      ${rows.map(m => { const b = BADGE[m.kind] || ['', m.kind];
        return `<tr><td class="mono" style="white-space:nowrap;">${show(m.day)}</td><td class="order-num" style="white-space:nowrap;">${m.order_number ? loadLink(m.order_number) : '—'}</td><td>${b[0] ? `<span class="payment-badge ${b[0]}">${b[1]}</span>` : `<span class="muted" style="font-size:12px;">${b[1]}</span>`}</td>
          <td>${escapeHtml(m.label)}</td><td class="num" style="white-space:nowrap;">${money(m.amount)}</td><td class="muted" style="font-size:12px;">${escapeHtml(m.ref || '')}</td><td style="white-space:nowrap;">${docCell(m)}</td></tr>`; }).join('')
        || `<tr><td colspan="7" class="empty">${s.rows.length ? 'No movements match.' : 'No movements yet.'}</td></tr>`}
      </tbody></table></div>`;
    if (typeof btEnhanceSelect === 'function') btEnhanceSelect(document.getElementById(`${id}_type`));
    if (keepFocus){ const i = document.getElementById(`${id}_q`); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }
})();
