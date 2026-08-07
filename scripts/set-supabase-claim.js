// One-off/repeatable admin script: assigns the "authenticated" custom claim
// that Supabase's Third-Party Auth (Firebase) integration requires on every
// Firebase user's ID token, so Supabase RLS policies can recognize them.
//
// Run this once now, and again any time a new teammate account is created.
//
// Usage:
//   cd scripts
//   npm install
//   node set-supabase-claim.js

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');

const secretsDir = path.join(__dirname, 'secrets');
const keyFile = fs.readdirSync(secretsDir).find(f => f.endsWith('.json'));

if (!keyFile) {
  console.error('No .json service account key found in scripts/secrets/. Aborting.');
  process.exit(1);
}

const serviceAccount = require(path.join(secretsDir, keyFile));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

async function run() {
  const listUsersResult = await admin.auth().listUsers(1000);
  console.log(`Found ${listUsersResult.users.length} user(s).`);

  for (const user of listUsersResult.users) {
    const existingClaims = user.customClaims || {};
    if (existingClaims.role === 'authenticated') {
      console.log(`Skipping ${user.email} — already has the claim.`);
      continue;
    }
    await admin.auth().setCustomUserClaims(user.uid, {
      ...existingClaims,
      role: 'authenticated',
    });
    console.log(`Updated ${user.email} — role: authenticated`);
  }

  console.log('Done. Each user must sign out and sign back in for the new claim to take effect.');
}

run().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
