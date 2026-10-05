// Full unranked match through create/join/submitWord: A finds words, B
// none, so A must win by majority. Also checks the server-owned names and
// playerId fields in the protocol. Run against a LOCAL server on a
// throwaway database:
//   MONGO_DB_NAME=wordpuzzle_test node src/server.js
//   node scratch/test.js
const wsClient = require('./wsClient');
const { withTestUsers } = require('./testUsers');
const { findCells } = require('./gridUtil');

const URL = 'ws://localhost:6969';
const API = 'http://localhost:6969/api';

async function rename(user, name) {
  await fetch(`${API}/me`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${user.idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

function playMatch(userA, userB) {
  return new Promise((resolve, reject) => {
    const a = wsClient.connect(URL, userA);
    const b = wsClient.connect(URL, userB);
    const timeout = setTimeout(() => finish(new Error('timed out waiting for match to finish')), 15000);
    const checks = [];
    let foundCount = 0;

    function finish(err) {
      clearTimeout(timeout);
      a.close();
      b.close();
      err ? reject(err) : resolve(checks);
    }

    a.on('connect', () => a.emit('createRoom'));
    a.on('roomCreated', ({ code }) => b.emit('joinRoom', { code }));
    b.on('opponentJoined', ({ opponentName }) => checks.push(['B sees A\'s server-side name', opponentName === 'Alice']));
    a.on('opponentJoined', ({ opponentName }) => checks.push(['A sees B\'s server-side name', opponentName === 'Bob']));
    for (const c of [a, b]) c.on('errorMsg', (e) => finish(new Error(`errorMsg ${JSON.stringify(e)}`)));

    a.on('matchStart', ({ grid, gridSize, words, players }) => {
      checks.push(['matchStart lists both playerIds', players.some((p) => p.playerId === userA.uid) && players.some((p) => p.playerId === userB.uid)]);
      checks.push(['matchStart has no deviceId field', players.every((p) => !('deviceId' in p))]);
      // A submits every word (B nothing) -> A must reach majority first.
      for (const word of words) {
        const cells = findCells(grid, gridSize, word);
        if (cells) a.emit('submitWord', { cells });
      }
    });

    a.on('wordFound', ({ playerId }) => {
      foundCount++;
      if (foundCount === 1) checks.push(['wordFound carries finder playerId', playerId === userA.uid]);
    });

    a.on('gameOver', (payload) => {
      console.log('gameOver:', JSON.stringify(payload));
      checks.push(['A declared winner (by uid)', payload.winner === userA.uid]);
      checks.push(['unranked match has no trophy changes', Array.isArray(payload.trophyChanges) && payload.trophyChanges.length === 0]);
      finish();
    });
  });
}

(async () => {
  try {
    const checks = await withTestUsers(2, async ([userA, userB]) => {
      await rename(userA, 'Alice');
      await rename(userB, 'Bob');
      return playMatch(userA, userB);
    });
    let failed = 0;
    for (const [label, ok] of checks) {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
      if (!ok) failed++;
    }
    console.log(failed === 0 ? 'ALL MATCH TESTS PASSED' : `${failed} MATCH TEST(S) FAILED`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (err) {
    console.error('TEST FAILED:', err.message);
    process.exit(1);
  }
})();
