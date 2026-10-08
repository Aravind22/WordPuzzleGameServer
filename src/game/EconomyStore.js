const crypto = require('crypto');
const { arenaForTrophies } = require('./arena');
const {
  STARTER_GEMS, STARTER_HINTS, REPLAY_PRICE, HINT_PACK, HINT_PACK_10, AD_HINTS_PER_DAY, AD_GEMS, AD_GEMS_PER_DAY, AD_CONTINUES_PER_DAY, ARENA_HINTS, LOGIN_GIFTS, continuePrice, monetizationOn,
} = require('./economy');
const { utcDay, previousDay } = require('./utcDay');

const PLAYERS = 'players';
const LEDGER = 'economy_ledger';
const BALANCES = ['gems', 'hints'];

// Continue entries (gem-paid and rewarded-ad) that count toward one
// attempt's price escalation.
const CONTINUE_REASONS = ['continue', 'ad-continue'];

// The wallet: gems and hints. Balances live on the player document; every
// grant and spend is also written to the append-only economy_ledger
// (support, fraud checks, price escalation, daily caps). A ledger entry's
// unique (playerId, key) doubles as the idempotency lock: a retried action
// with the same key never applies twice.
class EconomyStore {
  constructor(db) {
    this.players = db.collection(PLAYERS);
    this.ledger = db.collection(LEDGER);
  }

  async init() {
    await this.ledger.createIndex({ playerId: 1, key: 1 }, { unique: true });
    await this.ledger.createIndex({ playerId: 1, 'context.attemptId': 1 });
    await this.ledger.createIndex({ playerId: 1, reason: 1, 'context.day': 1 });
  }

  // One-time starter grants (gems, hints) for any player that doesn't have
  // them yet -- new accounts and players from before each existed alike --
  // and the arena high-water mark for the arena reward. Free grants are
  // never merged into another account. Returns { gems, hints }.
  async ensureWallet(playerId) {
    if (!monetizationOn()) return this.wallet(playerId); // granted once it's back on
    await this._starter(playerId, 'gems', STARTER_GEMS, 'grant:starter', 'starter');
    await this._starter(playerId, 'hints', STARTER_HINTS, 'grant:starter-hints', 'starter-hints');
    const doc = await this.players.findOne({ _id: playerId }, { projection: { trophies: 1, arenaBest: 1 } });
    if (doc && doc.arenaBest === undefined) {
      await this.players.updateOne(
        { _id: playerId, arenaBest: { $exists: false } },
        { $set: { arenaBest: arenaForTrophies(doc.trophies || 0) } }
      );
    }
    return this.wallet(playerId);
  }

  async wallet(playerId) {
    const doc = await this.players.findOne({ _id: playerId }, { projection: { gems: 1, hints: 1 } });
    return { gems: doc?.gems || 0, hints: doc?.hints || 0 };
  }

  // Server prices for one use of item: { cost, grant } maps over BALANCES,
  // or null for an unknown item. 'continue' escalates per attempt: index is
  // how many continues the client has used on it, and the ledger's count
  // wins if it's higher (so a client can't reset it).
  async priceFor(playerId, { item, attemptId, index }) {
    switch (item) {
      case 'replay': return { cost: { gems: REPLAY_PRICE }, grant: {} };
      case 'hint': return { cost: { hints: 1 }, grant: {} };
      case 'hint-pack': return { cost: { gems: HINT_PACK.gems }, grant: { hints: HINT_PACK.hints } };
      case 'hint-pack-10': return { cost: { gems: HINT_PACK_10.gems }, grant: { hints: HINT_PACK_10.hints } };
      case 'continue': {
        const used = await this.ledger.countDocuments({
          playerId, reason: { $in: CONTINUE_REASONS }, 'context.attemptId': attemptId, status: 'done',
        });
        return { cost: { gems: continuePrice(Math.max(index, used)) }, grant: {} };
      }
      default: return null;
    }
  }

