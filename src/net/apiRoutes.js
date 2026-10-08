const express = require('express');
const { requireAuth, verifyIdToken, hasAdminCredentials, deleteFirebaseUser } = require('../auth/firebaseAuth');
const { clientConfig, AD_SSV_WAIT_MS, monetizationOn } = require('../game/economy');
const { utcDay, previousDay } = require('../game/utcDay');
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/; // a UTC day, 'YYYY-MM-DD'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SPEND_ITEMS = ['continue', 'replay', 'hint', 'hint-pack', 'hint-pack-10'];
const PRODUCT_PATTERN = /^[a-z0-9_.]{1,64}$/;
const NEEDS_PUZZLE = ['continue', 'replay', 'hint'];

// Wallet responses: balances plus the gem price paid (402s carry which
// balance was short).
function walletResponse(result) {
  const { gems, hints, cost, error, short } = result;
  return { gems, hints, price: cost?.gems || 0, ...(error ? { error, short } : {}) };
}

// Plain REST endpoints for solo-mode features and the player profile --
// separate concern from the 1v1 WebSocket protocol in
// wsAdapter.js/socketHandlers.js, mounted under /api on the same Express app.
// Every route requires a Firebase ID token (Authorization: Bearer ...).
// An ad claim racing the SSV callback for the same key can find it
// mid-write ("in-progress"): give it a moment and ask again.
async function retryInProgress(claim) {
  let result = await claim();
  for (let i = 0; i < 5 && result.error === 'in-progress'; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    result = await claim();
  }
  return result;
}

