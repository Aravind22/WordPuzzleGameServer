const crypto = require('crypto');
const play = require('../iap/googlePlay');
const { PRODUCTS, PASS_DAILY } = require('./economy');
const { utcDay } = require('./utcDay');

const PURCHASES = 'iap_purchases';
const PLAYERS = 'players';

// Real-money purchases (Google Play Billing). The client buys through Unity
// IAP with obfuscatedAccountId = the player's iapId (sha256 of the uid, so
// the uid itself never goes to Google), sends the purchase token here, and
// only confirms (consumes / acknowledges) the purchase after we answer --
// so a crash anywhere just redelivers it and verify() runs again.
//
// iap_purchases: one document per purchase token (_id), the lock that makes
// every token credit at most once:
//   { _id: token, playerId, productId, kind, orderId, state, at, ... }
//   state: 'pending' (Google: payment pending) | 'credited' | 'canceled' | 'voided'
// Grants go through EconomyStore.apply (ledger reason 'iap', key = order id).
class IapStore {
  constructor(db, { economyStore, google = play }) {
    this.purchases = db.collection(PURCHASES);
    this.players = db.collection(PLAYERS);
    this.economy = economyStore;
    this.google = google;
  }

  async init() {
    await this.purchases.createIndex({ playerId: 1 });
    await this.players.createIndex({ iapId: 1 }, { sparse: true });
    await this.players.createIndex({ mergedIapIds: 1 }, { sparse: true });
  }

  static accountIdFor(playerId) {
    return crypto.createHash('sha256').update(String(playerId)).digest('hex');
  }

  // Everything /me needs about purchases:
  //   { iapAccountId, removeAds, starterAvailable, passTrialUsed, pass: { active, expiresAt, autoRenewing, claimedToday } }
  // passTrialUsed: this account has subscribed before, so Play won't offer
  // the free trial again (the Store then says SUBSCRIBE, not TRY FREE).
  async status(playerId) {
    const iapId = IapStore.accountIdFor(playerId);
    await this.players.updateOne({ _id: playerId, iapId: { $exists: false } }, { $set: { iapId } });
    const doc = await this.players.findOne({ _id: playerId }, { projection: { removeAds: 1, starterBought: 1, pass: 1 } });
    const pass = doc?.pass;
    const active = !!pass && pass.expiresAt > Date.now();
    const claimedToday = active
      ? !!(await this.economy.ledger.countDocuments({ playerId, key: `pass-daily:${utcDay()}`, status: 'done' }, { limit: 1 }))
      : false;
    const subscribed = await this.purchases.countDocuments({ playerId, kind: 'subscription' }, { limit: 1 });
    return {
      iapAccountId: iapId,
      removeAds: !!doc?.removeAds,
      starterAvailable: !doc?.starterBought,
      passTrialUsed: subscribed > 0,
      pass: { active, expiresAt: pass?.expiresAt || 0, autoRenewing: active && !!pass.autoRenewing, claimedToday },
    };
  }

  // The client's purchase: { productId, token }. Returns
  //   { credited: true, ...wallet, ...status }       granted now, or earlier (a retry)
  //   { pending: true, ...wallet, ...status }        Google still waits for the payment
  //   { error: 'unknown-product' | 'invalid-token' | 'wrong-account' | 'canceled' | 'other-player' }
  async verify(playerId, { productId, token }) {
    const product = PRODUCTS[productId];
    if (!product) return { error: 'unknown-product' };

    const record = await this.purchases.findOne({ _id: token });
    if (record && record.productId !== productId) return { error: 'invalid-token' };
    if (record && record.playerId !== playerId) return { error: 'other-player' };
    if (record?.state === 'credited' && product.kind !== 'subscription') return this._answer(playerId, { credited: true });

    const allowed = await this._accountIds(playerId);
    const fake = { fakeAccountId: allowed[0], fakeProductId: productId };
    let info;
    try {
      info = product.kind === 'subscription'
        ? await this.google.getSubscription(token, fake)
        : await this.google.getProductPurchase(productId, token, fake);
    } catch (err) {
      if (err.invalidToken) return { error: 'invalid-token' };
      throw err;
    }
    if (!info) return { error: 'invalid-token' };
    if (!info.accountId || !allowed.includes(info.accountId)) {
      console.warn(`[iap] ${productId} token for another account (player ${playerId})`);
      return { error: 'wrong-account' };
    }

    if (product.kind === 'subscription') {
      if (info.productId && info.productId !== productId) return { error: 'invalid-token' };
      await this._applySubscription(playerId, productId, token, info);
      return this._answer(playerId, { credited: info.active });
    }
    if (info.state === 'pending') {
      await this.purchases.updateOne(
        { _id: token },
        { $setOnInsert: { playerId, productId, kind: product.kind, at: Date.now() }, $set: { state: 'pending' } },
        { upsert: true }
      );
      return this._answer(playerId, { pending: true });
    }
    if (info.state !== 'purchased') return { error: 'canceled' };
    await this._credit(playerId, productId, token, info);
    return this._answer(playerId, { credited: true });
  }