  // Applies cost (must be affordable) and grant atomically. Returns
  //   { gems, hints, cost, grant }       on success (or an idempotent retry)
  //   { error: 'insufficient', short, gems, hints, cost }  short = 'gems' | 'hints'
  //   { error: 'in-progress' }            same key still being applied
  async apply(playerId, { item, key, cost = {}, grant = {}, context }) {
    const entryKey = `${item}:${key}`;
    const delta = {};
    for (const b of BALANCES) {
      const d = (grant[b] || 0) - (cost[b] || 0);
      if (d) delta[b] = d;
    }
    try {
      await this.ledger.insertOne({ playerId, key: entryKey, delta, reason: item, context, status: 'pending', at: Date.now() });
    } catch (err) {
      if (err.code !== 11000) throw err;
      const prior = await this.ledger.findOne({ playerId, key: entryKey });
      if (prior?.status !== 'done') return { error: 'in-progress' };
      // Report what that first application charged, not today's price.
      const priorCost = {}, priorGrant = {};
      for (const [b, d] of Object.entries(prior.delta || {})) (d < 0 ? priorCost : priorGrant)[b] = Math.abs(d);
      return { ...(await this.wallet(playerId)), cost: priorCost, grant: priorGrant };
    }

    const filter = { _id: playerId };
    for (const b of BALANCES) if (cost[b]) filter[b] = { $gte: cost[b] };
    const doc = Object.keys(delta).length
      ? await this.players.findOneAndUpdate(filter, { $inc: delta }, { returnDocument: 'after' })
      : await this.players.findOne(filter);
    if (!doc) {
      await this.ledger.deleteOne({ playerId, key: entryKey });
      const wallet = await this.wallet(playerId);
      const short = BALANCES.find((b) => cost[b] && wallet[b] < cost[b]) || 'gems';
      return { error: 'insufficient', short, ...wallet, cost };
    }
    const balances = { gems: doc.gems || 0, hints: doc.hints || 0 };
    await this.ledger.updateOne({ playerId, key: entryKey }, { $set: { status: 'done', balanceAfter: balances } });
    return { ...balances, cost, grant };
  }

  // MORE HINTS > WATCH AD: +1 hint per rewarded ad, capped at
  // AD_HINTS_PER_DAY per UTC day. key is the client's claim key, also sent
  // to AdMob as custom_data "hint:<key>", so either side can grant it first
  // and the other finds it done: AdMob's signed SSV callback (verified) or
  // the client's claim once it has waited for that callback (unverified --
  // test ad units never call SSV). A late SSV marks an unverified grant
  // verified. Returns apply()'s result or { error: 'ad-cap' }.
  async claimAdHint(playerId, key, { verified = false } = {}) {
    return this._claimAdReward(playerId, 'ad-hint', key, { hints: 1 }, AD_HINTS_PER_DAY, verified);
  }

  // Store > FREE GEMS: AD_GEMS per rewarded ad, AD_GEMS_PER_DAY per UTC
  // day; same SSV-first claim as ad hints (custom_data "gems:<key>").
  async claimAdGems(playerId, key, { verified = false } = {}) {
    return this._claimAdReward(playerId, 'ad-gems', key, { gems: AD_GEMS }, AD_GEMS_PER_DAY, verified);
  }

  async _claimAdReward(playerId, reason, key, grant, perDay, verified) {
    const prior = await this._adClaim(playerId, `${reason}:${key}`, verified);
    if (prior) return prior;
    const day = utcDay();
    if (await this._adsOn(playerId, reason, day) >= perDay) return { error: 'ad-cap', ...(await this.wallet(playerId)) };
    return this.apply(playerId, { item: reason, key, grant, context: { day, verified } });
  }

