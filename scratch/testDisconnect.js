// Manual verification for the disconnect/reconnect grace-period path (PLAN.md
// build order step 9). Exercises both branches:
//   1. opponent disconnects, rejoins in time -> opponentReconnected
//   2. opponent disconnects, never rejoins -> remaining player wins on gameOver
//
// Run with a short grace period so the timeout branch doesn't take 20s:
//   DISCONNECT_GRACE_MS=1500 node src/server.js
//   node scratch/testDisconnect.js
const wsClient = require('./wsClient');

const URL = 'ws://localhost:6969';

function connect(deviceId, name) {
  return wsClient.connect(URL, deviceId, name);
}

function log(who, ...args) {
  console.log(`[${who}]`, ...args);
}

function testReconnect() {
  return new Promise((resolve, reject) => {
    const a = connect('recon-A', 'Alice');
    const b = connect('recon-B', 'Bob');
    let code = null;
    let b2 = null;

    const timeout = setTimeout(() => reject(new Error('testReconnect timed out')), 8000);
    const cleanup = () => { clearTimeout(timeout); a.close(); b.close(); b2?.close(); };

    a.on('connect', () => a.emit('createRoom'));
    a.on('roomCreated', ({ code: c }) => { code = c; b.emit('joinRoom', { code: c }); });

    a.on('matchStart', () => {
      // Once the match is live, drop B's connection to trigger opponentDisconnected.
      setTimeout(() => b.close(), 200);
    });

    a.on('opponentDisconnected', (payload) => {
      log('A', 'opponentDisconnected', payload);
      b2 = connect('recon-B', 'Bob');
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

function testTimeout() {
  return new Promise((resolve, reject) => {
    const a = connect('timeout-A', 'Alice2');
    const b = connect('timeout-B', 'Bob2');

    const timeout = setTimeout(() => reject(new Error('testTimeout timed out')), 8000);
    const cleanup = () => { clearTimeout(timeout); a.close(); b.close(); };

    a.on('connect', () => a.emit('createRoom'));
    a.on('roomCreated', ({ code }) => b.emit('joinRoom', { code }));

    a.on('matchStart', () => {
      setTimeout(() => b.close(), 200);
    });

    a.on('opponentDisconnected', (payload) => log('A', 'opponentDisconnected', payload));

    a.on('gameOver', (payload) => {
      log('A', 'gameOver after grace expiry', payload);
      cleanup();
      if (payload.winner === 'timeout-A') {
        log('A', 'PASS - remaining player declared winner');
        resolve();
      } else {
        reject(new Error('unexpected winner: ' + payload.winner));
      }
    });
  });
}

(async () => {
  try {
    await testReconnect();
    await testTimeout();
    console.log('ALL DISCONNECT TESTS PASSED');
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILED:', err.message);
    process.exit(1);
  }
})();
