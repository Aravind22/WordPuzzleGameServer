const { customAlphabet } = require('nanoid');

// Same alphabet as RoomManager's room codes: excludes ambiguous chars.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const generateCode = customAlphabet(CODE_ALPHABET, 6);
const COLLECTION = 'puzzles';

// Backed by Mongo so a shared puzzle link survives a server restart/redeploy
// -- only the word list and each word's placement (cells) are stored, since
// the filler letters in the unused cells aren't part of what makes a puzzle
// "the same puzzle" (they don't affect which words are findable); the
// recipient regenerates those locally instead of the record carrying a full
// 100-cell grid.
class PuzzleShareStore {
  constructor(db) {
    this.collection = db.collection(COLLECTION);
  }

  async _newCode() {
    let code;
    do {
      code = generateCode();
    } while (await this.collection.findOne({ _id: code }));
    return code;
  }

  async create({ gridSize, words, placements, sharedByTimeSeconds }) {
    const code = await this._newCode();
    const record = {
      _id: code,
      code,
      gridSize,
      words,
      placements,
      sharedByTimeSeconds: sharedByTimeSeconds ?? null,
      createdAt: Date.now(),
    };
    await this.collection.insertOne(record);
    return record;
  }

  async get(code) {
    return this.collection.findOne({ _id: String(code || '').toUpperCase() });
  }
}

module.exports = PuzzleShareStore;
