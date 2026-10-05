// Verifies the service account key (FIREBASE_SERVICE_ACCOUNT_FILE) has the
// admin rights the server needs: creates an anonymous test user, then reads
// and deletes it through firebase-admin. Leaves nothing behind.
//   node scratch/checkAdmin.js
require('dotenv').config({ quiet: true });
const { getAuth } = require('firebase-admin/auth');
const { initFirebase, hasAdminCredentials } = require('../src/auth/firebaseAuth');
const { createTestUser, deleteTestUser } = require('./testUsers');

(async () => {
  initFirebase();
  if (!hasAdminCredentials()) throw new Error('FIREBASE_SERVICE_ACCOUNT_FILE is not set in .env');

  const user = await createTestUser();
  let deleted = false;
  try {
    const record = await getAuth().getUser(user.uid);
    console.log(`PASS  admin can read users (${record.uid}, anonymous=${record.providerData.length === 0})`);
    await getAuth().deleteUser(user.uid);
    deleted = true;
    console.log('PASS  admin can delete users');
    await getAuth().getUser(user.uid).then(
      () => { throw new Error('user still exists after deleteUser'); },
      (err) => { if (err.code !== 'auth/user-not-found') throw err; });
    console.log('PASS  deleted user is gone');
    console.log('\nSERVICE ACCOUNT OK');
  } finally {
    if (!deleted) await deleteTestUser(user).catch(() => {});
  }
})().catch((err) => {
  console.error('FAIL ', err.message);
  process.exit(1);
});