  // Time's Up > WATCH AD: the +30s itself is the client's (solo clocks run
  // there); the server holds the rules. Only an attempt's first continue,
  // once per attempt (a retry returns the same answer), at most
  // AD_CONTINUES_PER_DAY per UTC day. Counts toward the gem continue's
  // escalation. Returns the wallet or { error: 'ad-cap' | 'ad-used' }.
  async claimAdContinue(playerId, attemptId, puzzleId) {
    const prior = await this._adClaim(playerId, `ad-continue:${attemptId}`, false);
    if (prior) return prior;
    const used = await this.ledger.countDocuments({
      playerId, reason: { $in: CONTINUE_REASONS }, 'context.attemptId': attemptId, status: 'done',
    });
    if (used > 0) return { error: 'ad-used', ...(await this.wallet(playerId)) };
    const day = utcDay();
    if (await this._adsOn(playerId, 'ad-continue', day) >= AD_CONTINUES_PER_DAY) return { error: 'ad-cap', ...(await this.wallet(playerId)) };
    return this.apply(playerId, { item: 'ad-continue', key: attemptId, context: { attemptId, puzzleId, day, verified: false } });
  }

  // Today's rewarded-ad claims, for /me: { hints, continues, gems }.
  async adsToday(playerId) {
    const day = utcDay();
    return {
      hints: await this._adsOn(playerId, 'ad-hint', day),
      continues: await this._adsOn(playerId, 'ad-continue', day),
      gems: await this._adsOn(playerId, 'ad-gems', day),
    };
  }

