const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');

// Persisted (not just in-memory, unlike Rooms/PuzzleShareStore) since a
// global "total solved" counter resetting on every server restart would be
// a visibly broken product, not just an inconvenience.
class StatsStore {
  constructor(filePath = STATS_FILE) {
    this.filePath = filePath;
    this.totalSolved = 0;
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      this.totalSolved = Number(parsed.totalSolved) || 0;
    } catch {
      this.totalSolved = 0;
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ totalSolved: this.totalSolved }));
    } catch (e) {
      console.warn('StatsStore: failed to persist', e.message);
    }
  }

  getTotalSolved() {
    return this.totalSolved;
  }

  incrementSolved() {
    this.totalSolved += 1;
    this._save();
    return this.totalSolved;
  }
}

module.exports = StatsStore;
