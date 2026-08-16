// Runs automatically right after a new teammate creates their account (see doSignUp in
// trading-tool.html) — sets the "authenticated" custom claim that Supabase's Firebase
// integration requires, so a brand-new account works immediately without anyone having to run
// scripts/set-supabase-claim.js by hand ever again.
//
// FIREBASE_SERVICE_ACCOUNT_JSON (the full service account JSON as one string) must be set as a
// Netlify environment variable — never committed to this repo.

const admin = require('firebase-admin');

let appInstance;
function getAdminApp(){
  if (!appInstance){
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    appInstance = admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  return appInstance;
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

  const { uid } = payload;
  if (!uid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'uid is required' }) };
  }

  try {
    getAdminApp();
    const user = await admin.auth().getUser(uid);
    const existingClaims = user.customClaims || {};
    await admin.auth().setCustomUserClaims(uid, { ...existingClaims, role: 'authenticated' });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
