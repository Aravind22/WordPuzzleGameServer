// Loads wordBank.txt, an identical copy of the Unity client's
// Assets/Resources/WordBank.txt (see the format notes at its top) --
// keep the two files in sync.
const fs = require('fs');
const path = require('path');

const MIN_LENGTH = 3;
const MAX_LENGTH = 9; // grid is 10x10; one cell of slack keeps placement easy

function parse(text) {
  const words = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('#')) continue;
    const word = line.split('|')[0].trim().toUpperCase(); // "WORD | meaning" -- meaning reserved for later
    if (word.length < MIN_LENGTH || word.length > MAX_LENGTH || !/^[A-Z]+$/.test(word)) {
      console.warn(`wordBank: skipping invalid word '${word}'`);
      continue;
    }
    if (!seen.has(word)) {
      seen.add(word);
      words.push(word);
    }
  }
  return words;
}

const WORDS = parse(fs.readFileSync(path.join(__dirname, 'wordBank.txt'), 'utf8'));

module.exports = { WORDS, MIN_LENGTH, MAX_LENGTH };
