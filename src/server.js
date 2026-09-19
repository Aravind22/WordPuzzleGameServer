const express = require('express');
const http = require('http');

const { attachWsServer } = require('./net/wsAdapter');
const RoomManager = require('./net/RoomManager');
const { registerSocketHandlers } = require('./net/socketHandlers');
const { createApiRouter } = require('./net/apiRoutes');
const PuzzleShareStore = require('./game/PuzzleShareStore');
const StatsStore = require('./game/StatsStore');

const app = express();
const server = http.createServer(app);
const io = attachWsServer(server);

const PORT = process.env.PORT || 6969;

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const puzzleShareStore = new PuzzleShareStore();
const statsStore = new StatsStore();
app.use('/api', createApiRouter({ puzzleShareStore, statsStore }));

const roomManager = new RoomManager();
registerSocketHandlers(io, roomManager);

server.listen(PORT, () => {
  console.log(`Server up and running on port:${PORT}`);
});
