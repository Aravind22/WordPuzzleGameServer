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
  liveUids.delete(uid);
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

// uid -> time it was last confirmed to still exist in Firebase Auth.
const liveUids = new Map();
const LIVE_UID_TTL_MS = 5 * 60 * 1000;

// Resolve to the token's uid, or reject if missing/invalid/expired. A token
// stays valid for up to an hour after its user is deleted (e.g. via the web
// deletion page), so with admin credentials we also check the user still
// exists -- otherwise the deleted player's record would be recreated. The
// check is cached per uid for a few minutes to keep requests fast.
async function verifyIdToken(token) {
  if (typeof token !== 'string' || !token) throw new Error('missing-token');
  const decoded = await getAuth().verifyIdToken(token);
  const uid = decoded.uid;
  if (!hasAdminCredentials()) return uid;

  const checkedAt = liveUids.get(uid);
  if (checkedAt && Date.now() - checkedAt < LIVE_UID_TTL_MS) return uid;
  await getAuth().verifyIdToken(token, true); // rejects deleted/disabled/revoked users
  liveUids.set(uid, Date.now());
  return uid;
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
