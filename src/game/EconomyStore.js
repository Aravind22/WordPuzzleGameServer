const crypto = require('crypto');
const { STARTER_GEMS, REPLAY_PRICE, continuePrice } = require('./economy');

const PLAYERS = 'players';
const LEDGER = 'economy_ledger';

// Continue entries (gem-paid and rewarded-ad) that count toward one
// attempt's price escalation.
const CONTINUE_REASONS = ['continue', 'ad-continue'];

// The gem wallet. The balance lives on the player document (`gems`); every
// grant and spend is also written to the append-only economy_ledger
// (support, fraud checks, price escalation). A ledger entry's unique
// (playerId, key) doubles as the idempotency lock: a retried spend with the
// same key never charges twice.
class EconomyStore {
  constructor(db) {
    this.players = db.collection(PLAYERS);
    this.ledger = db.collection(LEDGER);
  }

  async init() {
    await this.ledger.createIndex({ playerId: 1, key: 1 }, { unique: true });
    await this.ledger.createIndex({ playerId: 1, 'context.attemptId': 1 });
  }

  // Grants the one-time starter gems to any player without a wallet yet --
  // new accounts and players from before the wallet existed alike. Free
  // grants are never merged into another account. Returns the balance.
  async ensureWallet(playerId) {
    const doc = await this.players.findOneAndUpdate(
      { _id: playerId, gems: { $exists: false } },
      { $set: { gems: STARTER_GEMS } },
      { returnDocument: 'after' }
    );
    if (doc) {
      await this._insertIgnoringDuplicate({
        playerId, key: 'grant:starter', delta: STARTER_GEMS, reason: 'starter', free: true,
        status: 'done', balanceAfter: STARTER_GEMS, at: Date.now(),
      });
      return doc.gems;
    }
    return this.balance(playerId);
  }

  async balance(playerId) {
    const doc = await this.players.findOne({ _id: playerId }, { projection: { gems: 1 } });
    return doc?.gems || 0;
  }

  // Prices a spend from the server's own tables. item 'continue' escalates
  // per attempt: index is how many continues the client has used on it, and
  // the ledger's count wins if it's higher (so a client can't reset it).
  async priceFor(playerId, { item, attemptId, index }) {
    if (item === 'replay') return REPLAY_PRICE;
    if (item === 'continue') {
      const used = await this.ledger.countDocuments({
        playerId, reason: { $in: CONTINUE_REASONS }, 'context.attemptId': attemptId, status: 'done',
      });
      return continuePrice(Math.max(index, used));
    }
    return null;
  }

  // Spends gems for one use of item. Returns
  //   { gems, price }                        on success (or an idempotent retry)
  //   { error: 'insufficient-gems', gems, price }
  //   { error: 'in-progress' }               same key still being applied
  async spend(playerId, { item, key, price, context }) {
    const entryKey = `${item}:${key}`;
    try {
      await this.ledger.insertOne({
        playerId, key: entryKey, delta: -price, reason: item, context, status: 'pending', at: Date.now(),
      });
    } catch (err) {
      if (err.code !== 11000) throw err;
      const prior = await this.ledger.findOne({ playerId, key: entryKey });
      if (prior?.status !== 'done') return { error: 'in-progress' };
      return { gems: await this.balance(playerId), price: -prior.delta };
    }

    const doc = await this.players.findOneAndUpdate(
      { _id: playerId, gems: { $gte: price } },
      { $inc: { gems: -price } },
      { returnDocument: 'after' }
    );
    if (!doc) {
      await this.ledger.deleteOne({ playerId, key: entryKey });
      return { error: 'insufficient-gems', gems: await this.balance(playerId), price };
    }
    await this.ledger.updateOne({ playerId, key: entryKey }, { $set: { status: 'done', balanceAfter: doc.gems } });
    return { gems: doc.gems, price };
  }

  // A rewarded ad the player watched to the end, confirmed by AdMob's
  // server-side verification callback (see ads/ssv.js). Recorded once per
  // transaction; custom_data "continue:<attemptId>" marks the Time's Up
  // continue, which grants time (client side) rather than gems.
  async recordAdReward({ playerId, transactionId, customData, adUnit, rewardItem, rewardAmount }) {
    if (!playerId || !transactionId) return false;
    const exists = await this.players.countDocuments({ _id: playerId }, { limit: 1 });
    if (!exists) return false;

    const match = /^continue:([A-Za-z0-9_-]{1,64})$/.exec(customData || '');
    await this._insertIgnoringDuplicate({
      playerId,
      key: `ssv:${transactionId}`,
      delta: 0,
      reason: match ? 'ad-continue' : 'ad-reward',
      context: { attemptId: match?.[1], adUnit, rewardItem, rewardAmount, customData },
      status: 'done',
      at: Date.now(),
    });
    return true;
  }

  // Account deletion: the ledger is kept for fraud/tax records, but no
  // longer points at the player.
  async anonymize(playerId) {
    const alias = `deleted-${crypto.randomBytes(8).toString('hex')}`;
    await this.ledger.updateMany({ playerId }, { $set: { playerId: alias } });
  }

  async _insertIgnoringDuplicate(entry) {
    try {
      await this.ledger.insertOne(entry);
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
  }
}

module.exports = EconomyStore;
