const crypto = require('crypto');
const { arenaForTrophies } = require('./arena');
const { cleanStats, applyEvent, mergeStats, KEEP_EVENT_IDS } = require('./playerStats');

const COLLECTION = 'players';
const WIN_GAIN = 30;
const LOSS_DEDUCTION = 15;
const NAME_MAX_LENGTH = 20;
// Profile pictures 1..AVATAR_COUNT (client: PlayerAvatars, Art/ForestUI/avatars).
const AVATAR_COUNT = 15;

// One document per player, keyed by Firebase uid. Holds the server-owned
// profile (display name, avatar) and ranked trophies; economy fields join later.
class PlayerStore {
  constructor(db) {
    this.collection = db.collection(COLLECTION);
  }

  static defaultName(playerId) {
    return `PLAYER-${playerId.slice(-4).toUpperCase()}`;
  }

  // A new player's picture until they pick one, so players don't all
  // share the same one. Stored on the player doc (getOrCreate).
  static randomAvatar() {
    return crypto.randomInt(1, AVATAR_COUNT + 1);
  }

  // 1..AVATAR_COUNT, or null if invalid.
  static cleanAvatar(avatar) {
    return Number.isInteger(avatar) && avatar >= 1 && avatar <= AVATAR_COUNT ? avatar : null;
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
    // 0 only for a doc getOrCreate hasn't seen since avatars arrived.
    const avatar = PlayerStore.cleanAvatar(doc.avatar) || 0;
    return { playerId: doc._id, name: doc.name, avatar, trophies, arena: arenaForTrophies(trophies) };
  }

  // Read-only: { [playerId]: avatar } for the ids that have a player doc.
  async avatarsOf(playerIds) {
    const docs = await this.collection.find({ _id: { $in: playerIds } }, { projection: { avatar: 1 } }).toArray();
    return Object.fromEntries(docs.map((d) => [d._id, PlayerStore.cleanAvatar(d.avatar) || 0]));
  }

  // Read-only: how many of playerIds sit in each arena, as { [arena]: count }.
  // Ids with no player doc are skipped. Used by the processDef dashboard.
  async countByArena(playerIds) {
    const counts = {};
    if (playerIds.length === 0) return counts;
    const docs = await this.collection.find({ _id: { $in: playerIds } }, { projection: { trophies: 1 } }).toArray();
    for (const doc of docs) {
      const arena = arenaForTrophies(doc.trophies || 0);
      counts[arena] = (counts[arena] || 0) + 1;
    }
    return counts;
  }

  // Returns { player, isNew }; creates the player on first sight (with a
  // random avatar) and bumps lastSeenAt either way. A player from before
  // avatars gets a random one stored here too, once.
  async getOrCreate(playerId) {
    const now = Date.now();
    const result = await this.collection.findOneAndUpdate(
      { _id: playerId },
      {
        $setOnInsert: { name: PlayerStore.defaultName(playerId), avatar: PlayerStore.randomAvatar(), trophies: 0, createdAt: now },
        $set: { lastSeenAt: now },
      },
      { upsert: true, returnDocument: 'after', includeResultMetadata: true }
    );
    let doc = result.value;
    if (!PlayerStore.cleanAvatar(doc.avatar)) {
      // Only if still unset, so a pick made meanwhile isn't overwritten.
      await this.collection.updateOne({ _id: playerId, avatar: doc.avatar }, { $set: { avatar: PlayerStore.randomAvatar() } });
      doc = await this.collection.findOne({ _id: playerId });
    }
    return { player: PlayerStore.toPlayer(doc), isNew: !result.lastErrorObject?.updatedExisting };
  }

  // Returns the updated player, or null if the name is invalid.
  async setName(playerId, name) {
    return this.setProfile(playerId, { name });
  }

  // PATCH /me: name and/or avatar (an undefined field is left alone).
  // Returns the updated player, or null if a given field is invalid or
  // neither is given.
  async setProfile(playerId, { name, avatar }) {
    const changes = {};
    if (name !== undefined) {
      changes.name = PlayerStore.cleanName(name);
      if (!changes.name) return null;
    }
    if (avatar !== undefined) {
      changes.avatar = PlayerStore.cleanAvatar(avatar);
      if (!changes.avatar) return null;
    }
    if (Object.keys(changes).length === 0) return null;
    await this.getOrCreate(playerId);
    const doc = await this.collection.findOneAndUpdate(
      { _id: playerId },
      { $set: changes },
      { returnDocument: 'after' }
    );
    return PlayerStore.toPlayer(doc);
  }

