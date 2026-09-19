require('dotenv').config();

const express = require('express');
const http = require('http');

const { attachWsServer } = require('./net/wsAdapter');
const RoomManager = require('./net/RoomManager');
const { registerSocketHandlers } = require('./net/socketHandlers');
const { createApiRouter } = require('./net/apiRoutes');
const PuzzleShareStore = require('./game/PuzzleShareStore');
const StatsStore = require('./game/StatsStore');
const { connectDb } = require('./db');

const PORT = process.env.PORT || 6969;

async function main() {
  const db = await connectDb();

  const app = express();
  const server = http.createServer(app);
  const io = attachWsServer(server);

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  const puzzleShareStore = new PuzzleShareStore(db);
  const statsStore = new StatsStore(db);
  app.use('/api', createApiRouter({ puzzleShareStore, statsStore }));

  const roomManager = new RoomManager();
  registerSocketHandlers(io, roomManager);

  server.listen(PORT, () => {
    console.log(`Server up and running on port:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