function createApiRouter({ puzzleShareStore, statsStore, playerStore, economyStore, dailyStore, iapStore }) {
  const router = express.Router();
  router.use(express.json());
  router.use(requireAuth);

  // Everything the client shows about the player, wallet and prices included.
  async function profile(player, extra) {
    const { gems, hints } = await economyStore.ensureWallet(player.playerId);
    const loginGift = await economyStore.loginGift(player.playerId);
    const adsToday = await economyStore.adsToday(player.playerId);
    const store = await iapStore.status(player.playerId);
    return { ...player, gems, hints, loginGift, adsToday, ...store, ...extra, serverNow: Date.now(), config: { ...clientConfig, monetization: monetizationOn() } };
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
    await iapStore.anonymize(req.uid);
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
    await iapStore.mergePurchases(guestId, req.uid);
    const { player, merged } = await playerStore.mergeGuestInto(req.uid, guestId);
    res.json(await profile(player, { merged, isNew: false }));
  });

  // Spends on one use of a powerup, priced by the server:
  //   { item: 'continue', attemptId, puzzleId, index, key }  +30s on Time's Up (gems)
  //   { item: 'replay', puzzleId, key }                      History replay (gems)
  //   { item: 'hint', puzzleId, key }                        reveal one letter (1 hint)
  //   { item: 'hint-pack', key }                             MORE HINTS / Store (gems -> hints)
  //   { item: 'hint-pack-10', key }                          Store (gems -> 10 hints)
  // key makes a retry idempotent (same key never charges twice). The client
  // applies the effect only after this succeeds.
  //   200 { gems, hints, price } | 402 { error: 'insufficient', short, gems, hints, price }
  router.post('/economy/spend', async (req, res) => {
    const { item, attemptId, puzzleId, key } = req.body || {};
    const index = Number.isInteger(req.body?.index) ? req.body.index : 0;
    if (!SPEND_ITEMS.includes(item) || !ID_PATTERN.test(key || '')
      || ((NEEDS_PUZZLE.includes(item) || puzzleId) && !ID_PATTERN.test(puzzleId || ''))
      || (item === 'continue' && !ID_PATTERN.test(attemptId || '')) || index < 0 || index > 100) {
      return res.status(400).json({ error: 'invalid-spend' });
    }

    await economyStore.ensureWallet(req.uid);
    const { cost, grant } = await economyStore.priceFor(req.uid, { item, attemptId, index });
    const context = item === 'continue' ? { attemptId, puzzleId, index } : { puzzleId };
    const result = await economyStore.apply(req.uid, { item, key, cost, grant, context });
    if (result.error === 'insufficient') return res.status(402).json(walletResponse(result));
    if (result.error) return res.status(409).json(walletResponse(result));
    res.json(walletResponse(result));
  });

  // MORE HINTS > WATCH AD finished: +1 hint, capped per day. key is the
  // custom_data the ad carried ("hint:<key>"); unless wait is false (test
  // ad units, which never call SSV) the claim first waits for AdMob's SSV
  // callback to grant it, then falls back to granting it unverified.
  //   { key, wait }  ->  200 { gems, hints } | 429 { error: 'ad-cap', gems, hints }
  router.post('/economy/ad-hint', async (req, res) => {
    const key = req.body?.key;
    if (!ID_PATTERN.test(key || '')) return res.status(400).json({ error: 'invalid-claim' });
    await economyStore.ensureWallet(req.uid);
    if (req.body?.wait !== false) await economyStore.waitForEntry(req.uid, `ad-hint:${key}`, AD_SSV_WAIT_MS);
    const result = await retryInProgress(() => economyStore.claimAdHint(req.uid, key));
    if (result.error === 'ad-cap') return res.status(429).json(walletResponse(result));
    if (result.error) return res.status(409).json(walletResponse(result));
    res.json(walletResponse(result));
  });

  // Time's Up > WATCH AD finished: may this attempt take its +30s?
  //   { attemptId, puzzleId }  ->  200 { gems, hints }
  //   | 429 { error: 'ad-cap' }   today's ad continues are used up
  //   | 409 { error: 'ad-used' }  not the attempt's first continue
  router.post('/economy/ad-continue', async (req, res) => {
    const { attemptId, puzzleId } = req.body || {};
    if (!ID_PATTERN.test(attemptId || '') || (puzzleId && !ID_PATTERN.test(puzzleId))) {
      return res.status(400).json({ error: 'invalid-claim' });
    }
    await economyStore.ensureWallet(req.uid);
    const result = await retryInProgress(() => economyStore.claimAdContinue(req.uid, attemptId, puzzleId || undefined));
    if (result.error === 'ad-cap') return res.status(429).json(walletResponse(result));
    if (result.error) return res.status(409).json(walletResponse(result));
    res.json(walletResponse(result));
  });

  // Store > FREE GEMS finished: same SSV-first claim as ad-hint ("gems:<key>").
  //   { key, wait }  ->  200 { gems, hints } | 429 { error: 'ad-cap', gems, hints }
  router.post('/economy/ad-gems', async (req, res) => {
    const key = req.body?.key;
    if (!ID_PATTERN.test(key || '')) return res.status(400).json({ error: 'invalid-claim' });
    await economyStore.ensureWallet(req.uid);
    if (req.body?.wait !== false) await economyStore.waitForEntry(req.uid, `ad-gems:${key}`, AD_SSV_WAIT_MS);
    const result = await retryInProgress(() => economyStore.claimAdGems(req.uid, key));
    if (result.error === 'ad-cap') return res.status(429).json(walletResponse(result));
    if (result.error) return res.status(409).json(walletResponse(result));
    res.json(walletResponse(result));
  });

  // ------------------------------------------------------------ Store

  // A Google Play purchase to credit: { productId, token }. The client
  // confirms (consumes/acknowledges) it with Play only after a 200.
  //   200 { credited|pending, gems, hints, removeAds, starterAvailable, pass, iapAccountId }
  //   400 { error: 'unknown-product' | 'invalid-token' | 'wrong-account' | 'canceled' | 'other-player' }
  router.post('/iap/verify', async (req, res) => {
    const { productId, token } = req.body || {};
    if (!PRODUCT_PATTERN.test(productId || '') || typeof token !== 'string' || token.length < 8 || token.length > 512) {
      return res.status(400).json({ error: 'invalid-purchase' });
    }
    await playerStore.getOrCreate(req.uid);
    let result;
    try {
      result = await iapStore.verify(req.uid, { productId, token });
    } catch (err) {
      console.error('[iap] verify failed:', err.message);
      return res.status(503).json({ error: 'verify-unavailable' }); // client retries later; purchase stays unconfirmed
    }
    res.status(result.error ? 400 : 200).json(result);
  });

  // Forest Pass daily bonus (once per UTC day while active).
  //   200 { gems, hints, grant } | 409 { error: 'no-pass', gems, hints }
  router.post('/pass/claim', async (req, res) => {
    await economyStore.ensureWallet(req.uid);
    const result = await iapStore.claimPass(req.uid);
    res.status(result.error ? 409 : 200).json({ gems: result.gems, hints: result.hints, grant: result.grant || {}, ...(result.error ? { error: result.error } : {}) });
  });

  // ------------------------------------------------------- Login Gift

  // First launch of each UTC day: the next step of the 7-day cycle.
  //   200 { gems, hints, claimedToday, index, amount } | 409 { error: 'claimed', ... }
  router.post('/login-gift/claim', async (req, res) => {
    await economyStore.ensureWallet(req.uid);
    const result = await economyStore.claimLoginGift(req.uid);
    res.status(result.error ? 409 : 200).json({
      gems: result.gems, hints: result.hints, claimedToday: result.claimedToday, index: result.index,
      amount: result.amount || 0, ...(result.error ? { error: result.error } : {}),
    });
  });

  // ----------------------------------------------------- Daily Puzzle

  // Today's state for the home tile (no puzzle) + any unseen top-3 prize.
  router.get('/daily', async (req, res) => {
    res.json(await dailyStore.status(req.uid));
  });

  // Starts (or resumes) today's attempt; the clock runs from the first call.
  router.post('/daily/start', async (req, res) => {
    res.json(await dailyStore.start(req.uid));
  });

  // One swipe: { day, cells: [{ row, col }, ...] }. The server checks it
  // against the hidden placements and timestamps each word (see DailyStore).
  //   200 { word|null, cells, foundCount, solved, timeMs?, rank?, players? } | 400/409 { error }
  router.post('/daily/word', async (req, res) => {
    const { day, cells } = req.body || {};
    if (!DAY_PATTERN.test(day || '') || !Array.isArray(cells)) return res.status(400).json({ error: 'invalid-word' });
    const result = await dailyStore.submitWord(req.uid, { day, cells });
    if (result.error) return res.status(result.error === 'invalid-cells' ? 400 : 409).json(result);
    res.json(result);
  });

  // ?day=today | yesterday | YYYY-MM-DD
  router.get('/daily/leaderboard', async (req, res) => {
    const today = utcDay();
    const asked = req.query.day || 'today';
    const day = asked === 'today' ? today : asked === 'yesterday' ? previousDay(today) : asked;
    if (!DAY_PATTERN.test(day)) return res.status(400).json({ error: 'invalid-day' });
    res.json(await dailyStore.leaderboard(req.uid, day));
  });

  router.post('/daily/prize-seen', async (req, res) => {
    const day = req.body?.day;
    if (!DAY_PATTERN.test(day || '')) return res.status(400).json({ error: 'invalid-day' });
    await dailyStore.markPrizeSeen(req.uid, day);
    res.json({ ok: true });
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
