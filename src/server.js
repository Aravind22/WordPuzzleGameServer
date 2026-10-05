require('dotenv').config();

const express = require('express');
const http = require('http');

const { attachWsServer } = require('./net/wsAdapter');
const RoomManager = require('./net/RoomManager');
const { registerSocketHandlers } = require('./net/socketHandlers');
const { createApiRouter } = require('./net/apiRoutes');
const PuzzleShareStore = require('./game/PuzzleShareStore');
const StatsStore = require('./game/StatsStore');
const PlayerStore = require('./game/PlayerStore');
const { initFirebase } = require('./auth/firebaseAuth');
const { connectDb } = require('./db');

const PORT = process.env.PORT || 6969;

async function main() {
  initFirebase();
  const db = await connectDb();

  const puzzleShareStore = new PuzzleShareStore(db);
  const statsStore = new StatsStore(db);
  const playerStore = new PlayerStore(db);

  const app = express();
  const server = http.createServer(app);
  const io = attachWsServer(server, { playerStore });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api', createApiRouter({ puzzleShareStore, statsStore, playerStore }));

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
