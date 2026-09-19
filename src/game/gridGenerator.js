// Port of Assets/Scripts/WordSearch/WordSearchGenerator.cs
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_ATTEMPTS = 100;
const DIRECTIONS = [
  { row: 0, col: 1 }, // horizontal
  { row: 1, col: 0 }, // vertical
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

function canPlace(word, cells, grid, gridSize) {
  return fitsInBounds(cells, gridSize) && fitsWithoutConflict(word, cells, grid, gridSize);
}

function placeWordAt(word, cells, grid, gridSize) {
  for (let i = 0; i < word.length; i++) {
    grid[coordToIndex(cells[i].row, cells[i].col, gridSize)] = word[i];
  }
}

function tryPlaceWord(word, grid, gridSize, placedWords) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const direction = DIRECTIONS[randomInt(DIRECTIONS.length)];
    const startRow = randomInt(gridSize);
    const startCol = randomInt(gridSize);
    const cells = getWordCells(word, startRow, startCol, direction);
    if (canPlace(word, cells, grid, gridSize)) {
      placeWordAt(word, cells, grid, gridSize);
      placedWords.push({ word, cells });
      return true;
    }
  }
  console.warn(`gridGenerator: could not place word: ${word}`);
  return false;
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
