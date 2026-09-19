const Room = require('../game/Room');

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

function handleCreateRoom(socket, roomManager) {
  const { deviceId, name } = socket.data;
  const room = roomManager.createRoom({ deviceId, socketId: socket.id, name });
  socket.join(room.id);
  socket.emit('roomCreated', { code: room.id });
}

function handleJoinRoom(socket, roomManager, io, code) {
  const { deviceId, name } = socket.data;
  if (!code) return socket.emit('errorMsg', { code: 'invalid-request' });

  const result = roomManager.joinRoom(String(code).toUpperCase(), { deviceId, socketId: socket.id, name });
  if (result.error) return socket.emit('errorMsg', { code: result.error });

  const room = result.room;
  socket.join(room.id);

  const opponent = room.otherPlayer(deviceId);
  if (opponent) io.to(opponent.socketId).emit('opponentJoined', { opponentName: name });
  socket.emit('opponentJoined', { opponentName: opponent ? opponent.name : undefined });

  emitMatchStart(io, room);
}

function handleFindMatch(socket, roomManager, io) {
  const { deviceId, name } = socket.data;
  const room = roomManager.findMatch({ deviceId, socketId: socket.id, name });
  if (!room) return; // queued, waiting for an opponent

  for (const p of room.players) {
    io.sockets.sockets.get(p.socketId)?.join(room.id);
  }

  const [a, b] = room.players;
  io.to(a.socketId).emit('opponentJoined', { opponentName: b.name });
  io.to(b.socketId).emit('opponentJoined', { opponentName: a.name });

  emitMatchStart(io, room);
}

function handleCancelFindMatch(socket, roomManager) {
  roomManager.cancelFindMatch(socket.data.deviceId);
}

function handleSubmitWord(socket, roomManager, io, cells) {
  const { deviceId } = socket.data;
  const room = roomManager.getRoomByDeviceId(deviceId);
  if (!room || room.status !== 'playing') {
    return socket.emit('wordRejected', { reason: 'no-active-room' });
  }

  const entry = room.validateSubmission(cells);
  if (!entry) {
    return socket.emit('wordRejected', { reason: 'invalid' });
  }

  const { scores, gameOver, winner } = room.recordFound(entry, deviceId);
  io.to(room.id).emit('wordFound', { word: entry.word, cells: entry.cells, deviceId, scores });

  if (gameOver) {
    io.to(room.id).emit('gameOver', { winner, scores });
    room.clearAllTimers();
    roomManager.closeRoom(room.id);
  }
}

function handleLeaveRoom(socket, roomManager, io) {
  const { deviceId } = socket.data;
  roomManager.cancelFindMatch(deviceId);

  const room = roomManager.getRoomByDeviceId(deviceId);
  if (!room) return;

  socket.leave(room.id);

  if (room.status === 'playing') {
    const opponent = room.otherPlayer(deviceId);
    if (opponent) {
      io.to(room.id).emit('gameOver', { winner: opponent.deviceId, scores: room.scores() });
    }
  }
  roomManager.closeRoom(room.id);
}

function handleRejoinRoom(socket, roomManager, io, code) {
  const { deviceId } = socket.data;
  const room = roomManager.getRoom(String(code || '').toUpperCase());
  if (!room || !room.getPlayer(deviceId)) {
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

function handleDisconnect(socket, roomManager, io) {
  const { deviceId } = socket.data || {};
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
      io.to(stillRoom.id).emit('gameOver', { winner: remaining.deviceId, scores: stillRoom.scores() });
    }
    roomManager.closeRoom(stillRoom.id);
  });
}

function registerSocketHandlers(io, roomManager) {
  io.on('connection', (socket) => {
    // socket.data.{deviceId,name} is already populated by the wsAdapter
    // (it validates deviceId and disconnects before this event fires).
    socket.on('createRoom', () => handleCreateRoom(socket, roomManager));
    socket.on('joinRoom', ({ code } = {}) => handleJoinRoom(socket, roomManager, io, code));
    socket.on('findMatch', () => handleFindMatch(socket, roomManager, io));
    socket.on('cancelFindMatch', () => handleCancelFindMatch(socket, roomManager));
    socket.on('submitWord', ({ cells } = {}) => handleSubmitWord(socket, roomManager, io, cells));
    socket.on('leaveRoom', () => handleLeaveRoom(socket, roomManager, io));
    socket.on('rejoinRoom', ({ code } = {}) => handleRejoinRoom(socket, roomManager, io, code));
    socket.on('disconnect', () => handleDisconnect(socket, roomManager, io));
  });
}

module.exports = { registerSocketHandlers };
