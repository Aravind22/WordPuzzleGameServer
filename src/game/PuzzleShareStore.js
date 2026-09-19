const { customAlphabet } = require('nanoid');

// Same alphabet as RoomManager's room codes: excludes ambiguous chars.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const generateCode = customAlphabet(CODE_ALPHABET, 6);

// Holds shared puzzles in memory, keyed by a short code. Only the word list
// and each word's placement (cells) are stored -- the filler letters in the
// unused cells aren't part of what makes a puzzle "the same puzzle" (they
// don't affect which words are findable), so the recipient regenerates
// those locally instead of the payload carrying a full 100-cell grid.
class PuzzleShareStore {
  constructor() {
    this.puzzles = new Map(); // code -> record
  }

  _newCode() {
    let code;
    do {
      code = generateCode();
    } while (this.puzzles.has(code));
    return code;
  }

  create({ gridSize, words, placements, sharedByTimeSeconds }) {
    const code = this._newCode();
    const record = {
      code,
      gridSize,
      words,
      placements,
      sharedByTimeSeconds: sharedByTimeSeconds ?? null,
      createdAt: Date.now(),
    };
    this.puzzles.set(code, record);
    return record;
  }

  get(code) {
    return this.puzzles.get(String(code || '').toUpperCase());
  }
}

module.exports = PuzzleShareStore;
