const { GoogleAuth } = require('google-auth-library');

// Google Play Developer API (androidpublisher v3), as the server's service
// account -- the same key firebase-admin uses (FIREBASE_SERVICE_ACCOUNT_FILE),
// invited in Play Console with "view financial data" + "manage orders".
//
// IAP_ALLOW_FAKE=true (local/editor testing ONLY, never in production)
// accepts purchase tokens starting with "fake:" without calling Google:
// Unity's editor fake store has no real Play purchases.
const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const FAKE_SUB_MS = 30 * 24 * 60 * 60 * 1000;

function packageName() {
  return process.env.IAP_PACKAGE_NAME || 'com.runiclabs.wordsearch';
}

function fakeAllowed(token) {
  return process.env.IAP_ALLOW_FAKE === 'true' && typeof token === 'string' && token.startsWith('fake:');
}

let clientPromise = null;
function client() {
  if (!clientPromise) {
    const keyFile = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
    if (!keyFile) throw new Error('FIREBASE_SERVICE_ACCOUNT_FILE is not set (needed for Play purchase checks)');
    clientPromise = new GoogleAuth({ keyFile, scopes: [SCOPE] }).getClient();
  }
  return clientPromise;
}

async function call(method, path) {
  const c = await client();
  try {
    const res = await c.request({ url: `${API}/${packageName()}/${path}`, method });
    return res.data;
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 410) return null; // unknown / expired token
    if (status === 400) {
      const reason = err.response?.data?.error?.message || err.message;
      const e = new Error(`play api 400: ${reason}`);
      e.invalidToken = true;
      throw e;
    }
    throw err;
  }
}

const enc = encodeURIComponent;

// One-time product purchase, normalized:
//   { state: 'purchased' | 'pending' | 'canceled', orderId, accountId, acknowledged, consumed }
// or null when Google doesn't know the token.
async function getProductPurchase(productId, token, { fakeAccountId } = {}) {
  if (fakeAllowed(token)) {
    return { state: 'purchased', orderId: `FAKE.${token.slice(5, 40)}`, accountId: fakeAccountId, acknowledged: false, consumed: false };
  }
  const p = await call('GET', `purchases/products/${enc(productId)}/tokens/${enc(token)}`);
  if (!p) return null;
  const state = { 0: 'purchased', 1: 'canceled', 2: 'pending' }[p.purchaseState ?? 0] || 'canceled';
  return {
    state,
    orderId: p.orderId || null,
    accountId: p.obfuscatedExternalAccountId || null,
    acknowledged: p.acknowledgementState === 1,
    consumed: p.consumptionState === 1,
  };
}

// Subscription purchase (subscriptionsv2), normalized:
//   { productId, active, expiresAt, autoRenewing, state, orderId, accountId, acknowledged }
async function getSubscription(token, { fakeAccountId, fakeProductId } = {}) {
  if (fakeAllowed(token)) {
    return {
      productId: fakeProductId, active: true, expiresAt: Date.now() + FAKE_SUB_MS, autoRenewing: true,
      state: 'SUBSCRIPTION_STATE_ACTIVE', orderId: `FAKE.${token.slice(5, 40)}`, accountId: fakeAccountId, acknowledged: false,
    };
  }
  const s = await call('GET', `purchases/subscriptionsv2/tokens/${enc(token)}`);
  if (!s) return null;
  const item = (s.lineItems || [])[0] || {};
  const expiresAt = item.expiryTime ? Date.parse(item.expiryTime) : 0;
  // Canceled = won't renew, but still paid up until expiry.
  const entitled = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'];
  return {
    productId: item.productId || null,
    active: entitled.includes(s.subscriptionState) && expiresAt > Date.now(),
    expiresAt,
    autoRenewing: !!item.autoRenewingPlan?.autoRenewEnabled,
    state: s.subscriptionState,
    orderId: s.latestOrderId || item.latestSuccessfulOrderId || null,
    accountId: s.externalAccountIdentifiers?.obfuscatedExternalAccountId || null,
    acknowledged: s.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  };
}

// Acknowledging tells Google the item was delivered (else it refunds after
// 3 days). The client's ConfirmPurchase normally does it; the server only
// acknowledges purchases it credited while the app was closed (RTDN).
async function acknowledgeProduct(productId, token) {
  if (fakeAllowed(token)) return;
  await call('POST', `purchases/products/${enc(productId)}/tokens/${enc(token)}:acknowledge`);
}

async function acknowledgeSubscription(productId, token) {
  if (fakeAllowed(token)) return;
  await call('POST', `purchases/subscriptions/${enc(productId)}/tokens/${enc(token)}:acknowledge`);
}

module.exports = { getProductPurchase, getSubscription, acknowledgeProduct, acknowledgeSubscription, packageName, fakeAllowed };
