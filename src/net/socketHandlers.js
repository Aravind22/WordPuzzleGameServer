const Room = require('../game/Room');
const debug = require('debug');

const logSocket = debug('socket'); // room/session lifecycle: create, join, submit, leave, rejoin, disconnect
const logMm = debug('mm'); // matchmaking: findMatch requests + pairing outcomes

function matchStartPayload(room) {
  return {
    grid: room.grid,
    gridSize: room.gridSize,
    words: room.placedWords.map((p) => p.word),
    players: room.players.map((p) => ({ playerId: p.playerId, name: p.name })),
  };
}

function emitMatchStart(io, room) {
  io.to(room.id).emit('matchStart', matchStartPayload(room));
}

// Trophies only ever apply to ranked (Quick Match) rooms -- Create/Join Room
// stays casual with no trophy stakes. Ties get no trophy change either way.
async function applyRankedResult(room, winner, loserId, playerStore) {
  if (room.mode !== 'ranked' || !winner || winner === 'tie' || !loserId) return [];
  const result = await playerStore.applyMatchResult(winner, loserId);
  return [
    { playerId: result.winner.playerId, trophies: result.winner.trophies, delta: result.winner.delta },
    { playerId: result.loser.playerId, trophies: result.loser.trophies, delta: result.loser.delta },
  ];
}

function handleCreateRoom(socket, roomManager) {
  const { playerId, name } = socket.data;
  const room = roomManager.createRoom({ playerId, socketId: socket.id, name }, 'unranked');
  logSocket('createRoom %s (%s) -> room %s', playerId, name, room.id);
  socket.join(room.id);
  socket.emit('roomCreated', { code: room.id });
}

function handleJoinRoom(socket, roomManager, io, code) {
  const { playerId, name } = socket.data;
  logSocket('joinRoom %s (%s) -> %s', playerId, name, code);
  if (!code) return socket.emit('errorMsg', { code: 'invalid-request' });

  const result = roomManager.joinRoom(String(code).toUpperCase(), { playerId, socketId: socket.id, name });
  if (result.error) {
    console.warn(`[socket] joinRoom ${playerId} failed to join ${code}: ${result.error}`);
    return socket.emit('errorMsg', { code: result.error });
  }

  const room = result.room;
  logSocket('joinRoom %s joined room %s', playerId, room.id);
  socket.join(room.id);

  const opponent = room.otherPlayer(playerId);
  if (opponent) io.to(opponent.socketId).emit('opponentJoined', { opponentName: name });
  socket.emit('opponentJoined', { opponentName: opponent ? opponent.name : undefined });

  emitMatchStart(io, room);
}

async function handleFindMatch(socket, roomManager, io, playerStore) {
  const { playerId, name } = socket.data;
  logMm('findMatch %s (%s) requested', playerId, name);
  let arena;
  try {
    ({ player: { arena } } = await playerStore.getOrCreate(playerId));
  } catch (err) {
    console.error(`[mm] findMatch ${playerId} playerStore.getOrCreate failed:`, err);
    return socket.emit('errorMsg', { code: 'find-match-failed' });
  }
  roomManager.queueForMatch({ playerId, socketId: socket.id, name, arena });
  logMm('findMatch %s queued arena=%s queueLength=%d', playerId, arena, roomManager.queue.length);
  // Pairing (and matchStart emission) happens asynchronously on the
  // matchmaker's next tick, via the onRoomReady callback registered in
  // registerSocketHandlers -- not synchronously here.
}

function handleCancelFindMatch(socket, roomManager) {
  logMm('findMatch %s cancelled', socket.data.playerId);
  roomManager.cancelFindMatch(socket.data.playerId);
}

async function handleSubmitWord(socket, roomManager, io, cells, playerStore) {
  const { playerId } = socket.data;
  const room = roomManager.getRoomByPlayerId(playerId);
  if (!room || room.status !== 'playing') {
    console.warn(`[socket] submitWord ${playerId} no active room (status=${room?.status})`);
    return socket.emit('wordRejected', { reason: 'no-active-room' });
  }

  const entry = room.validateSubmission(cells);
  if (!entry) {
    console.warn(`[socket] submitWord ${playerId} invalid submission:`, cells);
    return socket.emit('wordRejected', { reason: 'invalid' });
  }
  logSocket('submitWord %s found "%s" in room %s', playerId, entry.word, room.id);

  const { scores, gameOver, winner } = room.recordFound(entry, playerId);
  io.to(room.id).emit('wordFound', { word: entry.word, cells: entry.cells, playerId, scores });

  if (gameOver) {
    const loserId = winner !== 'tie' ? room.otherPlayer(winner)?.playerId : null;
    const trophyChanges = await applyRankedResult(room, winner, loserId, playerStore);
    io.to(room.id).emit('gameOver', { winner, scores, trophyChanges });
    room.clearAllTimers();
    roomManager.closeRoom(room.id);
  }
}

