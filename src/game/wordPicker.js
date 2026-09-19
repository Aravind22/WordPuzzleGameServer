// Port of Assets/Scripts/WordSearch/WordPicker.cs
// Picks N words per puzzle, avoiding repeats from the last COOLDOWN_PUZZLES puzzles.
const COOLDOWN_PUZZLES = 5;

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}

class WordPicker {
  constructor(wordPool) {
    this._pool = [...wordPool];
    this._history = []; // oldest first
  }

  pick(count) {
    const recentlyUsed = new Set();
    for (const used of this._history) {
      for (const w of used) recentlyUsed.add(w);
    }

    let available = this._pool.filter((w) => !recentlyUsed.has(w));

    // Safety net: only reachable if the pool is too small relative to
    // count/cooldown to keep enough words free. Falls back to ignoring
    // the cooldown rather than generating a puzzle with fewer words
    // than requested.
    if (available.length < count) {
      available = [...this._pool];
    }

    shuffle(available);
    const picked = available.slice(0, count);

    this._history.push(picked);
    if (this._history.length > COOLDOWN_PUZZLES) {
      this._history.shift();
    }

    return picked;
  }
}

module.exports = { WordPicker };
