// Real ask 2026-09-15: sending a product offer over WhatsApp used to mean downloading the photo
// to the trader's device and manually dragging it into the chat — real, working, just manual. Now
// the trader sends a short link (buentradegroup.com/p/x7k9m2) instead, and THIS function renders
// the small branded card WhatsApp's link-preview crawler reads (Open Graph tags: real product
// photo, product name, price) — same idea as the invoice-signature card in sign-invoice.html, but
// built here (not as a Supabase Edge Function) because Supabase's own Edge Function gateway
// silently overrides any Content-Type a function sets to text/plain (confirmed live 2026-09-15 —
// see the header comment on supabase/functions/sent-offers-create/index.ts), which would make a
// browser/WhatsApp's crawler render raw markup as literal text instead of a page. Netlify
// Functions don't have that restriction, so the actual data lookup stays in sent-offers-create
// (one GET action, JSON only) and this function just fetches that JSON and renders real HTML.
//
// Real ask 2026-09-15, twice: "que tal tarjeta sea nitida pequeña facil de ver" — a trader may
// send several product cards back to back in one WhatsApp conversation, so this stays a compact
// "summary" card (small square photo + title), not a full-width "summary_large_image" one.
//
// Real bug found live 2026-09-18, confirmed against the actual deployed site (not just local code):
// the "redirect straight to the destination, no step 2" behavior below never actually fired for a
// real visitor — the JS `window.location.replace()` in <head> is a client-side redirect that
// depends on the requesting browser/webview actually executing it on initial parse, and it simply
// didn't, on the live URL, in more than one real browser tested. The person stayed on the summary
// card and had to tap "Ver Ficha Técnica" by hand — exactly the two-step flow the 2026-09-16 ask
// was supposed to remove. Replaced with a real server-side HTTP redirect for an actual human
// visitor, which needs no JS at all and can't be "not executed" the way a script can: this
// function now reads the request's User-Agent, and issues a genuine 302 straight to the spec/photo
// for anyone who isn't WhatsApp's own link-preview crawler. The crawler (identified by "WhatsApp"
// in its User-Agent, the standard way every site does this) still gets this same HTML page with
// its Open Graph tags, since a 302 response has no meta tags for it to read for the chat preview.

