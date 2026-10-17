// Port of Assets/Scripts/WordSearch/WordPicker.cs.
// Deals words from a shuffled deck of the whole bank, so every word comes up
// once before any word repeats; when the deck runs out it is reshuffled (the
// previous puzzle's words go to the back). In memory only: a restart starts
// a fresh deck.

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
}

class WordPicker {
  constructor(wordPool) {
    this._pool = [...new Set(wordPool)];
    this._deck = [];
    this._lastPicked = [];
  }

  pick(count) {
    const picked = [];
    count = Math.min(count, this._pool.length);
    while (picked.length < count) {
      if (this._deck.length === 0) this._reshuffle(picked);
      const word = this._deck.shift();
      if (!picked.includes(word)) picked.push(word);
    }
    this._lastPicked = picked;
    return [...picked];
  }

  // New cycle: the whole bank in a new order, with the words of the last
  // puzzle and of the one being built kept to the back.
  _reshuffle(picking) {
    const recent = new Set([...this._lastPicked, ...picking]);
    const front = this._pool.filter((w) => !recent.has(w));
    const back = this._pool.filter((w) => recent.has(w));
    shuffle(front);
    shuffle(back);
    this._deck = [...front, ...back];
  }
}

module.exports = { WordPicker };
