// Ranked Quick Match: two clients queue, get paired by the ticking
// matchmaker, then A leaves mid-match (forfeit). Checks the trophyChanges
// payload AND that trophies were persisted (via GET /me). Then a second
// match with B forfeiting checks the loss deduction from a non-zero total.
// Run against a LOCAL server on a throwaway database:
//   MONGO_DB_NAME=wordpuzzle_test node src/server.js
//   node scratch/testRankedTrophies.js
const wsClient = require('./wsClient');
const { withTestUsers } = require('./testUsers');

const URL = 'ws://localhost:6969';
const API = 'http://localhost:6969/api';

async function me(user) {
  return (await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${user.idToken}` } })).json();
}

// Queues both for ranked; `leaver` leaves after matchStart. Resolves the
// gameOver payload as seen by the other player.
function rankedForfeit(leaverUser, stayerUser) {
  return new Promise((resolve, reject) => {
    const leaver = wsClient.connect(URL, leaverUser);
    const stayer = wsClient.connect(URL, stayerUser);
    const timeout = setTimeout(() => done(new Error('ranked match did not complete within 10s')), 10000);
    let connected = 0;

    function done(err, payload) {
      clearTimeout(timeout);
      leaver.close();
      stayer.close();
      err ? reject(err) : resolve(payload);
    }

    const onConnect = () => {
      if (++connected < 2) return;
      leaver.emit('findMatch', {});
      stayer.emit('findMatch', {});
    };
    leaver.on('connect', onConnect);
    stayer.on('connect', onConnect);
    leaver.on('matchStart', () => setTimeout(() => leaver.emit('leaveRoom', {}), 300));
    stayer.on('gameOver', (payload) => done(null, payload));
    for (const c of [leaver, stayer]) c.on('errorMsg', (e) => done(new Error(`errorMsg ${JSON.stringify(e)}`)));
  });
}

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

withTestUsers(2, async ([a, b]) => {
  await me(a);
  await me(b);

  const first = await rankedForfeit(a, b);
  console.log('match 1 gameOver:', JSON.stringify(first));
  const bWin = first.trophyChanges.find((t) => t.playerId === b.uid);
  const aLoss = first.trophyChanges.find((t) => t.playerId === a.uid);
  check('match 1: B (stayer) wins', first.winner === b.uid);
  check('match 1: winner +30', bWin?.delta === 30 && bWin?.trophies === 30);
  check('match 1: loser clamped at 0', aLoss?.delta === 0 && aLoss?.trophies === 0);
  check('match 1: /me shows B at 30', (await me(b)).trophies === 30);
  check('match 1: /me shows A at 0', (await me(a)).trophies === 0);

  const second = await rankedForfeit(b, a);
  console.log('match 2 gameOver:', JSON.stringify(second));
  const aWin = second.trophyChanges.find((t) => t.playerId === a.uid);
  const bLoss = second.trophyChanges.find((t) => t.playerId === b.uid);
  check('match 2: A wins', second.winner === a.uid);
  check('match 2: loser B 30 -> 15 (delta -15)', bLoss?.delta === -15 && bLoss?.trophies === 15);
  check('match 2: winner A 0 -> 30', aWin?.trophies === 30);
  check('match 2: /me persisted (A 30, B 15)', (await me(a)).trophies === 30 && (await me(b)).trophies === 15);
})
  .then(() => {
    console.log(failures === 0 ? 'ALL RANKED TESTS PASSED' : `${failures} RANKED TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => { console.error('TEST FAILED:', err.message); process.exit(1); });
