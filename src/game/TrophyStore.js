const { arenaForTrophies } = require('./arena');

const COLLECTION = 'players';
const WIN_GAIN = 30;
const LOSS_DEDUCTION = 15;

// Per-player trophy count, Mongo-backed (same reasoning as StatsStore --
// this drives matchmaking/arena placement, so it must survive restarts).
class TrophyStore {
  constructor(db) {
    this.collection = db.collection(COLLECTION);
  }

  async getOrCreate(deviceId) {
    const doc = await this.collection.findOneAndUpdate(
      { _id: deviceId },
      { $setOnInsert: { trophies: 0 } },
      { upsert: true, returnDocument: 'after' }
    );
    const trophies = doc?.trophies || 0;
    return { deviceId, trophies, arena: arenaForTrophies(trophies) };
  }

  // Applies a ranked match result: winner gains WIN_GAIN, loser loses
  // LOSS_DEDUCTION (clamped at 0, never negative). Returns both players'
  // updated { deviceId, trophies, arena, delta }.
  async applyMatchResult(winnerId, loserId) {
    const [winnerBefore, loserBefore] = await Promise.all([
      this.getOrCreate(winnerId),
      this.getOrCreate(loserId),
    ]);

    const winnerTrophies = winnerBefore.trophies + WIN_GAIN;
    const loserTrophies = Math.max(0, loserBefore.trophies - LOSS_DEDUCTION);

    await Promise.all([
      this.collection.updateOne({ _id: winnerId }, { $set: { trophies: winnerTrophies } }),
      this.collection.updateOne({ _id: loserId }, { $set: { trophies: loserTrophies } }),
    ]);

    return {
      winner: { deviceId: winnerId, trophies: winnerTrophies, arena: arenaForTrophies(winnerTrophies), delta: WIN_GAIN },
      loser: { deviceId: loserId, trophies: loserTrophies, arena: arenaForTrophies(loserTrophies), delta: loserTrophies - loserBefore.trophies },
    };
  }
}

module.exports = TrophyStore;
