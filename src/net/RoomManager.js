const { customAlphabet } = require('nanoid');
const Room = require('../game/Room');

// Excludes ambiguous chars (0/O, 1/I) so codes are easy to read/type aloud.
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const generateCode = customAlphabet(CODE_ALPHABET, 6);

const CLEANUP_INTERVAL_MS = 60 * 1000;

class RoomManager {
  constructor() {
    this.rooms = new Map(); // code -> Room
    this.queue = []; // [{ deviceId, socketId, name }]
    this.deviceToRoom = new Map(); // deviceId -> room code, for rejoin lookups

    this.cleanupInterval = setInterval(() => this.sweep(), CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref?.();
  }

  _newRoomCode() {
    let code;
    do {
      code = generateCode();
    } while (this.rooms.has(code));
    return code;
  }

  createRoom({ deviceId, socketId, name }) {
    const code = this._newRoomCode();
    const room = new Room(code);
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

  findMatch({ deviceId, socketId, name }) {
    this.queue = this.queue.filter((q) => q.deviceId !== deviceId);
    this.queue.push({ deviceId, socketId, name });

    if (this.queue.length >= 2) {
      const [a, b] = this.queue.splice(0, 2);
      const room = this.createRoom(a);
      room.addPlayer(b);
      this.deviceToRoom.set(b.deviceId, room.id);
      room.start();
      return room;
    }
    return null;
  }

  cancelFindMatch(deviceId) {
    this.queue = this.queue.filter((q) => q.deviceId !== deviceId);
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