  // Forest Pass daily bonus, once per UTC day while active.
  //   { gems, hints, grant } | { error: 'no-pass' }
  async claimPass(playerId) {
    const doc = await this.players.findOne({ _id: playerId }, { projection: { pass: 1 } });
    if (!(doc?.pass?.expiresAt > Date.now())) return { error: 'no-pass', ...(await this.economy.wallet(playerId)) };
    const day = utcDay();
    return this.economy.apply(playerId, { item: 'pass-daily', key: day, grant: { ...PASS_DAILY }, context: { day } });
  }

  // Real-time developer notification (already authenticated by the route):
  // the decoded Pub/Sub message data. Returns a short description for logs.
  async handleNotification(n) {
    if (n.testNotification) return 'test';
    if (n.packageName && n.packageName !== this.google.packageName()) return `other package ${n.packageName}`;

    if (n.oneTimeProductNotification) {
      const { notificationType, purchaseToken: token, sku: productId } = n.oneTimeProductNotification;
      if (!PRODUCTS[productId]) return `unknown product ${productId}`;
      if (notificationType === 2) { // ONE_TIME_PRODUCT_CANCELED (a pending payment that never completed)
        await this.purchases.updateOne({ _id: token, state: 'pending' }, { $set: { state: 'canceled' } });
        return `canceled ${productId}`;
      }
      const info = await this.google.getProductPurchase(productId, token);
      if (info?.state !== 'purchased') return `${productId} ${info?.state || 'unknown'}`;
      const owner = await this._owner(token, info.accountId);
      if (!owner) return `no owner for ${productId}`;
      await this._credit(owner, productId, token, info);
      // The app may be closed: acknowledge so Google doesn't refund it. The
      // client still consumes it (consumables) when it next opens.
      if (!info.acknowledged) await this._quietly(() => this.google.acknowledgeProduct(productId, token));
      return `credited ${productId} to ${owner}`;
    }

    if (n.subscriptionNotification) {
      const { notificationType, purchaseToken: token, subscriptionId: productId } = n.subscriptionNotification;
      if (PRODUCTS[productId]?.kind !== 'subscription') return `unknown subscription ${productId}`;
      const info = await this.google.getSubscription(token);
      if (!info) return `unknown token for ${productId}`;
      const owner = await this._owner(token, info.accountId);
      if (!owner) return `no owner for ${productId}`;
      await this._applySubscription(owner, productId, token, info);
      if (info.active && !info.acknowledged) await this._quietly(() => this.google.acknowledgeSubscription(productId, token));
      return `subscription ${notificationType} -> ${info.state} for ${owner}`;
    }

    if (n.voidedPurchaseNotification) {
      const { purchaseToken: token } = n.voidedPurchaseNotification;
      const record = await this.purchases.findOneAndUpdate({ _id: token }, { $set: { state: 'voided', voidedAt: Date.now() } });
      if (!record) return 'voided unknown token';
      // Refunded Remove Ads / Pass lose their effect; refunded gems are
      // not clawed back (v1).
      if (record.productId === 'remove_ads') await this.players.updateOne({ _id: record.playerId }, { $set: { removeAds: false } });
      if (PRODUCTS[record.productId]?.kind === 'subscription') {
        await this.players.updateOne({ _id: record.playerId, 'pass.token': token }, { $set: { 'pass.expiresAt': Date.now(), 'pass.autoRenewing': false } });
      }
      return `voided ${record.productId} of ${record.playerId}`;
    }
    return 'ignored';
  }

