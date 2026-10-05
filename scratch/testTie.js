// Tie path: all 8 words found on a 4-4 split, nobody reaches the majority
// (5) threshold -> gameOver with winner: 'tie'. Run against a LOCAL server
// on a throwaway database:
//   MONGO_DB_NAME=wordpuzzle_test node src/server.js
//   node scratch/testTie.js
const wsClient = require('./wsClient');
const { withTestUsers } = require('./testUsers');
const { findCells } = require('./gridUtil');

const URL = 'ws://localhost:6969';

function playTie(userA, userB) {
  return new Promise((resolve, reject) => {
    const a = wsClient.connect(URL, userA);
    const b = wsClient.connect(URL, userB);
    const timeout = setTimeout(() => { a.close(); b.close(); reject(new Error('timed out waiting for tie')); }, 15000);

    a.on('connect', () => a.emit('createRoom'));
    a.on('roomCreated', ({ code }) => b.emit('joinRoom', { code }));

    a.on('matchStart', ({ grid, gridSize, words }) => {
      const half = Math.floor(words.length / 2);
      for (const word of words.slice(0, half)) {
        const cells = findCells(grid, gridSize, word);
        if (cells) a.emit('submitWord', { cells });
      }
      for (const word of words.slice(half)) {
        const cells = findCells(grid, gridSize, word);
        if (cells) b.emit('submitWord', { cells });
      }
    });

    a.on('gameOver', (payload) => {
      clearTimeout(timeout);
      a.close();
      b.close();
      console.log('gameOver:', JSON.stringify(payload));
      const scoresOk = payload.scores.length === 2 && payload.scores.every((s) => s.count === 4 && s.playerId);
      if (payload.winner === 'tie' && scoresOk) resolve();
      else reject(new Error(`expected 4-4 tie, got winner=${payload.winner}`));
    });
  });
}

withTestUsers(2, ([a, b]) => playTie(a, b))
  .then(() => { console.log('PASS - tie declared with 4-4 scores keyed by playerId'); process.exit(0); })
  .catch((err) => { console.error('TEST FAILED:', err.message); process.exit(1); });