function handleLeaveRoom(socket, roomManager, io, playerStore) {
  const { playerId } = socket.data;
  logSocket('leaveRoom %s', playerId);
  roomManager.cancelFindMatch(playerId);

  const room = roomManager.getRoomByPlayerId(playerId);
  if (!room) return;

  socket.leave(room.id);

  if (room.status === 'playing') {
    const opponent = room.otherPlayer(playerId);
    if (opponent) {
      applyRankedResult(room, opponent.playerId, playerId, playerStore).then((trophyChanges) => {
        io.to(room.id).emit('gameOver', { winner: opponent.playerId, scores: room.scores(), trophyChanges });
      });
    }
  }
  roomManager.closeRoom(room.id);
}

function handleRejoinRoom(socket, roomManager, io, code) {
  const { playerId } = socket.data;
  logSocket('rejoinRoom %s -> %s', playerId, code);
  const room = roomManager.getRoom(String(code || '').toUpperCase());
  if (!room || !room.getPlayer(playerId)) {
    console.warn(`[socket] rejoinRoom ${playerId} failed: room-not-found (code=${code})`);
    return socket.emit('errorMsg', { code: 'room-not-found' });
  }

  room.markReconnected(playerId, socket.id);
  socket.join(room.id);

  const opponent = room.otherPlayer(playerId);
  if (opponent) io.to(opponent.socketId).emit('opponentReconnected');

  socket.emit('matchStart', matchStartPayload(room));

  // Replay already-found words so the rejoining client's board matches state.
  for (const { word, playerId: finderId } of room.foundOrder) {
    const entry = room.placedWords.find((p) => p.word === word);
    socket.emit('wordFound', { word, cells: entry.cells, playerId: finderId, scores: room.scores() });
  }
}

function handleDisconnect(socket, roomManager, io, playerStore) {
  const { playerId } = socket.data || {};
  logSocket('disconnect %s playerId=%s', socket.shortId, playerId);
  if (!playerId) return;
  roomManager.cancelFindMatch(playerId);

  const room = roomManager.getRoomByPlayerId(playerId);
  if (!room || room.status !== 'playing') return;

  room.markDisconnected(playerId);
  const opponent = room.otherPlayer(playerId);
  if (opponent) {
    io.to(opponent.socketId).emit('opponentDisconnected', { graceSeconds: Room.DISCONNECT_GRACE_MS / 1000 });
  }

  room.startDisconnectTimer(playerId, (expiredPlayerId) => {
    // Look up this exact room, not "the player's current room": the player
    // may have started a new match during the grace period, which this
    // timer must not end.
    const stillRoom = roomManager.getRoom(room.id);
    if (!stillRoom || stillRoom.status !== 'playing') return;
    const remaining = stillRoom.otherPlayer(expiredPlayerId);
    if (remaining) {
      applyRankedResult(stillRoom, remaining.playerId, expiredPlayerId, playerStore).then((trophyChanges) => {
        io.to(stillRoom.id).emit('gameOver', { winner: remaining.playerId, scores: stillRoom.scores(), trophyChanges });
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
  logMm('room %s ready: %o', room.id, room.players.map((p) => p.playerId));
  for (const p of room.players) {
    const sock = io.sockets.sockets.get(p.socketId);
    if (!sock) {
      console.warn(`[mm] room ${room.id}: no live socket for ${p.playerId} (${p.socketId}), likely disconnected before pairing`);
      continue;
    }
    sock.join(room.id);
  }

  const [a, b] = room.players;
  io.to(a.socketId).emit('opponentJoined', { opponentName: b.name });
  io.to(b.socketId).emit('opponentJoined', { opponentName: a.name });

  emitMatchStart(io, room);
}

function registerSocketHandlers(io, roomManager, playerStore) {
  roomManager.onRoomReady((room) => handleRoomReady(io, room));

  io.on('connection', (socket) => {
    logSocket('connection %s playerId=%s', socket.shortId, socket.data.playerId);
    // socket.data.{playerId,name} is already populated by the wsAdapter
    // (from the verified Firebase token, before the handshake completes).
    socket.on('createRoom', () => handleCreateRoom(socket, roomManager));
    socket.on('joinRoom', ({ code } = {}) => handleJoinRoom(socket, roomManager, io, code));
    socket.on('findMatch', () => handleFindMatch(socket, roomManager, io, playerStore));
    socket.on('cancelFindMatch', () => handleCancelFindMatch(socket, roomManager));
    socket.on('submitWord', ({ cells } = {}) => handleSubmitWord(socket, roomManager, io, cells, playerStore));
    socket.on('leaveRoom', () => handleLeaveRoom(socket, roomManager, io, playerStore));
    socket.on('rejoinRoom', ({ code } = {}) => handleRejoinRoom(socket, roomManager, io, code));
    socket.on('disconnect', () => handleDisconnect(socket, roomManager, io, playerStore));
  });
}

module.exports = { registerSocketHandlers };
