// Minimal Socket.IO-shaped facade over the plain `ws` package.
//
// Why: socket.io's official C# client (SocketIOClient 4.x) pulls in a
// reflection-heavy DI container plus a dozen+ transitive .NET-10-era
// dependencies with no official Unity support -- a poor fit for Unity's
// IL2CPP AOT builds. Unity instead uses the lightweight NativeWebSocket
// package (see PLAN.md's "Socket.IO client dependency" risk note and its
// documented fallback), so the server speaks plain WebSocket messages
// shaped `{ type, payload }` instead of the real Socket.IO wire protocol.
//
// This adapter exists so net/socketHandlers.js can stay written against an
// `io`/`socket` shape (`.on`, `.emit`, `.join`, `.leave`, `.data`,
// `.disconnect()`, `io.to(room).emit(...)`, `io.sockets.sockets.get(id)`)
// instead of being rewritten around raw `ws` primitives.
const { WebSocketServer } = require('ws');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');

class SocketFacade extends EventEmitter {
  constructor(ws, io) {
    super();
    this.id = randomUUID();
    this.ws = ws;
    this.data = {};
    this._io = io;
    this._rooms = new Set();

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      // Dispatches to this socket's own `.on(type, cb)` listeners. Uses the
      // base EventEmitter behavior directly since `.emit` is overridden
      // below to mean "send to the client" instead.
      super.emit(msg.type, msg.payload);
    });

    ws.on('close', () => {
      for (const room of this._rooms) this._io._removeFromRoom(room, this);
      this._io._removeSocket(this);
      super.emit('disconnect');
    });
  }

  // Overridden: sending TO the client over the wire, not local pub/sub
  // (mirrors Socket.IO's socket.emit semantics).
  emit(type, payload) {
    if (this.ws.readyState === this.ws.OPEN) {
      this.ws.send(JSON.stringify({ type, payload }));
    }
    return true;
  }

  join(room) {
    this._rooms.add(room);
    this._io._addToRoom(room, this);
  }

  leave(room) {
    this._rooms.delete(room);
    this._io._removeFromRoom(room, this);
  }

  disconnect() {
    this.ws.close();
  }
}

class IoFacade extends EventEmitter {
  constructor() {
    super();
    this._rooms = new Map(); // roomId -> Set<SocketFacade>
    this._socketsById = new Map(); // socket.id -> SocketFacade
    this.sockets = { sockets: this._socketsById };
  }

  to(room) {
    const members = this._rooms.get(room);
    return {
      emit: (type, payload) => {
        if (!members) return;
        for (const socket of members) socket.emit(type, payload);
      },
    };
  }

  _addToRoom(room, socket) {
    if (!this._rooms.has(room)) this._rooms.set(room, new Set());
    this._rooms.get(room).add(socket);
  }

  _removeFromRoom(room, socket) {
    const members = this._rooms.get(room);
    if (!members) return;
    members.delete(socket);
    if (members.size === 0) this._rooms.delete(room);
  }

  _removeSocket(socket) {
    this._socketsById.delete(socket.id);
  }
}

// Attaches a WebSocketServer to the given http server and returns an
// `io`-shaped facade. deviceId/name come from the connection URL's query
// string (?deviceId=...&name=...) since there's no Socket.IO handshake.auth
// equivalent over plain ws.
function attachWsServer(server) {
  const io = new IoFacade();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    const url = new URL(req.url, 'http://localhost');
    const deviceId = url.searchParams.get('deviceId');
    const name = url.searchParams.get('name') || 'Player';

    const socket = new SocketFacade(ws, io);
    io._socketsById.set(socket.id, socket);
    socket.join(socket.id); // mirrors Socket.IO's implicit self-id room, used for direct-to-socket sends

    if (!deviceId) {
      socket.emit('errorMsg', { code: 'missing-device-id' });
      socket.disconnect();
      return;
    }

    socket.data.deviceId = deviceId;
    socket.data.name = name;

    io.emit('connection', socket);
  });

  return io;
}

module.exports = { attachWsServer };
