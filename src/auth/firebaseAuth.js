const fs = require('fs');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

// Player identity = Firebase Auth user (anonymous guest, Play Games or
// Google -- see the client's PlayerSession). Every request carries the
// player's Firebase ID token; verifying it only needs the project id
// (firebase-admin fetches Google's public signing keys). Admin actions
// (deleting a player's Firebase user) need a service account key: a JSON
// file kept OUTSIDE the repo, pointed to by FIREBASE_SERVICE_ACCOUNT_FILE.
function initFirebase() {
  if (getApps().length) return;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not set');

  const keyFile = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
  if (!keyFile) {
    console.warn('[auth] FIREBASE_SERVICE_ACCOUNT_FILE not set: token verification only, admin actions unavailable');
    initializeApp({ projectId });
    return;
  }
  const serviceAccount = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  if (serviceAccount.project_id !== projectId) {
    throw new Error(`service account is for project '${serviceAccount.project_id}', expected '${projectId}'`);
  }
  initializeApp({ projectId, credential: cert(serviceAccount) });
  console.log(`[auth] admin credentials loaded (${serviceAccount.client_email})`);
}

// True when a service account key was loaded (admin actions available).
function hasAdminCredentials() {
  return !!process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
}

// Deletes the Firebase Auth user (all linked sign-ins go with it). Already
// gone counts as success, so retries are safe. Needs admin credentials.
async function deleteFirebaseUser(uid) {
  try {
    await getAuth().deleteUser(uid);
  } catch (err) {
    if (err.code !== 'auth/user-not-found') throw err;
  }
}

function bearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Resolve to the token's uid, or reject if missing/invalid/expired.
async function verifyIdToken(token) {
  if (typeof token !== 'string' || !token) throw new Error('missing-token');
  const decoded = await getAuth().verifyIdToken(token);
  return decoded.uid;
}

function verifyAuthorizationHeader(authorizationHeader) {
  return verifyIdToken(bearerToken(authorizationHeader));
}

// Express middleware: 401 unless a valid token is present; sets req.uid.
function requireAuth(req, res, next) {
  verifyAuthorizationHeader(req.headers.authorization)
    .then((uid) => {
      req.uid = uid;
      next();
    })
    .catch(() => res.status(401).json({ error: 'unauthorized' }));
}

module.exports = { initFirebase, hasAdminCredentials, deleteFirebaseUser, verifyIdToken, verifyAuthorizationHeader, requireAuth };
