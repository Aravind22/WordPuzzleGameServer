const { customAlphabet } = require('nanoid');
const Room = require('../game/Room');
const debug = require('debug');

const logMm = debug('mm');

// Excludes ambiguous chars (0/O, 1/I) so codes are easy to read/type aloud.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const generateCode = customAlphabet(CODE_ALPHABET, 6);

const CLEANUP_INTERVAL_MS = 60 * 1000;
const MATCHMAKER_TICK_MS = 1000;
const EXPAND_SEARCH_AFTER_MS = 5000;
const REMATCH_WINDOW_MS = 60 * 1000;

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
    this.queue = []; // [{ playerId, socketId, name, arena, trophies, queuedAt }] -- ranked (Quick Match) only
    this.playerToRoom = new Map(); // playerId -> room code, for rejoin lookups

    // Finished private-room matches the two players can replay together:
    // old room code -> { id, players: [{ playerId, socketId, name }], ready: Set, timer }.
    this.rematches = new Map();
    this.playerToRematch = new Map(); // playerId -> old room code

    this.cleanupInterval = setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref?.();

    this.matchmakerInterval = setInterval(() => this.matchmakerTick(), MATCHMAKER_TICK_MS);
    this.matchmakerInterval.unref?.();

    // Called (via setOnRoomReady) whenever the matchmaker tick pairs two
    // queued players into a room -- the socket-joining/event-emitting side
    // of that lives in socketHandlers.js, which doesn't fit here.
    this._onRoomReady = null;
  }

  onRoomReady(callback) {
    this._onRoomReady = callback;
  }

  _newRoomCode() {
    let code;
    do {
      code = generateCode();
    } while (this.rooms.has(code));
    return code;
  }

  createRoom({ playerId, socketId, name, trophies }, mode = 'unranked') {
    const code = this._newRoomCode();
    const room = new Room(code, mode);
    room.addPlayer({ playerId, socketId, name, trophies });
    this.rooms.set(code, room);
    this.playerToRoom.set(playerId, code);
    return room;
  }

  // Returns { room } on success, or { error: 'room-not-found' | 'room-full' | 'already-started' }.
  joinRoom(code, { playerId, socketId, name }) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'room-not-found' };
    if (room.hasStarted()) return { error: 'already-started' };
    if (room.isFull()) return { error: 'room-full' };

    room.addPlayer({ playerId, socketId, name });
    this.playerToRoom.set(playerId, code);
    room.start();
    return { room };
  }

  // Queues playerId for ranked Quick Match. Pairing happens on the next
  // matchmakerTick(), not synchronously -- arena-aware matching needs to
  // look across everyone currently waiting, not just the two most recent.
  queueForMatch({ playerId, socketId, name, arena, trophies }) {
    this.queue = this.queue.filter((q) => q.playerId !== playerId);
    this.queue.push({ playerId, socketId, name, arena, trophies, queuedAt: Date.now() });
    logMm('queue += %s (arena=%s) -> [%s]', playerId, arena, this.queue.map((q) => `${q.playerId}/${q.arena}`).join(', '));
  }

  cancelFindMatch(playerId) {
    const had = this.queue.some((q) => q.playerId === playerId);
    this.queue = this.queue.filter((q) => q.playerId !== playerId);
    if (had) logMm('queue -= %s', playerId);
  }

  // Same-arena pass first (skill-relevant pairing when possible), then an
  // expand-search pass: anyone who has waited >= EXPAND_SEARCH_AFTER_MS gets
  // paired with the next available entry regardless of arena -- only *that*
  // entry needs to have waited the 5s, not both sides of the pair.
  // TODO(future): if an entry is still unmatched after some further grace
  // period, pair it with a bot instead of a human opponent.
  matchmakerTick() {
    if (this.queue.length < 2) return;
    logMm('tick: [%s]', this.queue.map((q) => `${q.playerId}/${q.arena}`).join(', '));

    const matchedPlayerIds = new Set();
    const byArena = new Map();
    for (const entry of this.queue) {
      if (!byArena.has(entry.arena)) byArena.set(entry.arena, []);
      byArena.get(entry.arena).push(entry);
    }

    for (const group of byArena.values()) {
      group.sort((a, b) => a.queuedAt - b.queuedAt);
      while (group.length >= 2) {
        const a = group.shift();
        const b = group.shift();
        matchedPlayerIds.add(a.playerId);
        matchedPlayerIds.add(b.playerId);
        this._pairAndStart(a, b);
      }
    }

    if (matchedPlayerIds.size > 0) {
      this.queue = this.queue.filter((q) => !matchedPlayerIds.has(q.playerId));
    }

    const now = Date.now();
    let remaining = this.queue.slice().sort((a, b) => a.queuedAt - b.queuedAt);
    const expandedMatched = new Set();
    while (remaining.length >= 2) {
      const oldest = remaining[0];
      if (now - oldest.queuedAt < EXPAND_SEARCH_AFTER_MS) break;
      const [a, b] = remaining.splice(0, 2);
      expandedMatched.add(a.playerId);
      expandedMatched.add(b.playerId);
      this._pairAndStart(a, b);
    }

    if (expandedMatched.size > 0) {
      this.queue = this.queue.filter((q) => !expandedMatched.has(q.playerId));
    }
  }

  _pairAndStart(a, b) {
    const room = this.createRoom(a, 'ranked');
    room.addPlayer(b);
    this.playerToRoom.set(b.playerId, room.id);
    room.start();
    logMm('paired %s vs %s -> room %s', a.playerId, b.playerId, room.id);
    if (!this._onRoomReady) console.warn('[mm] no onRoomReady callback registered -- sockets will never be joined to the room');
    this._onRoomReady?.(room);
  }

  // Keeps a finished private-room match open for a rematch for
  // REMATCH_WINDOW_MS. onExpire(record) fires if it times out unused.
  openRematch(room, onExpire) {
    const record = {
      id: room.id,
      players: room.players.map((p) => ({ playerId: p.playerId, socketId: p.socketId, name: p.name })),
      ready: new Set(),
      timer: null,
    };
    for (const p of record.players) {
      this.cancelRematch(p.playerId); // one open offer per player
      this.playerToRematch.set(p.playerId, record.id);
    }
    this.rematches.set(record.id, record);
    record.timer = setTimeout(() => {
      if (this.rematches.get(record.id) !== record) return;
      this._closeRematch(record);
      onExpire?.(record);
    }, REMATCH_WINDOW_MS);
    record.timer.unref?.();
    return record;
  }

  // Marks playerId ready. Returns { error } if there's nothing to rematch,
  // { record } while waiting for the other player, or { record, room } once
  // both are ready (the new room has already started).
  requestRematch(playerId, socketId) {
    const record = this.rematches.get(this.playerToRematch.get(playerId));
    if (!record) return { error: 'rematch-unavailable' };
    const me = record.players.find((p) => p.playerId === playerId);
    me.socketId = socketId;
    record.ready.add(playerId);
    if (record.ready.size < record.players.length) return { record };

    this._closeRematch(record);
    const [a, b] = record.players;
    const room = this.createRoom(a, 'unranked');
    room.addPlayer(b);
    this.playerToRoom.set(b.playerId, room.id);
    room.start();
    return { record, room };
  }

  // Withdraws playerId's open rematch offer (they left, disconnected or
  // started something else). Returns the closed record so the caller can
  // tell the other player, or undefined if there was none.
  cancelRematch(playerId) {
    const record = this.rematches.get(this.playerToRematch.get(playerId));
    if (!record) return undefined;
    this._closeRematch(record);
    return record;
  }

  _closeRematch(record) {
    clearTimeout(record.timer);
    this.rematches.delete(record.id);
    for (const p of record.players) {
      if (this.playerToRematch.get(p.playerId) === record.id) this.playerToRematch.delete(p.playerId);
    }
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  getRoomByPlayerId(playerId) {
    const code = this.playerToRoom.get(playerId);
    return code ? this.rooms.get(code) : undefined;
  }

  closeRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.clearAllTimers();
    // Only unmap players still pointing at THIS room -- one may already be
    // in a newer room (e.g. left and started another match before this one
    // was closed by its disconnect timer).
    for (const p of room.players) {
      if (this.playerToRoom.get(p.playerId) === code) this.playerToRoom.delete(p.playerId);
    }
    this.rooms.delete(code);
  }

  sweep() {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.isAbandoned(now)) this.closeRoom(code);
    }
  }
}

module.exports = RoomManager;
