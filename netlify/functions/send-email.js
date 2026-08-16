// Sends an email through Resend using the BuenTrade alias that matches who it's going to
// (plant/customer/carrier), so the trader never has to pick a "From" address by hand in Gmail.
// RESEND_API_KEY lives only in Netlify's environment variables — never in this repo.

const FROM_ADDRESSES = {
  purchasing: 'Purchasing BuenTrade <purchasing@buentradegroup.com>',
  offers: 'Offers BuenTrade <offers@buentradegroup.com>',
  logistics: 'Logistics BuenTrade <logistics@buentradegroup.com>',
  info: 'BuenTrade <info@buentradegroup.com>',
};

// Mirrors the signature set up by hand in Gmail — the API path never touches Gmail, so it has
// to carry its own copy of the same signature to look consistent with manually-sent mail.
const SIGNATURE_HTML = `
  <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;color:#555555;line-height:1.5;">
    <div style="font-size:19px;margin:0 0 2px;">
      <span style="color:#0A2547;font-weight:bold;">Buen</span><span style="color:#1E6ADB;font-weight:bold;">Trade</span>
    </div>
    <div style="font-size:10.5px;color:#999999;letter-spacing:0.6px;margin:0 0 10px;">GOOD TRADE. GOOD BUSINESS.</div>
    <div>BuenTrade LLC</div>
    <div>1525 N Park Dr, Suite 104, Weston, FL 33326</div>
    <div>+1 954-208-0209 &nbsp;&middot;&nbsp; <a href="https://buentradegroup.com" style="color:#1E6ADB;text-decoration:none;">buentradegroup.com</a></div>
  </div>`;

const SIGNATURE_TEXT = '\n\n--\nBuenTrade — GOOD TRADE. GOOD BUSINESS.\nBuenTrade LLC\n1525 N Park Dr, Suite 104, Weston, FL 33326\n+1 954-208-0209 · buentradegroup.com';

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { to, cc, subject, text, from, html } = payload;
  const fromAddress = FROM_ADDRESSES[from];
  if (!fromAddress) {
    return { statusCode: 400, body: JSON.stringify({ error: 'from must be one of: ' + Object.keys(FROM_ADDRESSES).join(', ') }) };
  }
  if (!to || !subject || !text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'to, subject, and text are required' }) };
  }

  // Callers that need real inline content (e.g. a product photo, not just a link to it) send
  // their own pre-built `html` — trusted since it's assembled server-side-equivalent by our own
  // pages, not user input. Falls back to escaping `text` for callers that only have plain text.
  const bodyHtml = html
    ? `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;">${html}</div><br>${SIGNATURE_HTML}`
    : `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;white-space:pre-wrap;">${escapeHtml(text)}</div><br>${SIGNATURE_HTML}`;

  // Sending through Resend (not Gmail's own SMTP) means none of this ever shows up in Gmail's
  // Sent folder, no matter which alias it went from — the trader has no record at all of what
  // actually went out unless we put one somewhere he does see. BCC'ing the one inbox he actually
  // watches on every send is the fix, regardless of which alias sent it.
  const VISIBILITY_BCC = 'info@buentradegroup.com';
  const bccList = Array.from(new Set([VISIBILITY_BCC].filter(addr => addr !== fromAddress.match(/<(.+)>/)?.[1])));

  const resendRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddress,
      to: Array.isArray(to) ? to : [to],
      cc: cc && cc.length ? cc : undefined,
      bcc: bccList.length ? bccList : undefined,
      subject,
      text: text + SIGNATURE_TEXT,
      html: bodyHtml,
    }),
  });

  const data = await resendRes.json().catch(() => ({}));
  if (!resendRes.ok) {
    return { statusCode: 502, body: JSON.stringify({ error: data.message || 'Resend request failed' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, id: data.id }) };
};
