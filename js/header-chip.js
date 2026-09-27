// Shared header account chip (all internal pages). The Market Flash header button was removed 2026-09-27 — the
// bulletin is now only a source inside Quotes → Messaging (Market tab).
// Each page's own login handler still just sets #userBadge's text to the signed-in email (that span
// is hidden now) — this derives the avatar initials and the chip's hover tooltip from that same
// text, so no page's auth code had to change.
(function(){
  var css = document.createElement('style');
  css.textContent =
    '.hdr-logout{width:19px;height:19px;border-radius:50%;background:rgba(255,255,255,.1);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;transition:background .18s;}' +
    '.hdr-logout:hover{background:rgba(255,255,255,.22);}' +
    '.nav-row{padding-left:76px;padding-right:76px;box-sizing:border-box;}';
  document.head.appendChild(css);

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
