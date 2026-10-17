// Port of Assets/Scripts/WordSearch/WordSearchGenerator.cs
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIRECTIONS = [
  { row: 0, col: 1 }, // horizontal
  { row: 1, col: 0 }, // vertical
  { row: 1, col: 1 }, // diagonal down-right
  { row: -1, col: 1 }, // diagonal up-right
];

function coordToIndex(row, col, gridSize) {
  return row * gridSize + col;
}

function randomLetter() {
  return ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
}

function randomInt(maxExclusive) {
  return Math.floor(Math.random() * maxExclusive);
}

function getWordCells(word, startRow, startCol, dir) {
  const cells = [];
  for (let i = 0; i < word.length; i++) {
    cells.push({ row: startRow + dir.row * i, col: startCol + dir.col * i });
  }
  return cells;
}

function fitsInBounds(cells, gridSize) {
  return cells.every((c) => c.row >= 0 && c.row <= gridSize - 1 && c.col >= 0 && c.col <= gridSize - 1);
}

function fitsWithoutConflict(word, cells, grid, gridSize) {
  for (let i = 0; i < word.length; i++) {
    const existing = grid[coordToIndex(cells[i].row, cells[i].col, gridSize)];
    if (existing !== '.' && existing !== word[i]) return false;
  }
  return true;
}

// Letters the word would share with words already on the grid, or -1 when
// it can't go there. A spot made only of existing letters is refused: the
// word would hide entirely inside others.
function overlapAt(word, cells, grid, gridSize) {
  if (!fitsInBounds(cells, gridSize) || !fitsWithoutConflict(word, cells, grid, gridSize)) return -1;
  const shared = cells.filter((c) => grid[coordToIndex(c.row, c.col, gridSize)] !== '.').length;
  return shared === word.length ? -1 : shared;
}

function placeWordAt(word, cells, grid, gridSize) {
  for (let i = 0; i < word.length; i++) {
    grid[coordToIndex(cells[i].row, cells[i].col, gridSize)] = word[i];
  }
}

// Tries every start + direction and keeps the spots that share the most
// letters with placed words (ties: random), so words connect whenever they
// can.
function tryPlaceWord(word, grid, gridSize, placedWords) {
  let best = [];
  let bestOverlap = -1;
  for (const direction of DIRECTIONS) {
    for (let startRow = 0; startRow < gridSize; startRow++) {
      for (let startCol = 0; startCol < gridSize; startCol++) {
        const cells = getWordCells(word, startRow, startCol, direction);
        const overlap = overlapAt(word, cells, grid, gridSize);
        if (overlap < 0 || overlap < bestOverlap) continue;
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = [];
        }
        best.push(cells);
      }
    }
  }
  if (best.length === 0) {
    console.warn(`gridGenerator: could not place word: ${word}`);
    return false;
  }
  const cells = best[randomInt(best.length)];
  placeWordAt(word, cells, grid, gridSize);
  placedWords.push({ word, cells });
  return true;
}

function fillEmptyCells(grid, gridSize) {
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      const idx = coordToIndex(row, col, gridSize);
      if (grid[idx] === '.') grid[idx] = randomLetter();
    }
  }
}

// Generates a grid + places words. Returns { grid, gridSize, placedWords }.
// grid is a flat array of single-char strings, row-major (row * gridSize + col).
// placedWords is [{ word, cells: [{row, col}, ...] }, ...].
function generate(words, gridSize = 10) {
  const grid = new Array(gridSize * gridSize).fill('.');
  const placedWords = [];
  const sorted = [...words].sort((a, b) => b.length - a.length);
  for (const word of sorted) {
    tryPlaceWord(word, grid, gridSize, placedWords);
  }
  fillEmptyCells(grid, gridSize);
  return { grid, gridSize, placedWords };
}

module.exports = { generate };
