const { initializeApp, getApps } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

// Player identity = Firebase Auth user (anonymous guest, Play Games or
// Google -- see the client's PlayerSession). Every request carries the
// player's Firebase ID token; verifying it only needs the project id
// (firebase-admin fetches Google's public signing keys), no service account.
function initFirebase() {
  if (getApps().length) return;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('FIREBASE_PROJECT_ID is not set');
  initializeApp({ projectId });
}

function bearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== 'string') return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// Resolves to the token's uid, or rejects if missing/invalid/expired.
async function verifyAuthorizationHeader(authorizationHeader) {
  const token = bearerToken(authorizationHeader);
  if (!token) throw new Error('missing-token');
  const decoded = await getAuth().verifyIdToken(token);
  return decoded.uid;
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

module.exports = { initFirebase, verifyAuthorizationHeader, requireAuth };
