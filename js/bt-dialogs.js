// BuenTrade dialogs — Alert, Confirm and Prompt in the app's own look instead of the browser's gray
// system boxes (user 2026-09-29: "revisa todos los módulos, colores, botones… y restaura"). Same
// recipe as .email-modal-box (frosted navy, gold border) and the page's own .btn / .btn.secondary
// buttons. Self-contained: works on pages that don't load email-modal.js; where email-modal.js already
// defines btAlert, that one is kept.
(function(){
  const CSS = `.bt-dlg-overlay{position:fixed;inset:0;background:rgba(15,31,51,.45);z-index:9500;display:none;align-items:center;justify-content:center;padding:20px;}
.bt-dlg-box{background:rgba(15,31,51,.94);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1.5px solid rgba(232,181,76,.4);border-radius:14px;width:100%;max-width:440px;padding:22px 24px;box-shadow:0 24px 60px rgba(4,12,26,.45);color:#fff;font-family:inherit;}
.bt-dlg-msg{font-size:13.5px;line-height:1.5;white-space:pre-wrap;}
.bt-dlg-input{width:100%;box-sizing:border-box;margin-top:12px;padding:9px 12px;border-radius:8px;border:1.5px solid rgba(90,170,255,.4);background:rgba(255,255,255,.06);color:#fff;font-family:inherit;font-size:13.5px;}
.bt-dlg-input:focus{outline:none;border-color:#5AAAFF;}
.bt-dlg-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:18px;}`;
  let resolveFn = null, mode = 'alert';
  function ensure(){
    if (document.getElementById('btDlgOverlay')) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div id="btDlgOverlay" class="bt-dlg-overlay"><div class="bt-dlg-box">
      <div id="btDlgMsg" class="bt-dlg-msg"></div>
      <input id="btDlgInput" class="bt-dlg-input" type="text" autocomplete="off" style="display:none;" onkeydown="if(event.key==='Enter')btDlgClose(true);if(event.key==='Escape')btDlgClose(false);">
      <div class="bt-dlg-actions"><button type="button" class="btn secondary" id="btDlgCancel" onclick="btDlgClose(false)">Cancel</button><button type="button" class="btn" id="btDlgOk" onclick="btDlgClose(true)">OK</button></div>
    </div></div>`;
    document.body.appendChild(wrap.firstElementChild);
  }
  function open(kind, message, value){
    ensure(); mode = kind;
    document.getElementById('btDlgMsg').textContent = message == null ? '' : String(message);
    const input = document.getElementById('btDlgInput');
    input.style.display = kind === 'prompt' ? 'block' : 'none';
    input.value = value == null ? '' : String(value);
    document.getElementById('btDlgCancel').style.display = kind === 'alert' ? 'none' : '';
    document.getElementById('btDlgOverlay').style.display = 'flex';
    setTimeout(() => (kind === 'prompt' ? input : document.getElementById('btDlgOk')).focus(), 30);
    return new Promise(r => { resolveFn = r; });
  }
  window.btDlgClose = function(ok){
    document.getElementById('btDlgOverlay').style.display = 'none';
    const r = resolveFn; resolveFn = null; if (!r) return;
    if (mode === 'prompt') r(ok ? document.getElementById('btDlgInput').value : null);
    else if (mode === 'confirm') r(!!ok);
    else r();
  };
  // Confirm → true/false; Prompt → the text, or null on Cancel (same contract as the browser's)
  window.btConfirm = message => open('confirm', message);
  window.btPrompt = (message, value) => open('prompt', message, value);
  if (typeof window.btAlert !== 'function') window.btAlert = message => open('alert', message);
})();
