const Room = require('../game/Room');
const debug = require('debug');

const logSocket = debug('socket'); // room/session lifecycle: create, join, submit, leave, rejoin, disconnect
const logMm = debug('mm'); // matchmaking: findMatch requests + pairing outcomes

function matchStartPayload(room) {
  return {
    grid: room.grid,
    gridSize: room.gridSize,
    words: room.placedWords.map((p) => p.word),
    players: room.players.map((p) => ({ deviceId: p.deviceId, name: p.name })),
  };
}

function emitMatchStart(io, room) {
  io.to(room.id).emit('matchStart', matchStartPayload(room));
}

// Trophies only ever apply to ranked (Quick Match) rooms -- Create/Join Room
// stays casual with no trophy stakes. Ties get no trophy change either way.
async function applyRankedResult(room, winner, loserId, trophyStore) {
  if (room.mode !== 'ranked' || !winner || winner === 'tie' || !loserId) return [];
  const result = await trophyStore.applyMatchResult(winner, loserId);
  return [
    { deviceId: result.winner.deviceId, trophies: result.winner.trophies, delta: result.winner.delta },
    { deviceId: result.loser.deviceId, trophies: result.loser.trophies, delta: result.loser.delta },
  ];
}

function handleCreateRoom(socket, roomManager) {
  const { deviceId, name } = socket.data;
  const room = roomManager.createRoom({ deviceId, socketId: socket.id, name }, 'unranked');
  logSocket('createRoom %s (%s) -> room %s', deviceId, name, room.id);
  socket.join(room.id);
  socket.emit('roomCreated', { code: room.id });
}

function handleJoinRoom(socket, roomManager, io, code) {
  const { deviceId, name } = socket.data;
  logSocket('joinRoom %s (%s) -> %s', deviceId, name, code);
  if (!code) return socket.emit('errorMsg', { code: 'invalid-request' });

  const result = roomManager.joinRoom(String(code).toUpperCase(), { deviceId, socketId: socket.id, name });
  if (result.error) {
    console.warn(`[socket] joinRoom ${deviceId} failed to join ${code}: ${result.error}`);
    return socket.emit('errorMsg', { code: result.error });
  }

  const room = result.room;
  logSocket('joinRoom %s joined room %s', deviceId, room.id);
  socket.join(room.id);

  const opponent = room.otherPlayer(deviceId);
  if (opponent) io.to(opponent.socketId).emit('opponentJoined', { opponentName: name });
  socket.emit('opponentJoined', { opponentName: opponent ? opponent.name : undefined });

  emitMatchStart(io, room);
}

async function handleFindMatch(socket, roomManager, io, trophyStore) {
  const { deviceId, name } = socket.data;
  logMm('findMatch %s (%s) requested', deviceId, name);
  let arena;
  try {
    ({ arena } = await trophyStore.getOrCreate(deviceId));
  } catch (err) {
    console.error(`[mm] findMatch ${deviceId} trophyStore.getOrCreate failed:`, err);
    return socket.emit('errorMsg', { code: 'find-match-failed' });
  }
  roomManager.queueForMatch({ deviceId, socketId: socket.id, name, arena });
  logMm('findMatch %s queued arena=%s queueLength=%d', deviceId, arena, roomManager.queue.length);
  // Pairing (and matchStart emission) happens asynchronously on the
  // matchmaker's next tick, via the onRoomReady callback registered in
  // registerSocketHandlers -- not synchronously here.
}

function handleCancelFindMatch(socket, roomManager) {
  logMm('findMatch %s cancelled', socket.data.deviceId);
  roomManager.cancelFindMatch(socket.data.deviceId);
}

async function handleSubmitWord(socket, roomManager, io, cells, trophyStore) {
  const { deviceId } = socket.data;
  const room = roomManager.getRoomByDeviceId(deviceId);
  if (!room || room.status !== 'playing') {
    console.warn(`[socket] submitWord ${deviceId} no active room (status=${room?.status})`);
    return socket.emit('wordRejected', { reason: 'no-active-room' });
  }

  const entry = room.validateSubmission(cells);
  if (!entry) {
    console.warn(`[socket] submitWord ${deviceId} invalid submission:`, cells);
    return socket.emit('wordRejected', { reason: 'invalid' });
  }
  logSocket('submitWord %s found "%s" in room %s', deviceId, entry.word, room.id);

  const { scores, gameOver, winner } = room.recordFound(entry, deviceId);
  io.to(room.id).emit('wordFound', { word: entry.word, cells: entry.cells, deviceId, scores });

  if (gameOver) {
    const loserId = winner !== 'tie' ? room.otherPlayer(winner)?.deviceId : null;
    const trophyChanges = await applyRankedResult(room, winner, loserId, trophyStore);
    io.to(room.id).emit('gameOver', { winner, scores, trophyChanges });
    room.clearAllTimers();
    roomManager.closeRoom(room.id);
  }
}

