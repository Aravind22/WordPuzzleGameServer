const Room = require('../game/Room');
const debug = require('debug');

const logSocket = debug('socket'); // room/session lifecycle: create, join, submit, leave, rejoin, disconnect
const logMm = debug('mm'); // matchmaking: findMatch requests + pairing outcomes

function matchStartPayload(room) {
  return {
    mode: room.mode,
    grid: room.grid,
    gridSize: room.gridSize,
    words: room.placedWords.map((p) => p.word),
    players: room.players.map((p) => ({ playerId: p.playerId, name: p.name, trophies: p.trophies || 0 })),
  };
}

function emitMatchStart(io, room) {
  io.to(room.id).emit('matchStart', matchStartPayload(room));
}

// Trophies only ever apply to ranked (Quick Match) rooms -- Create/Join Room
// stays casual with no trophy stakes. Ties get no trophy change either way.
// The winner also gets the hint reward for a first-time arena (0 if none).
async function applyRankedResult(room, winner, loserId, playerStore) {
  if (room.mode !== 'ranked' || !winner || winner === 'tie' || !loserId) return [];
  const result = await playerStore.applyMatchResult(winner, loserId);
  let hintsAwarded = 0;
  if (economyStore) {
    try {
      hintsAwarded = await economyStore.grantArenaHints(winner, result.winner.trophies - result.winner.delta, result.winner.trophies);
    } catch (err) {
      console.error('[economy] arena hints failed:', err.message);
    }
  }
  return [
    { playerId: result.winner.playerId, trophies: result.winner.trophies, delta: result.winner.delta, hintsAwarded },
    { playerId: result.loser.playerId, trophies: result.loser.trophies, delta: result.loser.delta },
  ];
}

// Tells the other player that playerId's open rematch offer is gone (they
// left, disconnected or started something else).
function withdrawRematch(io, roomManager, playerId) {
  const record = roomManager.cancelRematch(playerId);
  if (!record) return;
  logSocket('rematch %s withdrawn by %s', record.id, playerId);
  for (const p of record.players) {
    if (p.playerId !== playerId) io.to(p.socketId).emit('rematchDeclined');
  }
}

// A private-room match that ended normally stays open for a rematch.
function openRematch(io, roomManager, room) {
  if (room.mode !== 'unranked') return;
  roomManager.openRematch(room, (record) => {
    logSocket('rematch %s expired', record.id);
    for (const p of record.players) io.to(p.socketId).emit('rematchDeclined');
  });
}

function handleRematch(socket, roomManager, io) {
  const { playerId, name } = socket.data;
  const result = roomManager.requestRematch(playerId, socket.id);
  if (result.error) {
    logSocket('rematch %s: %s', playerId, result.error);
    return socket.emit('errorMsg', { code: result.error });
  }
  if (!result.room) {
    logSocket('rematch %s requested by %s', result.record.id, playerId);
    for (const p of result.record.players) {
      if (p.playerId !== playerId) io.to(p.socketId).emit('rematchRequested', { name });
    }
    return;
  }

  const room = result.room;
  logSocket('rematch %s -> room %s', result.record.id, room.id);
  for (const p of room.players) io.sockets.sockets.get(p.socketId)?.join(room.id);
  emitMatchStart(io, room);
}

function handleCreateRoom(socket, roomManager, io) {
  const { playerId, name } = socket.data;
  withdrawRematch(io, roomManager, playerId);
  const room = roomManager.createRoom({ playerId, socketId: socket.id, name }, 'unranked');
  logSocket('createRoom %s (%s) -> room %s', playerId, name, room.id);
  socket.join(room.id);
  socket.emit('roomCreated', { code: room.id });
}

function handleJoinRoom(socket, roomManager, io, code) {
  const { playerId, name } = socket.data;
  logSocket('joinRoom %s (%s) -> %s', playerId, name, code);
  if (!code) return socket.emit('errorMsg', { code: 'invalid-request' });
  withdrawRematch(io, roomManager, playerId);

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
  withdrawRematch(io, roomManager, playerId);
  let arena;
  let trophies;
  try {
    ({ player: { arena, trophies } } = await playerStore.getOrCreate(playerId));
  } catch (err) {
    console.error(`[mm] findMatch ${playerId} playerStore.getOrCreate failed:`, err);
    return socket.emit('errorMsg', { code: 'find-match-failed' });
  }
  roomManager.queueForMatch({ playerId, socketId: socket.id, name, arena, trophies });
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
    openRematch(io, roomManager, room);
    room.clearAllTimers();
    roomManager.closeRoom(room.id);
  }
}

function handleLeaveRoom(socket, roomManager, io, playerStore) {
  const { playerId } = socket.data;
  logSocket('leaveRoom %s', playerId);
  roomManager.cancelFindMatch(playerId);
  withdrawRematch(io, roomManager, playerId);

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
  withdrawRematch(io, roomManager, playerId);

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

// Set by registerSocketHandlers; used for the arena hint reward.
let economyStore = null;

function registerSocketHandlers(io, roomManager, playerStore, economy = null) {
  economyStore = economy;
  roomManager.onRoomReady((room) => handleRoomReady(io, room));

  io.on('connection', (socket) => {
    logSocket('connection %s playerId=%s', socket.shortId, socket.data.playerId);
    // socket.data.{playerId,name} is already populated by the wsAdapter
    // (from the verified Firebase token, before the handshake completes).
    socket.on('createRoom', () => handleCreateRoom(socket, roomManager, io));
    socket.on('joinRoom', ({ code } = {}) => handleJoinRoom(socket, roomManager, io, code));
    socket.on('findMatch', () => handleFindMatch(socket, roomManager, io, playerStore));
    socket.on('cancelFindMatch', () => handleCancelFindMatch(socket, roomManager));
    socket.on('submitWord', ({ cells } = {}) => handleSubmitWord(socket, roomManager, io, cells, playerStore));
    socket.on('leaveRoom', () => handleLeaveRoom(socket, roomManager, io, playerStore));
    socket.on('rematch', () => handleRematch(socket, roomManager, io));
    socket.on('rejoinRoom', ({ code } = {}) => handleRejoinRoom(socket, roomManager, io, code));
    socket.on('disconnect', () => handleDisconnect(socket, roomManager, io, playerStore));
  });
}

module.exports = { registerSocketHandlers };
