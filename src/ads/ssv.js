const crypto = require('crypto');

// AdMob rewarded-ad server-side verification (SSV). AdMob calls our
// callback URL with the reward details, signed with one of Google's ECDSA
// keys: the signed message is the query string up to "&signature=", and
// signature + key_id are always the last two parameters.
// https://developers.google.com/admob/android/ssv
const KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';
const KEYS_TTL_MS = 24 * 60 * 60 * 1000;

let cached = { keys: null, at: 0 };

async function fetchKeys(force = false) {
  if (!force && cached.keys && Date.now() - cached.at < KEYS_TTL_MS) return cached.keys;
  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new Error(`verifier keys: HTTP ${res.status}`);
  const json = await res.json();
  const keys = new Map(json.keys.map((k) => [String(k.keyId), crypto.createPublicKey(k.pem)]));
  cached = { keys, at: Date.now() };
  return keys;
}

// rawQuery: the undecoded query string (everything after '?'). Resolves
// true only for a genuine AdMob signature. getKeys is injectable for tests.
async function verifySsv(rawQuery, getKeys = fetchKeys) {
  const sigIndex = rawQuery.indexOf('&signature=');
  if (sigIndex <= 0) return false;
  const message = rawQuery.slice(0, sigIndex);
  const tail = new URLSearchParams(rawQuery.slice(sigIndex + 1));
  const signature = tail.get('signature');
  const keyId = tail.get('key_id');
  if (!signature || !keyId) return false;

  let keys = await getKeys();
  if (!keys.has(keyId)) keys = await getKeys(true); // Google rotated its keys
  const key = keys.get(keyId);
  if (!key) return false;

  return crypto.verify('sha256', Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64url'));
}

module.exports = { verifySsv };
