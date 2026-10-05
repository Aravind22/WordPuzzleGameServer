// Real Firebase test identities for the scratch verification scripts:
// creates anonymous users through Firebase Auth's public REST API (the same
// sign-in path the game uses, so tokens are genuine and verified by the
// server exactly like a device's) and deletes them again afterwards so no
// test accounts pile up in the Firebase project.
require('dotenv').config();

const API_KEY = process.env.FIREBASE_API_KEY;
const IDENTITY = 'https://identitytoolkit.googleapis.com/v1';
// Identifies these calls as the Android app, in case the API key is
// restricted to it in Cloud Console (harmless when it isn't).
const APP_HEADERS = {
  'Content-Type': 'application/json',
  'X-Android-Package': 'com.runiclabs.wordsearch',
  'X-Android-Cert': '170EA2B888011FA7E59D9ECA8583091962CF75C4',
};

async function identityCall(method, body) {
  if (!API_KEY) throw new Error('FIREBASE_API_KEY is not set in .env');
  const res = await fetch(`${IDENTITY}/accounts:${method}?key=${API_KEY}`, {
    method: 'POST',
    headers: APP_HEADERS,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`accounts:${method} failed: ${JSON.stringify(json.error || json)}`);
  return json;
}

async function createTestUser() {
  const { localId, idToken } = await identityCall('signUp', { returnSecureToken: true });
  return { uid: localId, idToken };
}

async function deleteTestUser(user) {
  await identityCall('delete', { idToken: user.idToken });
}

// Creates `count` users, runs fn(users), and always deletes them after.
async function withTestUsers(count, fn) {
  const users = [];
  try {
    for (let i = 0; i < count; i++) users.push(await createTestUser());
    return await fn(users);
  } finally {
    for (const user of users) {
      await deleteTestUser(user).catch((err) => console.error(`cleanup: could not delete ${user.uid}: ${err.message}`));
    }
  }
}

module.exports = { createTestUser, deleteTestUser, withTestUsers };
