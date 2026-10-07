require('dotenv').config();

const express = require('express');
const http = require('http');

const { attachWsServer } = require('./net/wsAdapter');
const RoomManager = require('./net/RoomManager');
const { registerSocketHandlers } = require('./net/socketHandlers');
const { createApiRouter } = require('./net/apiRoutes');
const { createAdsRouter } = require('./net/adsRoutes');
const PuzzleShareStore = require('./game/PuzzleShareStore');
const StatsStore = require('./game/StatsStore');
const PlayerStore = require('./game/PlayerStore');
const EconomyStore = require('./game/EconomyStore');
const DailyStore = require('./game/DailyStore');
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

  const app = express();
  const server = http.createServer(app);
  const io = attachWsServer(server, { playerStore });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Public privacy policy (Play listing, Data safety, AdMob consent message).
  const privacyHtml = renderPrivacyPage();
  app.get('/privacy', (_req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(privacyHtml);
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
  app.use('/api', createApiRouter({ puzzleShareStore, statsStore, playerStore, economyStore, dailyStore }));

  const roomManager = new RoomManager();
  registerSocketHandlers(io, roomManager, playerStore, economyStore);

  server.listen(PORT, () => {
    console.log(`Server up and running on port:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
