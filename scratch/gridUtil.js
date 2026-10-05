// Shared by the scratch match scripts: locates a word's cells in a match
// grid (horizontal or vertical, matching gridGenerator's directions), since
// test clients only receive the grid + word list, not placements.
function findCells(grid, gridSize, word) {
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col <= gridSize - word.length; col++) {
      let match = true;
      for (let i = 0; i < word.length; i++) {
        if (grid[row * gridSize + (col + i)] !== word[i]) { match = false; break; }
      }
      if (match) return Array.from({ length: word.length }, (_, i) => ({ row, col: col + i }));
    }
  }
  for (let col = 0; col < gridSize; col++) {
    for (let row = 0; row <= gridSize - word.length; row++) {
      let match = true;
      for (let i = 0; i < word.length; i++) {
        if (grid[(row + i) * gridSize + col] !== word[i]) { match = false; break; }
      }
      if (match) return Array.from({ length: word.length }, (_, i) => ({ row: row + i, col }));
    }
  }
  return null;
}

module.exports = { findCells };
