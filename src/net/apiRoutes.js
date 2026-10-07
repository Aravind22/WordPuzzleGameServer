const express = require('express');
const { requireAuth, verifyIdToken, hasAdminCredentials, deleteFirebaseUser } = require('../auth/firebaseAuth');
const { clientConfig } = require('../game/economy');

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SPEND_ITEMS = ['continue', 'replay'];

// Plain REST endpoints for solo-mode features and the player profile --
// separate concern from the 1v1 WebSocket protocol in
// wsAdapter.js/socketHandlers.js, mounted under /api on the same Express app.
// Every route requires a Firebase ID token (Authorization: Bearer ...).
function createApiRouter({ puzzleShareStore, statsStore, playerStore, economyStore }) {
  const router = express.Router();
  router.use(express.json());
  router.use(requireAuth);

  // Everything the client shows about the player, wallet and prices included.
  async function profile(player, extra) {
    const gems = await economyStore.ensureWallet(player.playerId);
    return { ...player, gems, ...extra, serverNow: Date.now(), config: clientConfig };
  }

  // Called by the client on every launch once signed in: creates the player
  // on first sight and returns everything the client shows about them.
  router.get('/me', async (req, res) => {
    const { player, isNew } = await playerStore.getOrCreate(req.uid);
    res.json(await profile(player, { isNew }));
  });

  router.patch('/me', async (req, res) => {
    const player = await playerStore.setName(req.uid, req.body?.name);
    if (!player) return res.status(400).json({ error: 'invalid-name' });
    res.json(await profile(player, { isNew: false }));
  });

  // Account deletion (Play policy: the in-app button and the web request
  // page both call this). Server data first, then the Firebase user; a
  // failure on the second step returns 500 so the caller can retry (both
  // steps are idempotent).
  router.delete('/me', async (req, res) => {
    if (!hasAdminCredentials()) return res.status(503).json({ error: 'deletion-unavailable' });
    const hadPlayer = await playerStore.deletePlayer(req.uid);
    await economyStore.anonymize(req.uid);
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
    res.json(await profile(player, { merged, isNew: false }));
  });

  // Spends gems on one use of a powerup, priced by the server:
  //   { item: 'continue', attemptId, puzzleId, index, key }  +30s on Time's Up
  //   { item: 'replay', puzzleId, key }                      History replay
  // key makes a retry idempotent (same key never charges twice). The client
  // applies the effect only after this succeeds.
  //   200 { gems, price } | 402 { error: 'insufficient-gems', gems, price }
  router.post('/economy/spend', async (req, res) => {
    const { item, attemptId, puzzleId, key } = req.body || {};
    const index = Number.isInteger(req.body?.index) ? req.body.index : 0;
    if (!SPEND_ITEMS.includes(item) || !ID_PATTERN.test(puzzleId || '') || !ID_PATTERN.test(key || '')
      || (item === 'continue' && !ID_PATTERN.test(attemptId || '')) || index < 0 || index > 100) {
      return res.status(400).json({ error: 'invalid-spend' });
    }

    await economyStore.ensureWallet(req.uid);
    const price = await economyStore.priceFor(req.uid, { item, attemptId, index });
    const context = item === 'continue' ? { attemptId, puzzleId, index } : { puzzleId };
    const result = await economyStore.spend(req.uid, { item, key, price, context });
    if (result.error === 'insufficient-gems') return res.status(402).json(result);
    if (result.error) return res.status(409).json(result);
    res.json(result);
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