function handleLeaveRoom(socket, roomManager, io, trophyStore) {
  const { deviceId } = socket.data;
  logSocket('leaveRoom %s', deviceId);
  roomManager.cancelFindMatch(deviceId);

  const room = roomManager.getRoomByDeviceId(deviceId);
  if (!room) return;

  socket.leave(room.id);

  if (room.status === 'playing') {
    const opponent = room.otherPlayer(deviceId);
    if (opponent) {
      applyRankedResult(room, opponent.deviceId, deviceId, trophyStore).then((trophyChanges) => {
        io.to(room.id).emit('gameOver', { winner: opponent.deviceId, scores: room.scores(), trophyChanges });
      });
    }
  }
  roomManager.closeRoom(room.id);
}

function handleRejoinRoom(socket, roomManager, io, code) {
  const { deviceId } = socket.data;
  logSocket('rejoinRoom %s -> %s', deviceId, code);
  const room = roomManager.getRoom(String(code || '').toUpperCase());
  if (!room || !room.getPlayer(deviceId)) {
    console.warn(`[socket] rejoinRoom ${deviceId} failed: room-not-found (code=${code})`);
    return socket.emit('errorMsg', { code: 'room-not-found' });
  }

  room.markReconnected(deviceId, socket.id);
  socket.join(room.id);

  const opponent = room.otherPlayer(deviceId);
  if (opponent) io.to(opponent.socketId).emit('opponentReconnected');

  socket.emit('matchStart', matchStartPayload(room));

  // Replay already-found words so the rejoining client's board matches state.
  for (const { word, deviceId: finderId } of room.foundOrder) {
    const entry = room.placedWords.find((p) => p.word === word);
    socket.emit('wordFound', { word, cells: entry.cells, deviceId: finderId, scores: room.scores() });
  }
}

function handleDisconnect(socket, roomManager, io, trophyStore) {
  const { deviceId } = socket.data || {};
  logSocket('disconnect %s deviceId=%s', socket.shortId, deviceId);
  if (!deviceId) return;
  roomManager.cancelFindMatch(deviceId);

  const room = roomManager.getRoomByDeviceId(deviceId);
  if (!room || room.status !== 'playing') return;

  room.markDisconnected(deviceId);
  const opponent = room.otherPlayer(deviceId);
  if (opponent) {
    io.to(opponent.socketId).emit('opponentDisconnected', { graceSeconds: Room.DISCONNECT_GRACE_MS / 1000 });
  }

  room.startDisconnectTimer(deviceId, (expiredDeviceId) => {
    const stillRoom = roomManager.getRoomByDeviceId(expiredDeviceId);
    if (!stillRoom || stillRoom.status !== 'playing') return;
    const remaining = stillRoom.otherPlayer(expiredDeviceId);
    if (remaining) {
      applyRankedResult(stillRoom, remaining.deviceId, expiredDeviceId, trophyStore).then((trophyChanges) => {
        io.to(stillRoom.id).emit('gameOver', { winner: remaining.deviceId, scores: stillRoom.scores(), trophyChanges });
      });
    }
    roomManager.closeRoom(stillRoom.id);
  });
}

// Fired by RoomManager.onRoomReady() whenever the ticking matchmaker pairs
// two ranked queue entries into a room -- the equivalent of the old
// synchronous handleFindMatch's second half, now decoupled from the request
// that triggered queuing since pairing can happen well after either
// player's findMatch call returns.
function handleRoomReady(io, room) {
  logMm('room %s ready: %o', room.id, room.players.map((p) => p.deviceId));
  for (const p of room.players) {
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) {
      console.warn(`[mm] room ${room.id}: no live socket for ${p.deviceId} (${p.socketId}), likely disconnected before pairing`);
      continue;
    }
    sock.join(room.id);
  }

  const [a, b] = room.players;
  io.to(a.socketId).emit('opponentJoined', { opponentName: b.name });
  io.to(b.socketId).emit('opponentJoined', { opponentName: a.name });

  emitMatchStart(io, room);
}

function registerSocketHandlers(io, roomManager, trophyStore) {
  roomManager.onRoomReady((room) => handleRoomReady(io, room));

  io.on('connection', (socket) => {
    logSocket('connection %s deviceId=%s', socket.shortId, socket.data.deviceId);
    // socket.data.{deviceId,name} is already populated by the wsAdapter
    // (it validates deviceId and disconnects before this event fires).
    socket.on('createRoom', () => handleCreateRoom(socket, roomManager));
    socket.on('joinRoom', ({ code } = {}) => handleJoinRoom(socket, roomManager, io, code));
    socket.on('findMatch', () => handleFindMatch(socket, roomManager, io, trophyStore));
    socket.on('cancelFindMatch', () => handleCancelFindMatch(socket, roomManager));
    socket.on('submitWord', ({ cells } = {}) => handleSubmitWord(socket, roomManager, io, cells, trophyStore));
    socket.on('leaveRoom', () => handleLeaveRoom(socket, roomManager, io, trophyStore));
    socket.on('rejoinRoom', ({ code } = {}) => handleRejoinRoom(socket, roomManager, io, code));
    socket.on('disconnect', () => handleDisconnect(socket, roomManager, io, trophyStore));
  });
}

module.exports = { registerSocketHandlers };
