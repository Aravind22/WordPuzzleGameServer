const express = require('express');
const { requireAuth, verifyIdToken, hasAdminCredentials, deleteFirebaseUser } = require('../auth/firebaseAuth');

// Plain REST endpoints for solo-mode features and the player profile --
// separate concern from the 1v1 WebSocket protocol in
// wsAdapter.js/socketHandlers.js, mounted under /api on the same Express app.
// Every route requires a Firebase ID token (Authorization: Bearer ...).
function createApiRouter({ puzzleShareStore, statsStore, playerStore }) {
  const router = express.Router();
  router.use(express.json());
  router.use(requireAuth);

  // Called by the client on every launch once signed in: creates the player
  // on first sight and returns everything the client shows about them.
  router.get('/me', async (req, res) => {
    const { player, isNew } = await playerStore.getOrCreate(req.uid);
    res.json({ ...player, isNew, serverNow: Date.now() });
  });

  router.patch('/me', async (req, res) => {
    const player = await playerStore.setName(req.uid, req.body?.name);
    if (!player) return res.status(400).json({ error: 'invalid-name' });
    res.json(player);
  });

  // Account deletion (Play policy: the in-app button and the web request
  // page both call this). Server data first, then the Firebase user; a
  // failure on the second step returns 500 so the caller can retry (both
  // steps are idempotent).
  router.delete('/me', async (req, res) => {
    if (!hasAdminCredentials()) return res.status(503).json({ error: 'deletion-unavailable' });
    const hadPlayer = await playerStore.deletePlayer(req.uid);
    try {
      await deleteFirebaseUser(req.uid);
    } catch (err) {
      console.error(`[account] firebase delete failed for ${req.uid}:`, err.message);
      return res.status(500).json({ error: 'delete-failed' });
    }
    console.log(`[account] deleted ${req.uid} (player record: ${hadPlayer})`);
    res.json({ deleted: true });
  });

  // Conflict "Restore": the caller authenticates as the SAVED account and
  // proves ownership of the guest with its ID token in the body, so neither
  // account can be merged into the other without holding both.
  router.post('/accounts/merge', async (req, res) => {
    let guestId;
    try {
      guestId = await verifyIdToken(req.body?.guestToken);
    } catch {
      return res.status(400).json({ error: 'invalid-guest-token' });
    }
    if (guestId === req.uid) return res.status(400).json({ error: 'same-account' });
    const { player, merged } = await playerStore.mergeGuestInto(req.uid, guestId);
    res.json({ ...player, merged, isNew: false, serverNow: Date.now() });
  });

  router.get('/stats', async (_req, res) => {
    res.json({ totalSolved: await statsStore.getTotalSolved() });
  });

  // Client only calls this the first time a given puzzle id is solved
  // locally (checked against its own PuzzleHistoryStore) -- no server-side
  // dedup yet.
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
