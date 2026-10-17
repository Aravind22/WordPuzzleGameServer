const { customAlphabet } = require('nanoid');

// Same alphabet as RoomManager's room codes: excludes ambiguous chars.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{6}$`);
const generateCode = customAlphabet(CODE_ALPHABET, 6);
const COLLECTION = 'puzzles';
const MAX_NAME_LENGTH = 24;

// The sharer's display name, shown on the puzzle's landing page and to
// whoever opens the link (optional; null when missing or blank).
function cleanName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
  return trimmed || null;
}

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

  static isCode(code) {
    return CODE_PATTERN.test(String(code || '').toUpperCase());
  }

  async _newCode() {
    let code;
    do {
      code = generateCode();
    } while (await this.collection.findOne({ _id: code }));
    return code;
  }

  async create({ gridSize, words, placements, sharedByTimeSeconds, sharedByName }) {
    const code = await this._newCode();
    const record = {
      _id: code,
      code,
      gridSize,
      words,
      placements,
      sharedByTimeSeconds: sharedByTimeSeconds ?? null,
      sharedByName: cleanName(sharedByName),
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
