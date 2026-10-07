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
const { initFirebase } = require('./auth/firebaseAuth');
const { renderDeleteAccountPage } = require('./web/deleteAccountPage');
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

  const app = express();
  const server = http.createServer(app);
  const io = attachWsServer(server, { playerStore });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Privacy policy (Play listing, AdMob consent message): the page itself is
  // kept on GitHub Pages; this gives it a stable URL on our own domain.
  app.get('/privacy', (_req, res) => {
    res.redirect(302, 'https://aravind22.github.io/TempContactsPrivacyPolicy/wordpuzzle/');
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
  app.use('/api', createApiRouter({ puzzleShareStore, statsStore, playerStore, economyStore }));

  const roomManager = new RoomManager();
  registerSocketHandlers(io, roomManager, playerStore);

  server.listen(PORT, () => {
    console.log(`Server up and running on port:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
