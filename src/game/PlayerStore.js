const { arenaForTrophies } = require('./arena');

const COLLECTION = 'players';
const WIN_GAIN = 30;
const LOSS_DEDUCTION = 15;
const NAME_MAX_LENGTH = 20;

// One document per player, keyed by Firebase uid. Holds the server-owned
// profile (display name) and ranked trophies; economy fields join later.
class PlayerStore {
  constructor(db) {
    this.collection = db.collection(COLLECTION);
  }

  static defaultName(playerId) {
    return `PLAYER-${playerId.slice(-4).toUpperCase()}`;
  }

  // Trims, collapses inner whitespace, and enforces 1..NAME_MAX_LENGTH
  // printable characters. Returns the cleaned name, or null if invalid.
  static cleanName(name) {
    if (typeof name !== 'string') return null;
    const cleaned = name.replace(/\s+/g, ' ').trim();
    if (cleaned.length < 1 || cleaned.length > NAME_MAX_LENGTH) return null;
    if (/[\u0000-\u001F\u007F]/.test(cleaned)) return null;
    return cleaned;
  }

  static toPlayer(doc) {
    const trophies = doc.trophies || 0;
    return { playerId: doc._id, name: doc.name, trophies, arena: arenaForTrophies(trophies) };
  }

  // Returns { player, isNew }; creates the player on first sight and bumps
  // lastSeenAt either way.
  async getOrCreate(playerId) {
    const now = Date.now();
    const result = await this.collection.findOneAndUpdate(
      { _id: playerId },
      {
        $setOnInsert: { name: PlayerStore.defaultName(playerId), trophies: 0, createdAt: now },
        $set: { lastSeenAt: now },
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true }
    );
    return { player: PlayerStore.toPlayer(result.value), isNew: !result.lastErrorObject?.updatedExisting };
  }

  // Returns the updated player, or null if the name is invalid.
  async setName(playerId, name) {
    const cleaned = PlayerStore.cleanName(name);
    if (!cleaned) return null;
    await this.getOrCreate(playerId);
    const doc = await this.collection.findOneAndUpdate(
      { _id: playerId },
      { $set: { name: cleaned } },
      { returnDocument: 'after' }
    );
    return PlayerStore.toPlayer(doc);
  }

  // "Restore saved account" (client conflict flow): the player had a guest
  // account on this device, then signed into Play Games/Google which
  // already belongs to an older account. Folds the guest into the saved
  // account and deletes the guest's player record. The saved account's
  // profile, trophies and gems win. Free gems (the starter grant -- all
  // there is until real-money purchases) never move over; purchased gems
  // will, once the Store exists.
  // Returns the saved account's player.
  async mergeGuestInto(targetId, guestId) {
    const guest = await this.collection.findOne({ _id: guestId });
    await this.getOrCreate(targetId);
    if (guest) {
      await this.collection.updateOne(
        { _id: targetId },
        { $push: { mergedFrom: { playerId: guestId, trophies: guest.trophies || 0, at: Date.now() } } }
      );
      await this.collection.deleteOne({ _id: guestId });
    }
    const target = await this.collection.findOne({ _id: targetId });
    return { player: PlayerStore.toPlayer(target), merged: !!guest };
  }

  // Account deletion (in-app or the web request page): removes everything
  // the server stores about the player. Shared puzzles carry no owner, so
  // there is nothing else to remove. Idempotent.
  async deletePlayer(playerId) {
    const { deletedCount } = await this.collection.deleteOne({ _id: playerId });
    return deletedCount > 0;
  }

  // Applies a ranked match result: winner gains WIN_GAIN, loser loses
  // LOSS_DEDUCTION (clamped at 0, never negative). Returns both players'
  // updated { playerId, trophies, arena, delta }.
  async applyMatchResult(winnerId, loserId) {
    const [{ player: winnerBefore }, { player: loserBefore }] = await Promise.all([
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
      winner: { playerId: winnerId, trophies: winnerTrophies, arena: arenaForTrophies(winnerTrophies), delta: WIN_GAIN },
      loser: { playerId: loserId, trophies: loserTrophies, arena: arenaForTrophies(loserTrophies), delta: loserTrophies - loserBefore.trophies },
    };
  }
}

PlayerStore.NAME_MAX_LENGTH = NAME_MAX_LENGTH;

module.exports = PlayerStore;
