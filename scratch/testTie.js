// Manual verification for the tie path: all 8 words found on a 4-4 split,
// nobody reaches the majority (5) threshold -> gameOver with winner: 'tie'.
// Run `node src/server.js` first, then `node scratch/testTie.js`.
const wsClient = require('./wsClient');

const URL = 'ws://localhost:6969';

function connect(deviceId, name) {
  return wsClient.connect(URL, deviceId, name);
}

function log(who, ...args) {
  console.log(`[${who}]`, ...args);
}

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

const a = connect('tie-A', 'Alice');
const b = connect('tie-B', 'Bob');

const timeout = setTimeout(() => {
  console.error('TEST FAILED: timed out waiting for tie');
  process.exit(1);
}, 15000);

a.on('connect', () => a.emit('createRoom'));
a.on('roomCreated', ({ code }) => b.emit('joinRoom', { code }));

a.on('matchStart', ({ grid, gridSize, words }) => {
  log('A', 'matchStart', { gridSize, wordCount: words.length });
  const half = Math.floor(words.length / 2);
  const aWords = words.slice(0, half);
  const bWords = words.slice(half);

  for (const word of aWords) {
    const cells = findCells(grid, gridSize, word);
    if (cells) a.emit('submitWord', { cells });
  }
  for (const word of bWords) {
    const cells = findCells(grid, gridSize, word);
    if (cells) b.emit('submitWord', { cells });
  }
});

a.on('gameOver', (payload) => {
  clearTimeout(timeout);
  log('A', 'gameOver', payload);
  a.close();
  b.close();
  if (payload.winner === 'tie') {
    console.log('PASS - tie declared with scores', payload.scores);
    process.exit(0);
  } else {
    console.error('TEST FAILED: expected tie, got winner =', payload.winner);
    process.exit(1);
  }
});
