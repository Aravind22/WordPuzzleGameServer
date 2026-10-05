// Disconnect/reconnect grace-period path. Exercises both branches:
//   1. opponent disconnects, rejoins in time (new socket, same account) -> opponentReconnected
//   2. opponent disconnects, never rejoins -> remaining player wins on gameOver
//
// Run with a short grace period so the timeout branch doesn't take 20s, on
// a throwaway database:
//   DISCONNECT_GRACE_MS=1500 MONGO_DB_NAME=wordpuzzle_test node src/server.js
//   node scratch/testDisconnect.js
const wsClient = require('./wsClient');
const { withTestUsers } = require('./testUsers');

const URL = 'ws://localhost:6969';

function log(who, ...args) {
  console.log(`[${who}]`, ...args);
}

function testReconnect(userA, userB) {
  return new Promise((resolve, reject) => {
    const a = wsClient.connect(URL, userA);
    const b = wsClient.connect(URL, userB);
    let code = null;
    let b2 = null;

    const timeout = setTimeout(() => { cleanup(); reject(new Error('testReconnect timed out')); }, 8000);
    const cleanup = () => { clearTimeout(timeout); a.close(); b.close(); b2?.close(); };

    a.on('connect', () => a.emit('createRoom'));
    a.on('roomCreated', ({ code: c }) => { code = c; b.emit('joinRoom', { code: c }); });
    a.on('matchStart', () => setTimeout(() => b.close(), 200));

    a.on('opponentDisconnected', (payload) => {
      log('A', 'opponentDisconnected', payload);
      // Same Firebase account on a fresh socket = same playerId -> rejoin allowed.
      b2 = wsClient.connect(URL, userB);
      b2.on('connect', () => b2.emit('rejoinRoom', { code }));
      b2.on('matchStart', () => log('B2', 'matchStart replayed on rejoin - ok'));
      b2.on('errorMsg', (err) => { cleanup(); reject(new Error('rejoin errorMsg: ' + JSON.stringify(err))); });
    });

    a.on('opponentReconnected', () => {
      log('A', 'opponentReconnected - PASS');
      cleanup();
      resolve();
    });
  });
}

function testStrangerCannotRejoin(userA, userB, userC) {
  return new Promise((resolve, reject) => {
    const a = wsClient.connect(URL, userA);
    const b = wsClient.connect(URL, userB);
    let c = null;
    const timeout = setTimeout(() => { cleanup(); reject(new Error('testStrangerCannotRejoin timed out')); }, 8000);
    const cleanup = () => { clearTimeout(timeout); a.close(); b.close(); c?.close(); };

    a.on('connect', () => a.emit('createRoom'));
    a.on('roomCreated', ({ code }) => {
      b.emit('joinRoom', { code });
      a.once('matchStart', () => {
        // A different account trying to "rejoin" someone else's room must fail.
        c = wsClient.connect(URL, userC);
        c.on('connect', () => c.emit('rejoinRoom', { code }));
        c.on('errorMsg', (err) => {
          cleanup();
          if (err.code === 'room-not-found') { log('C', 'rejoin by non-member rejected - PASS'); resolve(); }
          else reject(new Error('unexpected errorMsg ' + JSON.stringify(err)));
        });
        c.on('matchStart', () => { cleanup(); reject(new Error('stranger was able to rejoin the room')); });
      });
    });
  });
}

function testTimeout(userA, userB) {
  return new Promise((resolve, reject) => {
    const a = wsClient.connect(URL, userA);
    const b = wsClient.connect(URL, userB);

    const timeout = setTimeout(() => { cleanup(); reject(new Error('testTimeout timed out')); }, 8000);
    const cleanup = () => { clearTimeout(timeout); a.close(); b.close(); };

    a.on('connect', () => a.emit('createRoom'));
    a.on('roomCreated', ({ code }) => b.emit('joinRoom', { code }));
    a.on('matchStart', () => setTimeout(() => b.close(), 200));
    a.on('opponentDisconnected', (payload) => log('A', 'opponentDisconnected', payload));

    a.on('gameOver', (payload) => {
      log('A', 'gameOver after grace expiry', payload);
      cleanup();
      if (payload.winner === userA.uid) {
        log('A', 'PASS - remaining player declared winner');
        resolve();
      } else {
        reject(new Error('unexpected winner: ' + payload.winner));
      }
    });
  });
}

withTestUsers(3, async ([a, b, c]) => {
  await testReconnect(a, b);
  await testStrangerCannotRejoin(a, b, c);
  await testTimeout(a, b);
})
  .then(() => { console.log('ALL DISCONNECT TESTS PASSED'); process.exit(0); })
  .catch((err) => { console.error('TEST FAILED:', err.message); process.exit(1); });
