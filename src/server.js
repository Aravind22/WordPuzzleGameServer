require('dotenv').config();

const express = require('express');
const http = require('http');

const { attachWsServer } = require('./net/wsAdapter');
const RoomManager = require('./net/RoomManager');
const { registerSocketHandlers } = require('./net/socketHandlers');
const { createApiRouter } = require('./net/apiRoutes');
const { createAdsRouter } = require('./net/adsRoutes');
const { createIapRouter } = require('./net/iapRoutes');
const { createProcessDefRouter } = require('./net/processDefRoutes');
const PuzzleShareStore = require('./game/PuzzleShareStore');
const StatsStore = require('./game/StatsStore');
const PlayerStore = require('./game/PlayerStore');
const EconomyStore = require('./game/EconomyStore');
const DailyStore = require('./game/DailyStore');
const IapStore = require('./game/IapStore');
const { initFirebase } = require('./auth/firebaseAuth');
const { renderDeleteAccountPage } = require('./web/deleteAccountPage');
const { renderPrivacyPage } = require('./web/privacyPage');
const { connectDb } = require('./db');

const PORT = process.env.PORT || 6969;

async function main() {
  initFirebase();
  const db = await connectDb();

  const puzzleShareStore = new PuzzleShareStore(db);
  const statsStore = new StatsStore(db);
  const playerStore = new PlayerStore(db);
  const economyStore = new EconomyStore(db);
  await economyStore.init();
  const dailyStore = new DailyStore(db, { economyStore, playerStore });
  await dailyStore.init();
  dailyStore.scheduleFinalizer(); // closes each UTC day and pays the top 3
  const iapStore = new IapStore(db, { economyStore });
  await iapStore.init();
  if (process.env.IAP_ALLOW_FAKE === 'true') console.warn('[iap] IAP_ALLOW_FAKE=true: fake purchase tokens accepted (local testing only!)');

  const app = express();
  // Reverse-proxy hops in front of Node (e.g. 1 for nginx), so req.ip and
  // req.secure reflect the real client. processDef needs it for HTTPS-only
  // access and per-IP lockout.
  if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
  }
  const server = http.createServer(app);
  const io = attachWsServer(server, { playerStore });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Public privacy policy (Play listing, Data safety, AdMob consent message).
  const privacyHtml = renderPrivacyPage();
  app.get('/privacy', (_req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(privacyHtml);
  });

  // app-ads.txt (IAB) at the domain root: AdMob reads it from the Play
  // listing's developer website to verify our app's ad inventory. One line
  // per authorised seller; add ad networks here if mediation is added.
  const appAdsTxt = 'google.com, pub-1156545142489742, DIRECT, f08c47fec0942fa0\n';
  app.get('/app-ads.txt', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('text/plain').send(appAdsTxt);
  });

  // Public account-deletion request page (Play Data safety "delete account"
  // URL). FIREBASE_API_KEY is the app's public web API key; SUPPORT_EMAIL is
  // shown for players who can't sign in with Google.
  const deleteAccountHtml = renderDeleteAccountPage({
    apiKey: process.env.FIREBASE_API_KEY,
    projectId: process.env.FIREBASE_PROJECT_ID,
    supportEmail: process.env.SUPPORT_EMAIL,
  });
  app.get('/delete-account', (_req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(deleteAccountHtml);
  });

  app.use('/api/ads', createAdsRouter({ economyStore }));
  app.use('/api/iap', createIapRouter({ iapStore }));
  app.use('/api', createApiRouter({ puzzleShareStore, statsStore, playerStore, economyStore, dailyStore, iapStore }));

  const roomManager = new RoomManager();
  registerSocketHandlers(io, roomManager, playerStore, economyStore);

  // Private metrics dashboard; not mounted at all without PROCESS_DEF_PASSWORD.
  const processDefRouter = createProcessDefRouter({ io, roomManager, playerStore, db });
  if (processDefRouter) app.use('/processDef', processDefRouter);

  server.listen(PORT, () => {
    console.log(`Server up and running on port:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
