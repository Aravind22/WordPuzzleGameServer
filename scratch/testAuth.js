// Verifies Firebase-token auth on REST + WebSocket and the /me profile
// endpoints. Run against a LOCAL server only, on a throwaway database:
//   MONGO_DB_NAME=wordpuzzle_test node src/server.js
//   node scratch/testAuth.js
const { withTestUsers } = require('./testUsers');
const wsClient = require('./wsClient');

const HOST = 'localhost:6969';
const BASE = `http://${HOST}/api`;

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failures++;
}

function api(path, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

// Resolves 'open' or 'rejected:<status>' for a WS handshake attempt.
function wsHandshake(user) {
  return new Promise((resolve) => {
    const client = wsClient.connect(`ws://${HOST}`, user);
    const timer = setTimeout(() => { client.close(); resolve('timeout'); }, 5000);
    client.on('connect', () => { clearTimeout(timer); client.close(); resolve('open'); });
    client.on('rejected', (status) => { clearTimeout(timer); resolve(`rejected:${status}`); });
  });
}

async function main() {
  const health = await fetch(`http://${HOST}/health`);
  check('/health stays public', health.status === 200);

  check('GET /me without token -> 401', (await api('/me')).status === 401);
  check('GET /me with garbage token -> 401', (await api('/me', { token: 'not-a-jwt' })).status === 401);
  const tampered = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln';
  check('GET /me with forged JWT -> 401', (await api('/me', { token: tampered })).status === 401);
  check('GET /stats without token -> 401', (await api('/stats')).status === 401);
  check('POST /puzzles without token -> 401', (await api('/puzzles', { method: 'POST', body: {} })).status === 401);
  check('old GET /players/:id route removed (401 before routing)', (await api('/players/abc')).status === 401);

  check('WS without token rejected', (await wsHandshake(null)) === 'rejected:401');
  check('WS with garbage token rejected', (await wsHandshake({ idToken: 'nope' })) === 'rejected:401');

  await withTestUsers(2, async ([u1, u2]) => {
    const first = await api('/me', { token: u1.idToken });
    const me1 = await first.json();
    check('GET /me creates player', first.status === 200 && me1.isNew === true, JSON.stringify(me1));
    check('playerId is the Firebase uid', me1.playerId === u1.uid);
    check('default name PLAYER-<last4 of uid>', me1.name === `PLAYER-${u1.uid.slice(-4).toUpperCase()}`, me1.name);
    check('new player starts at 0 trophies / arena 1', me1.trophies === 0 && me1.arena === 1);
    check('serverNow is a recent timestamp', Math.abs(me1.serverNow - Date.now()) < 60000);

    const again = await (await api('/me', { token: u1.idToken })).json();
    check('second GET /me is not new', again.isNew === false && again.playerId === u1.uid);

    const renamed = await api('/me', { token: u1.idToken, method: 'PATCH', body: { name: '   Ajay    Kumar  ' } });
    const renamedJson = await renamed.json();
    check('PATCH /me trims + collapses whitespace', renamed.status === 200 && renamedJson.name === 'Ajay Kumar', renamedJson.name);
    const persisted = await (await api('/me', { token: u1.idToken })).json();
    check('renamed name persists', persisted.name === 'Ajay Kumar');

    for (const [label, name] of [['empty', ''], ['whitespace only', '    '], ['21 chars', 'x'.repeat(21)], ['number', 123], ['missing', undefined], ['control char', 'bad\u0007name']]) {
      const res = await api('/me', { token: u1.idToken, method: 'PATCH', body: { name } });
      check(`PATCH /me rejects ${label} name -> 400`, res.status === 400);
    }
    check('20-char name accepted', (await api('/me', { token: u1.idToken, method: 'PATCH', body: { name: 'y'.repeat(20) } })).status === 200);

    const other = await (await api('/me', { token: u2.idToken })).json();
    check('second user is a separate player', other.playerId === u2.uid && other.playerId !== u1.uid && other.isNew === true);

    check('WS with valid token opens', (await wsHandshake(u1)) === 'open');
  });

  console.log(failures === 0 ? '\nALL AUTH TESTS PASSED' : `\n${failures} AUTH TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
