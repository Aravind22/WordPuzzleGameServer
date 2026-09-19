const COLLECTION = 'stats';
const GLOBAL_STATS_ID = 'global';

// Backed by Mongo (not just in-memory, unlike Rooms/PuzzleShareStore) since a
// global "total solved" counter resetting on every server restart/redeploy
// would be a visibly broken product, not just an inconvenience.
class StatsStore {
  constructor(db) {
    this.collection = db.collection(COLLECTION);
  }

  async getTotalSolved() {
    const doc = await this.collection.findOne({ _id: GLOBAL_STATS_ID });
    return doc?.totalSolved || 0;
  }

  async incrementSolved() {
    const doc = await this.collection.findOneAndUpdate(
      { _id: GLOBAL_STATS_ID },
      { $inc: { totalSolved: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    return doc.totalSolved;
  }
}

module.exports = StatsStore;
