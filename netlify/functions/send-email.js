// Sends an email through Resend using the BuenTrade alias that matches who it's going to
// (plant/customer/carrier), so the trader never has to pick a "From" address by hand in Gmail.
// RESEND_API_KEY lives only in Netlify's environment variables — never in this repo.

const FROM_ADDRESSES = {
  purchasing: 'Purchasing BuenTrade <purchasing@buentradegroup.com>',
  offers: 'Offers BuenTrade <offers@buentradegroup.com>',
  logistics: 'Logistics BuenTrade <logistics@buentradegroup.com>',
  info: 'BuenTrade <info@buentradegroup.com>',
};

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

  const { to, cc, subject, text, from } = payload;
  const fromAddress = FROM_ADDRESSES[from];
  if (!fromAddress) {
    return { statusCode: 400, body: JSON.stringify({ error: 'from must be one of: ' + Object.keys(FROM_ADDRESSES).join(', ') }) };
  }
  if (!to || !subject || !text) {
    return { statusCode: 400, body: JSON.stringify({ error: 'to, subject, and text are required' }) };
  }

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
      subject,
      text,
    }),
  });

  const data = await resendRes.json().catch(() => ({}));
  if (!resendRes.ok) {
    return { statusCode: 502, body: JSON.stringify({ error: data.message || 'Resend request failed' }) };
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, id: data.id }) };
};
