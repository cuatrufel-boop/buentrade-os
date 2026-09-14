// Shared "review before sending" email modal + send call — one real implementation instead of
// four separate copies (offers.html, orders.html, trading-tool.html, plants.html) that had
// already drifted apart in real, confirmed ways: plants.html had no CC/attachments/WhatsApp at
// all, trading-tool.html had no EMAIL_SIGNATURE constant and silently ignored edits to the To
// field, and three of the four had a wrong phone number in their local signature copy. This is
// the fix for that whole class of bug, not just the phone number.
//
// quotes.html is deliberately NOT part of this unification — it has a genuinely different,
// working batch/multi-recipient modal (rqOpenEmailModal, one card per recipient, per-item
// onSent callbacks, an isOffer-gated real-API-vs-Gmail-link split) built for a different job
// (asking many plants for a price at once). Folding a real, working, differently-shaped system
// into this one would be a rewrite risking regression to a system that isn't broken, not a fix.
//
// Deliberately keeps every calling file's own sendEmailApi(...) function signature and every one
// of its ~50 real call sites completely unchanged — only the modal markup, the open/cancel/confirm
// logic, and the actual fetch to the backend move here. Each file's sendEmailApi becomes a thin
// wrapper wiring its own existing positional args into bcSendEmailApi's one shared implementation.

const BC_EMAIL_SIGNATURE = '\n\n--\nBuenTrade — GOOD TRADE. GOOD BUSINESS.\nBuenTrade LLC\n1525 N Park Dr, Suite 104, Weston, FL 33326\n+1 754-248-1016 · buentradegroup.com';

let bcEmailModalResolve = null;
let bcEmailModalWaInfo = null;

