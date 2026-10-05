// POST /api/accounts/merge (client conflict "Restore"). Run against a LOCAL
// server on a throwaway database:
//   MONGO_DB_NAME=wordpuzzle_test node src/server.js
//   MONGO_DB_NAME=wordpuzzle_test node scratch/testMerge.js
require('dotenv').config({ quiet: true });
const { MongoClient } = require('mongodb');
const { withTestUsers } = require('./testUsers');

const BASE = 'http://localhost:6969/api';

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

const merge = (savedToken, guestToken) => api('/accounts/merge', { token: savedToken, method: 'POST', body: { guestToken } });

async function main() {
  const mongo = new MongoClient(process.env.MONGO_CONN_STRING);
  await mongo.connect();
  const players = mongo.db(process.env.MONGO_DB_NAME || 'wordpuzzle_test').collection('players');

  try {
    await withTestUsers(3, async ([saved, guest, fresh]) => {
      await api('/me', { token: saved.idToken, method: 'PATCH', body: { name: 'Saved Hero' } });
      await api('/me', { token: guest.idToken, method: 'PATCH', body: { name: 'Device Guest' } });

      check('merge without auth -> 401', (await api('/accounts/merge', { method: 'POST', body: { guestToken: guest.idToken } })).status === 401);
      check('merge without guestToken -> 400', (await merge(saved.idToken, undefined)).status === 400);
      check('merge with garbage guestToken -> 400', (await merge(saved.idToken, 'garbage')).status === 400);
      const self = await merge(saved.idToken, saved.idToken);
      check('merge into itself -> 400 same-account', self.status === 400 && (await self.json()).error === 'same-account');
      check('guest record untouched by rejected merges', !!(await players.findOne({ _id: guest.uid })));

      const res = await merge(saved.idToken, guest.idToken);
      const body = await res.json();
      check('valid merge -> 200, merged', res.status === 200 && body.merged === true, JSON.stringify(body));
      check('response is the SAVED account profile', body.playerId === saved.uid && body.name === 'Saved Hero');
      check('guest player record deleted', !(await players.findOne({ _id: guest.uid })));
      const savedDoc = await players.findOne({ _id: saved.uid });
      check('saved account keeps an audit of the merge', savedDoc.mergedFrom?.length === 1 && savedDoc.mergedFrom[0].playerId === guest.uid);
      check('saved account /me unchanged', (await (await api('/me', { token: saved.idToken })).json()).name === 'Saved Hero');

      const noRecord = await (await merge(saved.idToken, fresh.idToken)).json();
      check('guest that never called /me -> merged:false, still ok', noRecord.merged === false && noRecord.playerId === saved.uid);
    });
  } finally {
    await mongo.close();
  }

  console.log(failures === 0 ? '\nALL MERGE TESTS PASSED' : `\n${failures} MERGE TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
