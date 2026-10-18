const COLLECTION = 'feedback';

// Private player feedback from the in-game form (rating + message). Every
// submission is kept here even when the email to the developer fails or
// isn't configured, so nothing is lost.
class FeedbackStore {
  constructor(db) {
    this.collection = db.collection(COLLECTION);
  }

  async init() {
    await this.collection.createIndex({ playerId: 1, createdAt: -1 });
  }

  async countSince(playerId, since) {
    return this.collection.countDocuments({ playerId, createdAt: { $gte: since } });
  }

  async add(entry) {
    const record = { ...entry, emailed: false, createdAt: Date.now() };
    const { insertedId } = await this.collection.insertOne(record);
    return { ...record, _id: insertedId };
  }

  // Account deletion: everything the player (and merged guests) sent.
  async deletePlayer(playerIds) {
    await this.collection.deleteMany({ playerId: { $in: playerIds } });
  }

  async markEmailed(id) {
    await this.collection.updateOne({ _id: id }, { $set: { emailed: true } });
  }
}

module.exports = FeedbackStore;
