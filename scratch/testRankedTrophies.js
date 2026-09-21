// Local-only verification: two fake clients queue for ranked Quick Match,
// get paired by the ticking matchmaker, then one leaves mid-match to
// trigger the forfeit path -- confirms trophy application + the
// trophyChanges gameOver payload over the real WebSocket wire (not just the
// isolated unit tests already run against RoomManager/TrophyStore directly).
// Run against a LOCAL server only (node src/server.js on :6969) -- never
// point URL at the live gs04node.com deployment.
const wsClient = require('./wsClient');

const URL = 'ws://localhost:6969';
const idA = `ranked-test-a-${Date.now()}`;
const idB = `ranked-test-b-${Date.now()}`;
const a = wsClient.connect(URL, idA, 'RankedTestA');
const b = wsClient.connect(URL, idB, 'RankedTestB');

let aReady = false;
let bReady = false;

const timeout = setTimeout(() => {
  console.error('FAIL: did not complete within 10s');
  process.exit(1);
}, 10000);

function maybeFindMatch() {
  if (aReady && bReady) {
    a.emit('findMatch', {});
    b.emit('findMatch', {});
  }
}

a.on('connect', () => { aReady = true; maybeFindMatch(); });
b.on('connect', () => { bReady = true; maybeFindMatch(); });

let matchStartCount = 0;
a.on('matchStart', () => {
  matchStartCount++;
  console.log('A got matchStart');
  // Give B a moment to also receive matchStart, then A leaves to trigger the forfeit/trophy path.
  setTimeout(() => a.emit('leaveRoom', {}), 300);
});
b.on('matchStart', () => {
  matchStartCount++;
  console.log('B got matchStart');
});

b.on('gameOver', (payload) => {
  clearTimeout(timeout);
  console.log('B received gameOver:', JSON.stringify(payload));
  const winnerEntry = payload.trophyChanges?.find((t) => t.deviceId === idB);
  const loserEntry = payload.trophyChanges?.find((t) => t.deviceId === idA);
  // Loser's delta is only exactly -15 if they started with >= 15 trophies --
  // fresh test devices start at 0, where it's correctly clamped to 0. Only
  // assert the winner's fixed +30 and that a loser entry with a non-positive
  // delta exists; check delta/trophies match by eye in the logged payload
  // above for the clamping case specifically.
  const ok = payload.winner === idB
    && winnerEntry?.delta === 30
    && loserEntry != null && loserEntry.delta <= 0
    && matchStartCount === 2;
  console.log(ok ? 'PASS: ranked forfeit trophy flow correct' : 'FAIL: unexpected payload/state');
  a.close();
  b.close();
  process.exit(ok ? 0 : 1);
});

a.ws.on('error', (err) => { clearTimeout(timeout); console.error('A ws error:', err.message); process.exit(1); });
b.ws.on('error', (err) => { clearTimeout(timeout); console.error('B ws error:', err.message); process.exit(1); });
