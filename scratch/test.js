// Manual verification script: simulates two players playing a full match
// through create/join/submitWord against a locally running server.
// Run `node src/server.js` first, then `node scratch/test.js`.
const wsClient = require('./wsClient');

const URL = 'ws://localhost:6969';

function connect(deviceId, name) {
  return wsClient.connect(URL, deviceId, name);
}

const playerA = connect('device-A', 'Alice');
const playerB = connect('device-B', 'Bob');

let grid = null;
let gridSize = 0;
let words = [];
const foundWords = new Set();

function log(who, ...args) {
  console.log(`[${who}]`, ...args);
}

function cellsForWord(word) {
  // Scans the known grid for the word horizontally or vertically since the
  // test client doesn't have access to server-side placedWords cell data.
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col <= gridSize - word.length; col++) {
      let match = true;
      for (let i = 0; i < word.length; i++) {
        if (grid[row * gridSize + (col + i)] !== word[i]) { match = false; break; }
      }
      if (match) {
        return Array.from({ length: word.length }, (_, i) => ({ row, col: col + i }));
      }
    }
  }
  for (let col = 0; col < gridSize; col++) {
    for (let row = 0; row <= gridSize - word.length; row++) {
      let match = true;
      for (let i = 0; i < word.length; i++) {
        if (grid[(row + i) * gridSize + col] !== word[i]) { match = false; break; }
      }
      if (match) {
        return Array.from({ length: word.length }, (_, i) => ({ row: row + i, col }));
      }
    }
  }
  return null;
}

playerA.on('connect', () => {
  log('A', 'connected', playerA.id);
  playerA.emit('createRoom');
});

playerA.on('roomCreated', ({ code }) => {
  log('A', 'room created', code);
  playerB.emit('joinRoom', { code });
});

for (const [sock, who] of [[playerA, 'A'], [playerB, 'B']]) {
  sock.on('opponentJoined', (payload) => log(who, 'opponentJoined', payload));
  sock.on('errorMsg', (payload) => log(who, 'errorMsg', payload));
  sock.on('opponentDisconnected', (payload) => log(who, 'opponentDisconnected', payload));
  sock.on('opponentReconnected', () => log(who, 'opponentReconnected'));

  sock.on('matchStart', (payload) => {
    log(who, 'matchStart', { gridSize: payload.gridSize, words: payload.words });
    if (who === 'A') {
      grid = payload.grid;
      gridSize = payload.gridSize;
      words = payload.words;

      // Player A submits every word it can find; player B submits none, so
      // A should win by majority once it clears the threshold.
      let i = 0;
      const submitNext = () => {
        if (i >= words.length) return;
        const word = words[i++];
        if (foundWords.has(word)) return submitNext();
        const cells = cellsForWord(word);
        if (cells) playerA.emit('submitWord', { cells });
        setTimeout(submitNext, 50);
      };
      submitNext();
    }
  });

  sock.on('wordFound', (payload) => {
    foundWords.add(payload.word);
    log(who, 'wordFound', payload.word, 'scores:', payload.scores);
  });

  sock.on('wordRejected', (payload) => log(who, 'wordRejected', payload));

  sock.on('gameOver', (payload) => {
    log(who, 'gameOver', payload);
    if (who === 'A') {
      playerA.close();
      playerB.close();
      process.exit(0);
    }
  });
}

setTimeout(() => {
  console.error('Timed out waiting for match to finish');
  process.exit(1);
}, 15000);