  // Polls (up to waitMs) for a ledger entry another request is writing --
  // the SSV callback's grant for a claim key. True once it is done.
  async waitForEntry(playerId, entryKey, waitMs) {
    const until = Date.now() + waitMs;
    for (;;) {
      const entry = await this.ledger.findOne({ playerId, key: entryKey }, { projection: { status: 1 } });
      if (entry?.status === 'done') return true;
      if (Date.now() >= until) return false;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  // An ad claim already made under entryKey: the wallet (marking it
  // verified when SSV confirms it now), or null.
  async _adClaim(playerId, entryKey, verified) {
    const prior = await this.ledger.findOne({ playerId, key: entryKey });
    if (!prior) return null;
    if (prior.status !== 'done') return { error: 'in-progress' };
    if (verified && !prior.context?.verified) {
      await this.ledger.updateOne({ _id: prior._id }, { $set: { 'context.verified': true } });
    }
    return { ...(await this.wallet(playerId)), cost: {}, grant: { ...prior.delta } };
  }

  _adsOn(playerId, reason, day) {
    return this.ledger.countDocuments({ playerId, reason, 'context.day': day, status: 'done' });
  }

  // Ranked win: ARENA_HINTS for each arena reached for the first time ever
  // (dropping back and re-entering pays nothing). Returns hints awarded.
  async grantArenaHints(playerId, trophiesBefore, trophiesAfter) {
    if (!monetizationOn()) return 0;
    // No high-water mark yet (hasn't opened the game since this shipped):
    // it's the arena they were in before this match.
    await this.players.updateOne(
      { _id: playerId, arenaBest: { $exists: false } },
      { $set: { arenaBest: arenaForTrophies(trophiesBefore) } }
    );
    await this.ensureWallet(playerId); // starter hints before any $inc creates the field
    const arena = arenaForTrophies(trophiesAfter);
    const before = await this.players.findOneAndUpdate(
      { _id: playerId, arenaBest: { $lt: arena } },
      { $set: { arenaBest: arena } },
      { returnDocument: 'before' }
    );
    if (!before) return 0;
    const best = before.arenaBest ?? arenaForTrophies(trophiesBefore);
    const awarded = Math.max(0, arena - best) * ARENA_HINTS;
    if (!awarded) return 0;
    const result = await this.apply(playerId, { item: 'arena', key: `${arena}`, grant: { hints: awarded }, context: { arena, from: best } });
    return result.error ? 0 : awarded;
  }

  // Login Gift: where the player is in the 7-day cycle on the given day.
  //   { claimedToday, index }  index = today's step (claimed) or the next to claim
  static loginGiftState(gift, today = utcDay()) {
    if (gift?.day === today) return { claimedToday: true, index: gift.index };
    if (gift?.day === previousDay(today)) return { claimedToday: false, index: (gift.index + 1) % LOGIN_GIFTS.length };
    return { claimedToday: false, index: 0 }; // first ever, or a missed day
  }

  async loginGift(playerId) {
    const doc = await this.players.findOne({ _id: playerId }, { projection: { loginGift: 1 } });
    return EconomyStore.loginGiftState(doc?.loginGift);
  }

  // Claims today's step: { gems, hints, claimedToday, index, amount } or
  // { error: 'claimed', ... } when today's is already taken. The day field
  // is the lock: only one claim per UTC day can move it to today.
  async claimLoginGift(playerId) {
    const today = utcDay();
    const doc = await this.players.findOne({ _id: playerId }, { projection: { loginGift: 1 } });
    const state = EconomyStore.loginGiftState(doc?.loginGift, today);
    if (state.claimedToday) return { error: 'claimed', ...state, ...(await this.wallet(playerId)) };

    const moved = await this.players.updateOne(
      { _id: playerId, 'loginGift.day': { $ne: today } },
      { $set: { loginGift: { day: today, index: state.index } } }
    );
    if (!moved.modifiedCount) return { error: 'claimed', ...(await this.loginGift(playerId)), ...(await this.wallet(playerId)) };

    const amount = LOGIN_GIFTS[state.index];
    const result = await this.apply(playerId, { item: 'login-gift', key: today, grant: { gems: amount }, context: { day: today, index: state.index } });
    return { ...result, claimedToday: true, index: state.index, amount };
  }

  // Daily Puzzle prize for a top-3 finish (once per day, see DailyStore).
  async grantDailyPrize(playerId, day, rank, gems) {
    return this.apply(playerId, { item: 'daily-prize', key: day, grant: { gems }, context: { day, rank } });
  }

  // A rewarded ad the player watched to the end, confirmed by AdMob's
  // server-side verification callback (see ads/ssv.js). Logged once per
  // transaction, then acted on by custom_data:
  //   "hint:<key>"           grants that ad-hint claim (or verifies it)
  //   "gems:<key>"           same for a Store FREE GEMS claim
  //   "continue:<attemptId>" verifies the attempt's ad-continue claim (the
  //                          time itself is granted client side)
  async recordAdReward({ playerId, transactionId, customData, adUnit, rewardItem, rewardAmount }) {
    if (!playerId || !transactionId) return false;
    const exists = await this.players.countDocuments({ _id: playerId }, { limit: 1 });
    if (!exists) return false;

    await this._insertIgnoringDuplicate({
      playerId,
      key: `ssv:${transactionId}`,
      delta: {},
      reason: 'ad-reward',
      context: { adUnit, rewardItem, rewardAmount, customData },
      status: 'done',
      at: Date.now(),
    });

    const [, kind, id] = /^(hint|gems|continue):([A-Za-z0-9_-]{1,64})$/.exec(customData || '') || [];
    if (kind === 'hint') await this.claimAdHint(playerId, id, { verified: true });
    if (kind === 'gems') await this.claimAdGems(playerId, id, { verified: true });
    if (kind === 'continue') {
      await this.ledger.updateOne({ playerId, key: `ad-continue:${id}` }, { $set: { 'context.verified': true } });
    }
    return true;
  }

  // Account deletion: the ledger is kept for fraud/tax records, but no
  // longer points at the player.
  async anonymize(playerId) {
    const alias = `deleted-${crypto.randomBytes(8).toString('hex')}`;
    await this.ledger.updateMany({ playerId }, { $set: { playerId: alias } });
  }

  async _starter(playerId, field, amount, key, reason) {
    const doc = await this.players.findOneAndUpdate(
      { _id: playerId, [field]: { $exists: false } },
      { $set: { [field]: amount } },
      { returnDocument: 'after' }
    );
    if (!doc) return;
    await this._insertIgnoringDuplicate({
      playerId, key, delta: { [field]: amount }, reason, free: true, status: 'done',
      balanceAfter: { [field]: amount }, at: Date.now(),
    });
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
