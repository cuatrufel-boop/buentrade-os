// Shared dark date picker — replaces the browser's native <input type="date"> calendar popup,
// which is drawn by the OS/browser chrome itself, not the page, so no CSS anywhere can theme it
// (confirmed live 2026-09-21: still the plain white system calendar even on a fully dark modal).
// Same reasoning as the carrier dropdown fix in trading-tool.html (.rq-ddown-*) — a real custom
// component instead of fighting a browser control that was never themeable to begin with.
//
// One real implementation, injected once, used by every date field across the app (trading-tool,
// offers, orders, payments) instead of six separate native inputs each rendering its own
// unstyled system popup — same "one shared source of truth" reasoning as js/email-modal.js.
//
// Usage: <input type="text" id="myDate" placeholder="dd/mm/yyyy" readonly> then
// btDpAttach('myDate') once the input exists in the DOM. Storage/read format stays yyyy-mm-dd
// (input.value), identical to what a native type="date" input already gave every call site — no
// existing reader of .value anywhere in the app needs to change.

const BT_DP = { openFor: null, viewYear: null, viewMonth: null };

function btDpEnsureStyles(){
  if (document.getElementById('btDpStyles')) return;
  const style = document.createElement('style');
  style.id = 'btDpStyles';
  style.textContent = `
    .bt-dp-panel{position:fixed;width:272px;background:rgba(15,31,51,.96);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1.5px solid rgba(232,181,76,.4);border-radius:12px;box-shadow:0 24px 60px rgba(4,12,26,.5);z-index:600;padding:14px;font-family:'Inter',sans-serif;}
    .bt-dp-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
    .bt-dp-month{font-weight:700;font-size:13.5px;color:#fff;font-family:'Space Grotesk',sans-serif;}
    .bt-dp-nav{display:flex;gap:4px;}
    .bt-dp-nav button{background:transparent;border:1px solid rgba(255,255,255,.22);color:#fff;border-radius:6px;width:24px;height:24px;cursor:pointer;font-size:12px;line-height:1;padding:0;}
    .bt-dp-nav button:hover{background:rgba(255,255,255,.1);border-color:rgba(255,255,255,.4);}
    .bt-dp-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;}
    .bt-dp-dow{font-size:9.5px;color:rgba(255,255,255,.45);padding:4px 0;font-weight:700;text-transform:uppercase;}
    .bt-dp-day{padding:6px 0;border-radius:6px;cursor:pointer;font-size:12.5px;color:#fff;}
    .bt-dp-day:hover{background:rgba(255,255,255,.1);}
    .bt-dp-day.bt-dp-other{color:rgba(255,255,255,.22);}
    .bt-dp-day.bt-dp-selected{background:var(--blue,#1E6ADB);color:#fff;font-weight:700;}
    .bt-dp-day.bt-dp-today:not(.bt-dp-selected){border:1px solid rgba(232,181,76,.6);}
    .bt-dp-foot{display:flex;justify-content:space-between;margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,.14);}
    .bt-dp-foot button{background:transparent;border:none;color:var(--blue-bright,#5AAAFF);font-size:12px;font-weight:700;cursor:pointer;padding:2px 4px;}
    .bt-dp-foot button:hover{text-decoration:underline;}
  `;
  document.head.appendChild(style);
}

function btDpEnsurePanel(){
  if (document.getElementById('btDpPanel')) return;
  const el = document.createElement('div');
  el.id = 'btDpPanel';
  el.className = 'bt-dp-panel';
  el.style.display = 'none';
  document.body.appendChild(el);
}

// readonly + click-to-open on a plain text input — a real type="date" input opens its own native
// popup on click in most browsers regardless of styling, so the underlying field has to be text,
// not date, for this replacement to actually take over (value format stays yyyy-mm-dd either way).
function btDpAttach(inputId){
  btDpEnsureStyles();
  btDpEnsurePanel();
  const input = document.getElementById(inputId);
  if (!input || input.dataset.btDpAttached) return;
  input.dataset.btDpAttached = '1';
  input.setAttribute('type', 'text');
  input.setAttribute('readonly', 'readonly');
  input.setAttribute('placeholder', input.getAttribute('placeholder') || 'dd/mm/yyyy');
  input.style.cursor = 'pointer';
  input.addEventListener('click', () => btDpOpen(inputId));
}

function btDpPad(n){ return String(n).padStart(2, '0'); }
function btDpFormat(y, m, d){ return `${y}-${btDpPad(m + 1)}-${btDpPad(d)}`; }
function btDpDisplay(y, m, d){ return `${btDpPad(d)}/${btDpPad(m + 1)}/${y}`; }

