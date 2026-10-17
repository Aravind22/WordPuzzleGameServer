const express = require('express');
const { requireAuth } = require('../auth/firebaseAuth');
const { sendFeedbackEmail } = require('../feedback/mailer');

const MAX_MESSAGE = 1000;
const MAX_PER_DAY = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

// POST /api/feedback: the in-game "send feedback to the developer" form.
// Stored first, then emailed in the background (the player doesn't wait on
// SMTP). A message is required; the 1-5 star rating is optional (0 = none).
function createFeedbackRouter({ feedbackStore, playerStore }) {
  const router = express.Router();
  router.use(express.json());
  router.use(requireAuth);

  router.post('/', async (req, res) => {
    const body = req.body || {};
    const message = clip(body.message, MAX_MESSAGE);
    if (!message) return res.status(400).json({ error: 'empty-message' });
    const rating = Number.isInteger(body.rating) && body.rating >= 0 && body.rating <= 5 ? body.rating : 0;

    if (await feedbackStore.countSince(req.uid, Date.now() - DAY_MS) >= MAX_PER_DAY) {
      return res.status(429).json({ error: 'too-many' });
    }

    const player = await playerStore.getOrCreate(req.uid).then((r) => r.player).catch(() => null);
    const entry = await feedbackStore.add({
      playerId: req.uid,
      name: player?.name || null,
      rating,
      message,
      appVersion: clip(body.appVersion, 32),
      device: clip(body.device, 128),
      os: clip(body.os, 128),
      playMinutes: Number.isFinite(body.playMinutes) ? Math.round(body.playMinutes) : null,
      puzzles: Number.isInteger(body.puzzles) ? body.puzzles : null,
    });
    res.json({ ok: true });

    sendFeedbackEmail(entry)
      .then((sent) => sent && feedbackStore.markEmailed(entry._id))
      .catch((err) => console.error(`[feedback] email failed for ${entry._id}:`, err.message));
  });

  return router;
}

module.exports = { createFeedbackRouter };
