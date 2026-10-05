// Verification for the solo-mode REST endpoints (puzzle sharing, global
// solved counter), now behind Firebase auth. Run against a LOCAL server on
// a throwaway database:
//   MONGO_DB_NAME=wordpuzzle_test node src/server.js
//   node scratch/testApi.js
const { withTestUsers } = require('./testUsers');

const BASE = 'http://localhost:6969/api';

async function main() {
  await withTestUsers(1, async ([user]) => {
    const auth = { Authorization: `Bearer ${user.idToken}` };
    const json = { ...auth, 'Content-Type': 'application/json' };

    const statsBefore = await (await fetch(`${BASE}/stats`, { headers: auth })).json();
    console.log('stats before:', statsBefore);

    const puzzlePayload = {
      gridSize: 10,
      words: ['CAT', 'DOG'],
      placements: [
        { word: 'CAT', cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }, { row: 0, col: 2 }] },
        { word: 'DOG', cells: [{ row: 1, col: 0 }, { row: 2, col: 0 }, { row: 3, col: 0 }] },
      ],
      sharedByTimeSeconds: 42.5,
    };

    const createRes = await fetch(`${BASE}/puzzles`, { method: 'POST', headers: json, body: JSON.stringify(puzzlePayload) });
    const { code } = await createRes.json();
    console.log('created puzzle with code:', code);
    if (!code || code.length !== 6) throw new Error('FAIL: expected a 6-char code');

    const badRes = await fetch(`${BASE}/puzzles`, { method: 'POST', headers: json, body: JSON.stringify({ gridSize: 10 }) });
    if (badRes.status !== 400) throw new Error('FAIL: expected 400 for invalid puzzle data');
    console.log('invalid puzzle data correctly 400s');

    const fetched = await (await fetch(`${BASE}/puzzles/${code}`, { headers: auth })).json();
    console.log('fetched puzzle:', fetched);
    if (JSON.stringify(fetched.words) !== JSON.stringify(puzzlePayload.words)) throw new Error('FAIL: words mismatch');
    if (fetched.sharedByTimeSeconds !== 42.5) throw new Error('FAIL: sharedByTimeSeconds mismatch');

    const notFoundRes = await fetch(`${BASE}/puzzles/ZZZZZZ`, { headers: auth });
    if (notFoundRes.status !== 404) throw new Error('FAIL: expected 404 for unknown code');
    console.log('unknown code correctly 404s');

    const solvedJson = await (await fetch(`${BASE}/stats/solved`, { method: 'POST', headers: auth })).json();
    console.log('after solved increment:', solvedJson);
    if (solvedJson.totalSolved !== statsBefore.totalSolved + 1) throw new Error('FAIL: counter did not increment by 1');
  });

  console.log('PASS - all API checks passed');
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
