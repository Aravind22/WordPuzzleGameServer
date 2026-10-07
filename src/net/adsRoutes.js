const express = require('express');
const { verifySsv } = require('../ads/ssv');

// Called by AdMob, not the game, so no Firebase token: the request is
// trusted by its Google signature instead. Set on the rewarded ad unit in
// AdMob as https://gs04node.com/api/ads/ssv. Mounted ahead of the
// token-protected /api router.
function createAdsRouter({ economyStore, verify = verifySsv }) {
  const router = express.Router();

  router.get('/ssv', async (req, res) => {
    const rawQuery = req.originalUrl.split('?')[1] || '';
    let valid;
    try {
      valid = await verify(rawQuery);
    } catch (err) {
      console.error('[ads] ssv verification error:', err.message);
      return res.status(500).json({ error: 'verification-unavailable' });
    }
    if (!valid) return res.status(403).json({ error: 'bad-signature' });

    const q = new URLSearchParams(rawQuery);
    // AdMob's "verify URL" check carries no user/transaction: 200, no-op.
    const recorded = await economyStore.recordAdReward({
      playerId: q.get('user_id'),
      transactionId: q.get('transaction_id'),
      customData: q.get('custom_data'),
      adUnit: q.get('ad_unit'),
      rewardItem: q.get('reward_item'),
      rewardAmount: Number(q.get('reward_amount')) || 0,
    });
    res.json({ ok: true, recorded });
  });

  return router;
}

module.exports = { createAdsRouter };
