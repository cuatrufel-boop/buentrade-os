// Shared header account chip + Market Flash button behavior (all internal pages).
// Each page's own login handler still just sets #userBadge's text to the signed-in email (that span
// is hidden now) — this derives the avatar initials and the chip's hover tooltip from that same
// text, so no page's auth code had to change.
(function(){
  var css = document.createElement('style');
  css.textContent =
    // Same wordmark language as the BuenTrade logo (.brand-word): Space Grotesk 700, white + bright-blue two-tone — no button box.
    '.hdr-flash{display:inline-flex;align-items:center;gap:8px;background:none;border:none;padding:4px 2px;text-decoration:none;cursor:pointer;color:#fff;}' +
    '.hdr-flash svg{width:19px;height:19px;flex-shrink:0;transition:transform .18s;}' +
    '.hdr-flash-word{font-family:"Space Grotesk",sans-serif;font-weight:700;font-size:22px;color:#fff;line-height:1;letter-spacing:0;transition:opacity .18s;}' +
    '.hdr-flash-word b{font-weight:700;color:#5AAAFF;}' +
    '.hdr-flash:hover .hdr-flash-word{opacity:.82;}' +
    '.hdr-flash:hover svg{transform:scale(1.12);}' +
    '.hdr-flash-dot{position:absolute;top:-5px;right:-5px;width:11px;height:11px;border-radius:50%;background:#E5533D;border:2px solid #0E3D8F;box-sizing:border-box;}' +
    '.hdr-logout{width:19px;height:19px;border-radius:50%;background:rgba(255,255,255,.1);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background .18s;}' +
    '.hdr-logout:hover{background:rgba(255,255,255,.22);}' +
    '.nav-row{padding-left:76px;padding-right:76px;box-sizing:border-box;}';
  document.head.appendChild(css);

  // Market Flash: a red dot on the button means a bulletin has arrived that THIS browser hasn't opened yet (by upload or by
  // email — the server reads it on its own). Opening Market Flash marks the latest one as seen (mfMarkBulletinSeen).
  (function styleFlashWordmark(){
    var fb = document.querySelector('.hdr-flash');
    if (!fb || fb.querySelector('.hdr-flash-word')) return;
    var svg = fb.querySelector('svg');
    fb.textContent = '';
    if (svg) fb.appendChild(svg);
    var w = document.createElement('span');
    w.className = 'hdr-flash-word';
    w.innerHTML = 'Market <b>Flash</b>';
    fb.appendChild(w);
  })();
  var SEEN_KEY = 'mfSeenBulletin';
  function flashDot(on){
    var btn = document.querySelector('.hdr-flash');
    if (!btn) return;
    var dot = btn.querySelector('.hdr-flash-dot');
    if (on && !dot){ dot = document.createElement('span'); dot.className = 'hdr-flash-dot'; btn.appendChild(dot); }
    if (!on && dot) dot.remove();
  }
  window.mfMarkBulletinSeen = function(id){
    try { localStorage.setItem(SEEN_KEY, id); } catch (e) {}
    flashDot(false);
  };
  fetch('https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/price-history-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe', 'apikey': 'sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe' },
    body: JSON.stringify({ market_flash_status: true }),
  }).then(function(r){ return r.json(); }).then(function(st){
    if (!st || !st.bulletin) return;
    var seen = null;
    try { seen = localStorage.getItem(SEEN_KEY); } catch (e) {}
    flashDot(seen !== st.bulletin.id);
  }).catch(function(){ /* the dot is a nicety — never disturbs a page */ });

  var badge = document.getElementById('userBadge');
  var avatar = document.getElementById('userAvatar');
  var chip = document.getElementById('userChip');
  if (!badge || !avatar) return;
  function sync(){
    var t = (badge.textContent || '').trim();
    var parts = t.split('@');
    avatar.textContent = !t ? '' : (parts.length === 2 && parts[0] && parts[1]) ? (parts[0][0] + parts[1][0]).toUpperCase() : t.slice(0, 2).toUpperCase();
    if (chip) chip.title = t;
  }
  new MutationObserver(sync).observe(badge, { childList: true, characterData: true, subtree: true });
  sync();
})();