  // Conflict "Restore": the guest's purchases follow it into the saved
  // account -- Remove Ads, the Pass, the starter flag, and the gems/hints
  // it bought (at most what the guest still holds). Free gems stay behind.
  async mergePurchases(guestId, targetId) {
    const guest = await this.players.findOne({ _id: guestId });
    if (!guest) return;
    const bought = await this.purchases.find({ playerId: guestId, state: 'credited' }).toArray();
    await this.purchases.updateMany({ playerId: guestId }, { $set: { playerId: targetId } });

    const paid = { gems: 0, hints: 0 };
    for (const p of bought) {
      const grant = PRODUCTS[p.productId]?.grant || {};
      paid.gems += grant.gems || 0;
      paid.hints += grant.hints || 0;
    }
    const move = { gems: Math.min(paid.gems, guest.gems || 0), hints: Math.min(paid.hints, guest.hints || 0) };
    if (move.gems || move.hints) {
      await this.economy.ensureWallet(targetId);
      await this.economy.apply(targetId, { item: 'merge-paid', key: guestId, grant: move, context: { from: guestId } });
    }

    const target = await this.players.findOne({ _id: targetId }, { projection: { pass: 1 } });
    const set = {};
    if (guest.removeAds) set.removeAds = true;
    if (guest.starterBought) set.starterBought = true;
    if (guest.pass && (!target?.pass || guest.pass.expiresAt > target.pass.expiresAt)) set.pass = guest.pass;
    const ids = [guest.iapId || IapStore.accountIdFor(guestId), ...(guest.mergedIapIds || [])];
    await this.players.updateOne({ _id: targetId }, { ...(Object.keys(set).length ? { $set: set } : {}), $addToSet: { mergedIapIds: { $each: ids } } });
  }

  // Account deletion: purchase records stay (tax/fraud), unlinked from the player.
  async anonymize(playerId) {
    const alias = `deleted-${crypto.randomBytes(8).toString('hex')}`;
    await this.purchases.updateMany({ playerId }, { $set: { playerId: alias } });
  }

  // ------------------------------------------------------------------

  async _answer(playerId, extra) {
    return { ...extra, ...(await this.economy.wallet(playerId)), ...(await this.status(playerId)) };
  }

  // The obfuscated account ids this player may present: its own, plus
  // those of guests merged into it (their purchases now belong here).
  async _accountIds(playerId) {
    const doc = await this.players.findOne({ _id: playerId }, { projection: { mergedIapIds: 1 } });
    return [IapStore.accountIdFor(playerId), ...(doc?.mergedIapIds || [])];
  }

  async _owner(token, accountId) {
    const record = await this.purchases.findOne({ _id: token }, { projection: { playerId: 1 } });
    if (record?.playerId && !record.playerId.startsWith('deleted-')) return record.playerId;
    if (!accountId) return null;
    const doc = await this.players.findOne({ $or: [{ iapId: accountId }, { mergedIapIds: accountId }] }, { projection: { _id: 1 } });
    return doc?._id || null;
  }

  async _credit(playerId, productId, token, info) {
    const product = PRODUCTS[productId];
    await this.purchases.updateOne(
      { _id: token },
      { $setOnInsert: { playerId, productId, kind: product.kind, at: Date.now() }, $set: { orderId: info.orderId } },
      { upsert: true }
    );
    if (product.grant) {
      await this.economy.ensureWallet(playerId);
      const key = info.orderId || crypto.createHash('sha256').update(token).digest('hex').slice(0, 40);
      let result = await this.economy.apply(playerId, { item: 'iap', key, grant: { ...product.grant }, context: { productId, orderId: info.orderId } });
      for (let i = 0; i < 5 && result.error === 'in-progress'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        result = await this.economy.apply(playerId, { item: 'iap', key, grant: { ...product.grant }, context: { productId, orderId: info.orderId } });
      }
    }
    if (product.kind === 'once') await this.players.updateOne({ _id: playerId }, { $set: { starterBought: true } });
    if (product.kind === 'permanent') await this.players.updateOne({ _id: playerId }, { $set: { removeAds: true } });
    await this.purchases.updateOne({ _id: token }, { $set: { state: 'credited', creditedAt: Date.now() } });
    console.log(`[iap] credited ${productId} (${info.orderId}) to ${playerId}`);
  }

  async _applySubscription(playerId, productId, token, info) {
    await this.purchases.updateOne(
      { _id: token },
      {
        $setOnInsert: { playerId, productId, kind: 'subscription', at: Date.now() },
        $set: { state: 'credited', orderId: info.orderId, expiresAt: info.expiresAt, subState: info.state },
      },
      { upsert: true }
    );
    const pass = { productId, token, expiresAt: info.active ? info.expiresAt : Math.min(info.expiresAt, Date.now()), autoRenewing: info.active && info.autoRenewing };
    // Another active subscription (a resubscribe with a new token) wins
    // over this token's lapse.
    const filter = info.active
      ? { _id: playerId }
      : { _id: playerId, $or: [{ pass: { $exists: false } }, { 'pass.token': token }, { 'pass.expiresAt': { $lte: Date.now() } }] };
    await this.players.updateOne(filter, { $set: { pass } });
  }

  async _quietly(fn) {
    try {
      await fn();
    } catch (err) {
      console.warn('[iap] acknowledge failed:', err.message);
    }
  }
}

module.exports = IapStore;
