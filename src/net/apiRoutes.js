const express = require('express');

// Plain REST endpoints for solo-mode features (puzzle sharing, global solved
// counter) -- separate concern from the 1v1 WebSocket protocol in
// wsAdapter.js/socketHandlers.js, mounted under /api on the same Express app.
function createApiRouter({ puzzleShareStore, statsStore }) {
  const router = express.Router();
  router.use(express.json());

  router.get('/stats', async (_req, res) => {
    res.json({ totalSolved: await statsStore.getTotalSolved() });
  });

  // Client only calls this the first time a given puzzle id is solved
  // locally (checked against its own PuzzleHistoryStore) -- no server-side
  // dedup, trusting the client the same way RoomManager trusts deviceId.
  router.post('/stats/solved', async (_req, res) => {
    const total = await statsStore.incrementSolved();
    res.json({ totalSolved: total });
  });

  router.post('/puzzles', async (req, res) => {
    const { gridSize, words, placements, sharedByTimeSeconds } = req.body || {};
    if (!gridSize || !Array.isArray(words) || !Array.isArray(placements)) {
      return res.status(400).json({ error: 'invalid-puzzle-data' });
    }
    const record = await puzzleShareStore.create({ gridSize, words, placements, sharedByTimeSeconds });
    res.json({ code: record.code });
  });

  router.get('/puzzles/:code', async (req, res) => {
    const record = await puzzleShareStore.get(req.params.code);
    if (!record) return res.status(404).json({ error: 'puzzle-not-found' });
    res.json({
      gridSize: record.gridSize,
      words: record.words,
      placements: record.placements,
      sharedByTimeSeconds: record.sharedByTimeSeconds,
    });
  });

  return router;
}

module.exports = { createApiRouter };
