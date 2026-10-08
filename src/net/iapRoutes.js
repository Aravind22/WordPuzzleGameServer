const express = require('express');
const { OAuth2Client } = require('google-auth-library');

// Google Play real-time developer notifications, pushed by Pub/Sub
// (subscription play-rtdn-push -> https://gs04node.com/api/iap/rtdn). Not a
// game request, so no Firebase token: Pub/Sub's authenticated push signs a
// Google ID token for RTDN_PUSH_SA with audience RTDN_AUDIENCE, checked here.
// Mounted ahead of the token-protected /api router.
const oauth = new OAuth2Client();

async function verifyPush(authorization) {
  const audience = process.env.RTDN_AUDIENCE;
  const expected = process.env.RTDN_PUSH_SA;
  if (!audience || !expected) throw new Error('RTDN_AUDIENCE / RTDN_PUSH_SA not set');
  const token = /^Bearer\s+(.+)$/i.exec(authorization || '')?.[1];
  if (!token) return false;
  const ticket = await oauth.verifyIdToken({ idToken: token, audience });
  const payload = ticket.getPayload();
  return payload?.email === expected && payload.email_verified === true;
}

function createIapRouter({ iapStore, verify = verifyPush }) {
  const router = express.Router();

  router.post('/rtdn', express.json(), async (req, res) => {
    let ok = false;
    try {
      ok = await verify(req.headers.authorization);
    } catch (err) {
      console.warn('[iap] rtdn auth failed:', err.message);
    }
    if (!ok) return res.status(403).json({ error: 'forbidden' });

    let notification;
    try {
      notification = JSON.parse(Buffer.from(req.body?.message?.data || '', 'base64').toString('utf8'));
    } catch {
      return res.status(204).end(); // malformed: ack it, retrying won't help
    }
    try {
      const what = await iapStore.handleNotification(notification);
      console.log(`[iap] rtdn ${req.body?.message?.messageId}: ${what}`);
      res.status(204).end();
    } catch (err) {
      // Non-2xx makes Pub/Sub redeliver later (Google API hiccups etc.).
      console.error('[iap] rtdn handling failed:', err.message);
      res.status(500).json({ error: 'retry' });
    }
  });

  return router;
}

module.exports = { createIapRouter };