// Injected once, on first use — the exact same modal every calling page used to hand-copy, using
// the same CSS classes (.email-modal-overlay/.email-modal-box/.email-modal-field/...) every one
// of those pages already defines in its own <style> block, so nothing there needs to change.
function bcEnsureEmailModal(){
  if (document.getElementById('emailModalOverlay')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
<div id="emailModalOverlay" class="email-modal-overlay" style="display:none;">
  <div class="email-modal-box">
    <h3 id="emailModalTitle">Review before sending</h3>
    <div class="email-modal-from" id="emailModalFrom"></div>
    <div class="email-modal-field"><label>To</label><input type="text" id="emailModalTo" autocomplete="off" name="bt-email-to"></div>
    <div class="email-modal-field"><label>CC (optional — add more recipients, comma-separated)</label><input type="text" id="emailModalCc" placeholder="name@example.com, name2@example.com" autocomplete="off" name="bt-email-cc"></div>
    <div class="email-modal-field"><label>Subject</label><input type="text" id="emailModalSubject" autocomplete="off" name="bt-email-subject"></div>
    <div class="email-modal-field"><label>Message</label><textarea id="emailModalBody" autocomplete="off"></textarea></div>
    <div class="email-modal-field" id="emailModalAttachWrap" style="display:none;">
      <label>Attachments</label>
      <div class="email-modal-attachments" id="emailModalAttachments"></div>
    </div>
    <div class="email-modal-field" id="emailModalWaWrap" style="display:none;">
      <label>WhatsApp — <span id="emailModalWaPhone"></span></label>
      <textarea id="emailModalWaBody" autocomplete="off"></textarea>
    </div>
    <div class="email-modal-actions">
      <button id="emailModalWaBtn" onclick="emailModalSendWhatsApp()" style="display:none;background:var(--card);color:#3DDC97;border:1.5px solid #1DA851;border-radius:8px;padding:9px 16px;font-weight:600;font-size:13px;cursor:pointer;margin-right:auto;">💬 También por WhatsApp</button>
      <button onclick="emailModalCancel()" style="background:var(--card);color:var(--blue-bright);border:1.5px solid var(--blue);border-radius:8px;padding:9px 16px;font-weight:600;font-size:13px;cursor:pointer;">Cancel</button>
      <button onclick="emailModalConfirm()" style="background:var(--blue);color:#fff;border:none;border-radius:8px;padding:9px 16px;font-weight:600;font-size:13px;cursor:pointer;">Send</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(wrap.firstElementChild);
}

// opts: { to, cc, subject, text, attachments, fromDisplay, waInfo, title }
// to/cc may be an array or a comma-joined string either way — always normalized to a display
// string for the input, and always re-split back into an array by the caller on confirm.
// Resolves { to, cc, subject, text } (edited) on Send, or null on Cancel.
function bcOpenEmailModal(opts){
  opts = opts || {};
  bcEnsureEmailModal();
  const joinList = (v) => Array.isArray(v) ? v.join(', ') : (v || '');

  document.getElementById('emailModalTitle').textContent = opts.title || 'Review before sending';
  const fromEl = document.getElementById('emailModalFrom');
  fromEl.textContent = opts.fromDisplay ? `From: ${opts.fromDisplay}` : '';
  fromEl.style.display = opts.fromDisplay ? '' : 'none';
  document.getElementById('emailModalTo').value = joinList(opts.to);
  document.getElementById('emailModalCc').value = joinList(opts.cc);
  document.getElementById('emailModalSubject').value = opts.subject || '';
  document.getElementById('emailModalBody').value = opts.text || '';

  const attachments = opts.attachments || [];
  const attachWrap = document.getElementById('emailModalAttachWrap');
  attachWrap.style.display = attachments.length ? '' : 'none';
  document.getElementById('emailModalAttachments').innerHTML = attachments
    .map(a => `<span class="email-modal-attachment-chip">📎 ${(a.filename || '').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</span>`)
    .join('');

  bcEmailModalWaInfo = (opts.waInfo && opts.waInfo.phone) ? opts.waInfo : null;
  const waWrap = document.getElementById('emailModalWaWrap');
  const waBtn = document.getElementById('emailModalWaBtn');
  waWrap.style.display = bcEmailModalWaInfo ? '' : 'none';
  waBtn.style.display = bcEmailModalWaInfo ? '' : 'none';
  if (bcEmailModalWaInfo){
    document.getElementById('emailModalWaPhone').textContent = bcEmailModalWaInfo.phone;
    document.getElementById('emailModalWaBody').value = bcEmailModalWaInfo.message || '';
  }

  document.getElementById('emailModalOverlay').style.display = 'flex';
  return new Promise(resolve => { bcEmailModalResolve = resolve; });
}

function emailModalCancel(){
  document.getElementById('emailModalOverlay').style.display = 'none';
  if (bcEmailModalResolve) bcEmailModalResolve(null);
  bcEmailModalResolve = null;
}

function emailModalConfirm(){
  const result = {
    to: document.getElementById('emailModalTo').value,
    cc: document.getElementById('emailModalCc').value,
    subject: document.getElementById('emailModalSubject').value,
    text: document.getElementById('emailModalBody').value,
  };
  document.getElementById('emailModalOverlay').style.display = 'none';
  if (bcEmailModalResolve) bcEmailModalResolve(result);
  bcEmailModalResolve = null;
}

function emailModalSendWhatsApp(){
  if (!bcEmailModalWaInfo) return;
  const message = document.getElementById('emailModalWaBody').value;
  const { phone, filename, content, contentType } = bcEmailModalWaInfo;
  if (content && typeof downloadBase64File === 'function') downloadBase64File(filename, content, contentType);
  bcConfirmWaSend(phone, message, content ? filename : null);
}

// Real ask 2026-09-13: "no manda atachment" — WhatsApp has no way to auto-attach a file to a
// wa.me link (a real platform limit, nothing any code can work around). A toast that fades in a
// couple seconds isn't enough — the trader clicked past it and reached an empty chat with no PDF.
// This stays on screen until they actually confirm, and only THEN opens wa.me (also keeps that
// window.open on a fresh click/user-gesture, so it isn't popup-blocked). One shared implementation
// so every page's WhatsApp button — inside this modal and any page's own share-and-open helper —
// gets the same real confirmation instead of each hand-rolling its own toast.
function bcEnsureWaAttachModal(){
  if (document.getElementById('bcWaAttachModalOverlay')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
<div id="bcWaAttachModalOverlay" class="email-modal-overlay" style="display:none;">
  <div class="email-modal-box" style="max-width:440px;text-align:center;">
    <h3>PDF descargado</h3>
    <div class="email-modal-from" id="bcWaAttachModalFilename" style="font-weight:700;"></div>
    <div class="email-modal-from">Se acaba de descargar a tu computadora. Al abrir WhatsApp, arrástralo (o adjúntalo con el clip) dentro del chat antes de enviar el mensaje — WhatsApp no permite adjuntarlo automáticamente.</div>
    <div class="email-modal-actions" style="justify-content:center;">
      <button onclick="bcWaAttachModalContinue()" style="background:#0F8A5F;color:#fff;border:none;border-radius:8px;padding:9px 18px;font-weight:700;font-size:13px;cursor:pointer;">Entendido, abrir WhatsApp</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(wrap.firstElementChild);
}
let bcWaAttachPending = null;
function bcWaAttachModalContinue(){
  document.getElementById('bcWaAttachModalOverlay').style.display = 'none';
  const pending = bcWaAttachPending;
  bcWaAttachPending = null;
  if (pending) window.open('https://wa.me/' + pending.phone.replace(/\D/g, '') + '?text=' + encodeURIComponent(pending.message), '_blank');
}
// Call right after downloading the file (or with filename=null when there's nothing to attach —
// e.g. no phone on file already stopped it earlier, or the message alone has no document).
function bcConfirmWaSend(phone, message, filename){
  if (!filename){ window.open('https://wa.me/' + phone.replace(/\D/g, '') + '?text=' + encodeURIComponent(message), '_blank'); return; }
  bcEnsureWaAttachModal();
  bcWaAttachPending = { phone, message };
  document.getElementById('bcWaAttachModalFilename').textContent = filename;
  document.getElementById('bcWaAttachModalOverlay').style.display = 'flex';
}

// opts: { fromAlias, to, subject, text, attachments, waInfo, cc, fromDisplay, title }
// The one real network call every calling file's own sendEmailApi now delegates to. Throws a
// cancelled-flagged Error if the trader hits Cancel (same contract every caller already expects),
// or a plain Error with the backend's message on a real send failure.
async function bcSendEmailApi(opts){
  opts = opts || {};
  const attachments = opts.attachments || [];
  // Same real feature orders.html's version already had: WhatsApp's own "download the file first"
  // step gets the email's first attachment automatically, contentType included, so the trader
  // never has to separately go find the PDF to drag into WhatsApp.
  const waInfoWithFile = (opts.waInfo && opts.waInfo.phone && attachments[0])
    ? { ...opts.waInfo, filename: attachments[0].filename, content: attachments[0].content, contentType: attachments[0].contentType }
    : opts.waInfo;

  const edited = await bcOpenEmailModal({
    to: opts.to, cc: opts.cc, subject: opts.subject, text: opts.text,
    attachments, fromDisplay: opts.fromDisplay, waInfo: waInfoWithFile, title: opts.title,
  });
  if (!edited){
    const cancelErr = new Error('Cancelled by user');
    cancelErr.cancelled = true;
    throw cancelErr;
  }

  const finalTo = edited.to.split(',').map(s => s.trim()).filter(Boolean);
  const finalCc = edited.cc.split(',').map(s => s.trim()).filter(Boolean);

  const res = await fetch('/.netlify/functions/send-email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: opts.fromAlias, to: finalTo, cc: finalCc.length ? finalCc : undefined,
      subject: edited.subject, text: edited.text, attachments,
    }),
  });
  if (!res.ok){
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Send failed');
  }
  return res.json();
}