  // "Restore saved account" (client conflict flow): the player had a guest
  // account on this device, then signed into Play Games/Google which
  // already belongs to an older account. Folds the guest into the saved
  // account and deletes the guest's player record. The saved account's
  // profile (name, avatar), trophies and gems win. Free gems (the starter grant -- all
  // there is until real-money purchases) never move over; purchased gems
  // will, once the Store exists.
  // Returns the saved account's player.
  async mergeGuestInto(targetId, guestId) {
    const guest = await this.collection.findOne({ _id: guestId });
    await this.getOrCreate(targetId);
    if (guest) {
      // Unlike the profile, the guest's STATS are games that really happened: add them.
      if (guest.stats) await this.updateStats(targetId, (stats) => (mergeStats(stats, cleanStats(guest.stats)), true));
      await this.collection.updateOne(
        { _id: targetId },
        { $push: { mergedFrom: { playerId: guestId, trophies: guest.trophies || 0, at: Date.now() } } }
      );
      await this.collection.deleteOne({ _id: guestId });
    }
    const target = await this.collection.findOne({ _id: targetId });
    return { player: PlayerStore.toPlayer(target), merged: !!guest };
  }

  // Account deletion: the player id plus every guest merged into it, since
  // the guests' Daily attempts, feedback and ledger rows keep their own ids.
  async accountIds(playerId) {
    const doc = await this.collection.findOne({ _id: playerId }, { projection: { mergedFrom: 1 } });
    return [playerId, ...(doc?.mergedFrom || []).map((m) => m.playerId).filter(Boolean)];
  }

  // Account deletion (in-app or the web request page): the player record,
  // removed last (see DELETE /me) since it lists the merged guests.
  // Idempotent.
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
      this.collection.updateOne({ _id: winnerId }, { $set: { trophies: winnerTrophies }, $max: { 'stats.peakTrophies': winnerTrophies } }),
      this.collection.updateOne({ _id: loserId }, { $set: { trophies: loserTrophies } }),
    ]);

    return {
      winner: { playerId: winnerId, trophies: winnerTrophies, arena: arenaForTrophies(winnerTrophies), delta: WIN_GAIN },
      loser: { playerId: loserId, trophies: loserTrophies, arena: arenaForTrophies(loserTrophies), delta: loserTrophies - loserBefore.trophies },
    };
  }

  // A ranked result against a bot: same WIN_GAIN / LOSS_DEDUCTION, but only
  // the human's side exists to persist. Returns { playerId, trophies, arena, delta }.
  async applySoloResult(playerId, won) {
    const { player: before } = await this.getOrCreate(playerId);
    const trophies = won ? before.trophies + WIN_GAIN : Math.max(0, before.trophies - LOSS_DEDUCTION);
    const update = won ? { $set: { trophies }, $max: { 'stats.peakTrophies': trophies } } : { $set: { trophies } };
    await this.collection.updateOne({ _id: playerId }, update);
    return { playerId, trophies, arena: arenaForTrophies(trophies), delta: trophies - before.trophies };
  }

  // ---------------------------------------------------------------- stats
  // Lifetime STATS (playerStats.js) live on the player doc as `stats`, with
  // the ids of recently applied events and a version for concurrent writes
  // (read, apply in JS, write back only if nobody wrote in between).

  async getStats(playerId) {
    const doc = await this.collection.findOne({ _id: playerId }, { projection: { stats: 1, trophies: 1 } });
    const stats = cleanStats(doc?.stats);
    stats.peakTrophies = Math.max(stats.peakTrophies, doc?.trophies || 0);
    return stats;
  }

  // change(stats, seenIds) edits stats in place and returns the event ids it
  // applied (true for a merge); nothing applied -> nothing written.
  async updateStats(playerId, change) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const doc = await this.collection.findOne({ _id: playerId }, { projection: { stats: 1, statsEventIds: 1, statsVersion: 1, trophies: 1 } });
      if (!doc) return null;
      const version = doc.statsVersion || 0;
      const stats = cleanStats(doc.stats);
      stats.peakTrophies = Math.max(stats.peakTrophies, doc.trophies || 0);
      const applied = change(stats, new Set(doc.statsEventIds || []));
      if (!applied || applied.length === 0) return stats;
      const ids = Array.isArray(applied) ? [...(doc.statsEventIds || []), ...applied].slice(-KEEP_EVENT_IDS) : doc.statsEventIds || [];
      const { matchedCount } = await this.collection.updateOne(
        { _id: playerId, statsVersion: version === 0 ? { $in: [0, null] } : version },
        { $set: { stats, statsEventIds: ids, statsVersion: version + 1 } }
      );
      if (matchedCount === 1) return stats;
    }
    throw new Error(`stats update for ${playerId} kept conflicting`);
  }

  // POST /me/stats: a device's seed (once) and its finished games, each
  // applied at most once however often the client retries.
  async applyStats(playerId, { seedId, seed, events }) {
    await this.getOrCreate(playerId);
    return this.updateStats(playerId, (stats, seen) => {
      const applied = [];
      if (seedId && !seen.has(seedId)) {
        mergeStats(stats, seed);
        applied.push(seedId);
      }
      for (const event of events) {
        if (seen.has(event.id) || applied.includes(event.id)) continue;
        applyEvent(stats, event);
        applied.push(event.id);
      }
      return applied;
    });
  }
}

PlayerStore.NAME_MAX_LENGTH = NAME_MAX_LENGTH;
PlayerStore.WIN_GAIN = WIN_GAIN;
PlayerStore.LOSS_DEDUCTION = LOSS_DEDUCTION;

module.exports = PlayerStore;