function btDpOpen(inputId){
  const input = document.getElementById(inputId);
  const val = input.value; // yyyy-mm-dd, from a prior pick, or blank
  const base = val ? new Date(val + 'T00:00:00') : new Date();
  BT_DP.openFor = inputId;
  BT_DP.viewYear = base.getFullYear();
  BT_DP.viewMonth = base.getMonth();
  btDpRender();
  const panel = document.getElementById('btDpPanel');
  const rect = input.getBoundingClientRect();
  const top = Math.round(rect.bottom + 6);
  const left = Math.round(Math.max(12, Math.min(rect.left, window.innerWidth - 284)));
  panel.style.top = top + 'px';
  panel.style.left = left + 'px';
  panel.style.display = 'block';
}
function btDpClose(){
  const panel = document.getElementById('btDpPanel');
  if (panel) panel.style.display = 'none';
  BT_DP.openFor = null;
}
function btDpNav(delta){
  BT_DP.viewMonth += delta;
  if (BT_DP.viewMonth < 0){ BT_DP.viewMonth = 11; BT_DP.viewYear--; }
  if (BT_DP.viewMonth > 11){ BT_DP.viewMonth = 0; BT_DP.viewYear++; }
  btDpRender();
}
function btDpPick(y, m, d){
  const input = document.getElementById(BT_DP.openFor);
  if (!input) return;
  input.value = btDpFormat(y, m, d);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  btDpClose();
}
function btDpToday(){
  const now = new Date();
  btDpPick(now.getFullYear(), now.getMonth(), now.getDate());
}
function btDpClear(){
  const input = document.getElementById(BT_DP.openFor);
  if (input){
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  btDpClose();
}
const BT_DP_DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
function btDpRender(){
  const panel = document.getElementById('btDpPanel');
  if (!panel) return;
  const y = BT_DP.viewYear, m = BT_DP.viewMonth;
  const input = document.getElementById(BT_DP.openFor);
  const selectedVal = input ? input.value : '';
  const now = new Date();
  const todayY = now.getFullYear(), todayM = now.getMonth(), todayD = now.getDate();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  // Monday-first grid, matching the native picker this replaces.
  const firstOfMonth = new Date(y, m, 1);
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // 0=Mon
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const daysInPrevMonth = new Date(y, m, 0).getDate();

  const cells = [];
  for (let i = startOffset - 1; i >= 0; i--){
    cells.push({ y: m === 0 ? y - 1 : y, m: m === 0 ? 11 : m - 1, d: daysInPrevMonth - i, other: true });
  }
  for (let d = 1; d <= daysInMonth; d++){
    cells.push({ y, m, d, other: false });
  }
  while (cells.length % 7 !== 0 || cells.length < 42){
    const last = cells[cells.length - 1];
    const nd = last.d + 1;
    const rolled = new Date(last.y, last.m, nd);
    cells.push({ y: rolled.getFullYear(), m: rolled.getMonth(), d: rolled.getDate(), other: true });
  }

  const cellsHtml = cells.map(c => {
    const val = btDpFormat(c.y, c.m, c.d);
    const isSelected = selectedVal === val;
    const isToday = c.y === todayY && c.m === todayM && c.d === todayD;
    const cls = ['bt-dp-day', c.other ? 'bt-dp-other' : '', isSelected ? 'bt-dp-selected' : '', isToday ? 'bt-dp-today' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" onclick="btDpPick(${c.y},${c.m},${c.d})">${c.d}</div>`;
  }).join('');

  panel.innerHTML = `
    <div class="bt-dp-head">
      <div class="bt-dp-month">${monthNames[m]} ${y}</div>
      <div class="bt-dp-nav">
        <button type="button" onclick="btDpNav(-1)" title="Previous month">‹</button>
        <button type="button" onclick="btDpNav(1)" title="Next month">›</button>
      </div>
    </div>
    <div class="bt-dp-grid">
      ${BT_DP_DOW.map(d => `<div class="bt-dp-dow">${d}</div>`).join('')}
      ${cellsHtml}
    </div>
    <div class="bt-dp-foot">
      <button type="button" onclick="btDpClear()">Clear</button>
      <button type="button" onclick="btDpToday()">Today</button>
    </div>
  `;
}
document.addEventListener('click', (e) => {
  const panel = document.getElementById('btDpPanel');
  if (!panel || panel.style.display !== 'block') return;
  if (e.target.closest('#btDpPanel')) return;
  if (e.target.dataset && e.target.dataset.btDpAttached) return;
  btDpClose();
}, true);
