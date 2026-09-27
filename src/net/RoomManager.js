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

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
    this.queue = []; // [{ deviceId, socketId, name, arena, queuedAt }] -- ranked (Quick Match) only
    this.deviceToRoom = new Map(); // deviceId -> room code, for rejoin lookups

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

  createRoom({ deviceId, socketId, name }, mode = 'unranked') {
    const code = this._newRoomCode();
    const room = new Room(code, mode);
    room.addPlayer({ deviceId, socketId, name });
    this.rooms.set(code, room);
    this.deviceToRoom.set(deviceId, code);
    return room;
  }

  // Returns { room } on success, or { error: 'room-not-found' | 'room-full' | 'already-started' }.
  joinRoom(code, { deviceId, socketId, name }) {
    const room = this.rooms.get(code);
    if (!room) return { error: 'room-not-found' };
    if (room.hasStarted()) return { error: 'already-started' };
    if (room.isFull()) return { error: 'room-full' };

    room.addPlayer({ deviceId, socketId, name });
    this.deviceToRoom.set(deviceId, code);
    room.start();
    return { room };
  }

  // Queues deviceId for ranked Quick Match. Pairing happens on the next
  // matchmakerTick(), not synchronously -- arena-aware matching needs to
  // look across everyone currently waiting, not just the two most recent.
  queueForMatch({ deviceId, socketId, name, arena }) {
    this.queue = this.queue.filter((q) => q.deviceId !== deviceId);
    this.queue.push({ deviceId, socketId, name, arena, queuedAt: Date.now() });
    logMm('queue += %s (arena=%s) -> [%s]', deviceId, arena, this.queue.map((q) => `${q.deviceId}/${q.arena}`).join(', '));
  }

  cancelFindMatch(deviceId) {
    const had = this.queue.some((q) => q.deviceId === deviceId);
    this.queue = this.queue.filter((q) => q.deviceId !== deviceId);
    if (had) logMm('queue -= %s', deviceId);
  }

  // Same-arena pass first (skill-relevant pairing when possible), then an
  // expand-search pass: anyone who has waited >= EXPAND_SEARCH_AFTER_MS gets
  // paired with the next available entry regardless of arena -- only *that*
  // entry needs to have waited the 5s, not both sides of the pair.
  // TODO(future): if an entry is still unmatched after some further grace
  // period, pair it with a bot instead of a human opponent.
  matchmakerTick() {
    if (this.queue.length < 2) return;
    logMm('tick: [%s]', this.queue.map((q) => `${q.deviceId}/${q.arena}`).join(', '));

    const matchedDeviceIds = new Set();
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
        matchedDeviceIds.add(a.deviceId);
        matchedDeviceIds.add(b.deviceId);
        this._pairAndStart(a, b);
      }
    }

    if (matchedDeviceIds.size > 0) {
      this.queue = this.queue.filter((q) => !matchedDeviceIds.has(q.deviceId));
    }

    const now = Date.now();
    let remaining = this.queue.slice().sort((a, b) => a.queuedAt - b.queuedAt);
    const expandedMatched = new Set();
    while (remaining.length >= 2) {
      const oldest = remaining[0];
      if (now - oldest.queuedAt < EXPAND_SEARCH_AFTER_MS) break;
      const [a, b] = remaining.splice(0, 2);
      expandedMatched.add(a.deviceId);
      expandedMatched.add(b.deviceId);
      this._pairAndStart(a, b);
    }

    if (expandedMatched.size > 0) {
      this.queue = this.queue.filter((q) => !expandedMatched.has(q.deviceId));
    }
  }

  _pairAndStart(a, b) {
    const room = this.createRoom(a, 'ranked');
    room.addPlayer(b);
    this.deviceToRoom.set(b.deviceId, room.id);
    room.start();
    logMm('paired %s vs %s -> room %s', a.deviceId, b.deviceId, room.id);
    if (!this._onRoomReady) console.warn('[mm] no onRoomReady callback registered -- sockets will never be joined to the room');
    this._onRoomReady?.(room);
  }

  getRoom(code) {
    return this.rooms.get(code);
  }

  getRoomByDeviceId(deviceId) {
    const code = this.deviceToRoom.get(deviceId);
    return code ? this.rooms.get(code) : undefined;
  }

  closeRoom(code) {
    const room = this.rooms.get(code);
    if (!room) return;
    room.clearAllTimers();
    for (const p of room.players) this.deviceToRoom.delete(p.deviceId);
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