const SUPABASE_FN_URL = 'https://geqhjykbxvxugvnpnygn.supabase.co/functions/v1/sent-offers-create';
const SUPABASE_ANON_KEY = 'sb_publishable_p7na-oT05z2cPHXdzgzD6Q_Y29Hv3pe';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(message, statusCode) {
  return {
    statusCode,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>BuenTrade</title></head><body style="font-family:sans-serif;text-align:center;padding:60px 20px;color:#0A2547;">${escapeHtml(message)}</body></html>`,
  };
}

// Same BuenTrade brand tokens style.css already defines (--navy/--blue-main/--blue-bright) and the
// same Baloo 2 font the rest of the site uses — see icons/invoice-confirm-card.png's own header
// comment for the same design-consistency reasoning.
//
// Real correction 2026-09-15: "de donde saca esa foto... debe ser una foto de nuestro sistema" —
// never fake/fill in a photo that isn't real. When offer.photo_url is genuinely empty, the card
// never shows a fabricated image (no og:image tag either — WhatsApp's card just has no picture).
//
// Real correction 2026-09-16: "que no salgan errores que salgan todas iguales con precio marca
// todo en el mismo lugar no quiero ver 4 marcas con cosas diferentes" — this used to conditionally
// drop whole rows/sections when a field was missing (no price row at all, no plant line, image
// area collapsed), so two real cards could end up structurally different heights/layouts side by
// side, reading as broken/inconsistent. Every card now renders the exact same fixed structure —
// photo slot (real photo, or a plain BuenTrade placeholder block, never fabricated content),
// title, Precio row, Marca row, Ficha Técnica row — every row always present, every row showing
// "—" when that specific field has no real value on file, instead of the row disappearing.
// Real ask 2026-09-16: "no necesito paso 2 solo 1 y 3" — the intermediate BuenTrade summary card
// (photo/price/plant) was one extra tap the user doesn't want. A real human visitor never actually
// sees this page's body at all now — the handler below sends them straight there with a real HTTP
// 302 before this function even runs. This function only ever renders for WhatsApp's own
// link-preview crawler (building the small chat card off these Open Graph tags) or for the
// genuine last-resort case where the product has neither a spec nor a photo to jump to.
function renderCardPage(offer) {
  const productName = escapeHtml(offer.product_name_es || offer.product_name || 'Producto');
  const spec = escapeHtml(offer.product_spec_es || offer.product_spec || '');
  const plantName = (offer.plant_name || '').trim();
  const price = offer.sale_per_lb != null ? `$${Number(offer.sale_per_lb).toFixed(4)} / lb` : '—';
  const photo = offer.photo_url || null;
  const specUrl = offer.spec_url || null;
  const priceTitle = offer.sale_per_lb != null ? ` — $${Number(offer.sale_per_lb).toFixed(4)} / lb` : '';
  const cardTitle = `${productName}${priceTitle}`;

  const ogImageTags = photo ? `
<meta property="og:image" content="${escapeHtml(photo)}">
<meta name="twitter:image" content="${escapeHtml(photo)}">` : '';

  return `<!DOCTYPE html>
<html lang="es"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>${escapeHtml(cardTitle)} — BuenTrade</title>
<meta property="og:title" content="${escapeHtml(cardTitle)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${escapeHtml(cardTitle)}">${ogImageTags}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Nunito:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  :root{ --navy:#0A2547; --blue-main:#1E6ADB; --blue-bright:#5AAAFF; }
  *{ box-sizing:border-box; }
  body{ margin:0; min-height:100vh; background:linear-gradient(135deg,#0E3D8F 0%,#0A2547 100%);
    font-family:'Nunito',sans-serif; display:flex; align-items:center; justify-content:center; padding:24px; }
  .card{ background:#fff; border-radius:20px; max-width:380px; width:100%; overflow:hidden; box-shadow:0 20px 50px rgba(0,0,0,.35); }
  .photo-slot{ width:100%; aspect-ratio:4/3; background:#EAF3FC; display:flex; align-items:center; justify-content:center; }
  .photo-slot img{ width:100%; height:100%; object-fit:cover; display:block; }
  .photo-slot .placeholder{ font-family:'Baloo 2',sans-serif; font-weight:800; font-size:15px; color:#B9CFE8; letter-spacing:.04em; }
  .body{ padding:22px 22px 8px; }
  .brand{ font-family:'Baloo 2',sans-serif; font-weight:800; font-size:14px; color:var(--navy); letter-spacing:.02em; margin-bottom:10px; }
  .brand span{ color:var(--blue-main); }
  h1{ font-family:'Baloo 2',sans-serif; font-size:21px; color:var(--navy); margin:0 0 4px; line-height:1.25; }
  .spec{ font-size:13.5px; color:#5B7290; min-height:17px; }
  .rows{ padding:6px 22px 0; }
  .row{ display:flex; justify-content:space-between; align-items:baseline; padding:10px 0; border-top:1px solid #EEF2F7; }
  .row .label{ font-size:12.5px; color:#8598B3; }
  .row .val{ font-size:15px; font-weight:700; color:var(--navy); }
  .row .val.muted{ color:#B7C3D4; font-weight:600; }
  .spec-row{ padding:16px 22px 22px; }
  .spec-link{ display:block; text-align:center; padding:11px; border-radius:10px; background:#EAF3FC; color:var(--blue-main); font-weight:700; font-size:13.5px; text-decoration:none; }
  .spec-link.disabled{ background:#F4F6F9; color:#B7C3D4; pointer-events:none; }
</style>
</head><body>
  <div class="card">
    <div class="photo-slot">
      ${photo ? `<img src="${escapeHtml(photo)}" alt="${productName}">` : `<span class="placeholder">Buen<span style="color:#8FB4E0;">Trade</span></span>`}
    </div>
    <div class="body">
      <div class="brand">Buen<span>Trade</span></div>
      <h1>${productName}</h1>
      <div class="spec">${spec || '&nbsp;'}</div>
    </div>
    <div class="rows">
      <div class="row"><span class="label">Precio</span><span class="val${price === '—' ? ' muted' : ''}">${escapeHtml(price)}</span></div>
      <div class="row"><span class="label">Marca / Planta</span><span class="val${plantName ? '' : ' muted'}">${plantName ? escapeHtml(plantName) : '—'}</span></div>
    </div>
    <div class="spec-row">
      ${specUrl
        ? `<a class="spec-link" href="${escapeHtml(specUrl)}" target="_blank" rel="noopener">📋 Ver Ficha Técnica</a>`
        : `<span class="spec-link disabled">📋 Ficha técnica no disponible</span>`}
    </div>
  </div>
</body></html>`;
}

// Real bug found live 2026-09-16, confirmed on the actual deployed site: netlify.toml's
// /p/* -> /.netlify/functions/product-card?code=:splat rewrite does NOT actually deliver a
// resolved `code` query param to this function — event.queryStringParameters came back empty on
// a real request to /p/sgw3epst. What the redirect DOES preserve is the original request path
// (event.path, still "/p/sgw3epst"), same underlying issue as sign-invoice.html's matching fix —
// so the short code is read from the path first, the query param kept only as a fallback for any
// link shared with the old ?code= form.
exports.handler = async (event) => {
  const pathMatch = (event.path || '').match(/\/p\/([^/?#]+)/);
  const code = (event.queryStringParameters || {}).code || (pathMatch ? pathMatch[1] : null);
  if (!code) return errorPage('Link inválido.', 400);

  let data;
  try {
    const res = await fetch(`${SUPABASE_FN_URL}?code=${encodeURIComponent(code)}`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    data = await res.json();
    if (!res.ok || !data.offer) return errorPage('Este link ya no es válido. Contacta a tu representante de BuenTrade.', 404);
  } catch (e) {
    return errorPage('No se pudo cargar esta oferta. Contacta a tu representante de BuenTrade.', 502);
  }

  // Real bug found live 2026-09-18 — see this function's header comment for the full story: a
  // client-side JS redirect can't be trusted to actually run, a real HTTP redirect can't fail to.
  // WhatsApp's crawler must still receive this HTML page (its Open Graph tags are what builds the
  // chat preview — a crawler never follows a 302 to build that preview off the destination file
  // instead), so it's the only visitor that gets this page's body rather than the redirect.
  const userAgent = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || '';
  const isWhatsAppCrawler = /whatsapp/i.test(userAgent);
  const redirectTarget = data.offer.spec_url || data.offer.photo_url || null;

  if (redirectTarget && !isWhatsAppCrawler) {
    return {
      statusCode: 302,
      headers: { Location: redirectTarget },
      body: '',
    };
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: renderCardPage(data.offer),
  };
};
