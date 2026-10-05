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
const debug = require('debug');
const { verifyAuthorizationHeader } = require('../auth/firebaseAuth');

// 'ws:conn' traces connect/disconnect lifecycle; 'ws:msg' traces every frame
// in/out and is the noisiest namespace, kept separate so it can be left off
// (e.g. `DEBUG=ws:conn,mm,socket`) while still tracing everything else.
const logConn = debug('ws:conn');
const logMsg = debug('ws:msg');

class SocketFacade extends EventEmitter {
  constructor(ws, io) {
    super();
    this.id = randomUUID();
    this.shortId = this.id.slice(0, 8);
    this.ws = ws;
    this.data = {};
    this._io = io;
    this._rooms = new Set();

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        console.error(`[ws:msg] ${this.shortId} bad JSON: ${raw.toString()} (${err.message})`);
        return;
      }
      if (!msg || typeof msg.type !== 'string') {
        console.error(`[ws:msg] ${this.shortId} malformed message (no .type):`, msg);
        return;
      }
      logMsg('%s <- %s %o', this.shortId, msg.type, msg.payload ?? '');
      // Dispatches to this socket's own `.on(type, cb)` listeners. Uses the
      // base EventEmitter behavior directly since `.emit` is overridden
      // below to mean "send to the client" instead.
      super.emit(msg.type, msg.payload);
    });

    ws.on('error', (err) => {
      console.error(`[ws:conn] ${this.shortId} socket error: ${err.message}`);
    });

    ws.on('close', (code, reason) => {
      logConn('%s closed code=%s %s', this.shortId, code, reason?.toString() ?? '');
      for (const room of this._rooms) this._io._removeFromRoom(room, this);
      this._io._removeSocket(this);
      super.emit('disconnect');
    });
  }

  // Overridden: sending TO the client over the wire, not local pub/sub
  // (mirrors Socket.IO's socket.emit semantics).
  emit(type, payload) {
    if (this.ws.readyState === this.ws.OPEN) {
      logMsg('%s -> %s %o', this.shortId, type, payload ?? '');
      this.ws.send(JSON.stringify({ type, payload }));
    } else {
      console.warn(`[ws:msg] ${this.shortId} dropped ${type}, readyState=${this.ws.readyState}`);
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
// `io`-shaped facade. The client authenticates in the upgrade request's
// Authorization header (Firebase ID token). verifyClient checks the token
// AND loads the player before the handshake completes, so socket.data is
// fully populated before the first message can arrive -- an async lookup
// after 'connection' would race messages sent straight after open.
function attachWsServer(server, { playerStore }) {
  const io = new IoFacade();
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      verifyAuthorizationHeader(info.req.headers.authorization)
        .then((uid) => playerStore.getOrCreate(uid))
        .then(({ player }) => {
          info.req.player = player;
          done(true);
        })
        .catch((err) => {
          logConn('handshake rejected: %s', err.message);
          done(false, 401, 'Unauthorized');
        });
    },
  });

  wss.on('connection', (ws, req) => {
    const { playerId, name } = req.player;

    const socket = new SocketFacade(ws, io);
    io._socketsById.set(socket.id, socket);
    socket.join(socket.id); // mirrors Socket.IO's implicit self-id room, used for direct-to-socket sends

    logConn('%s connected playerId=%s name=%s', socket.shortId, playerId, name);

    socket.data.playerId = playerId;
    socket.data.name = name;

    io.emit('connection', socket);
  });

  wss.on('error', (err) => {
    console.error('[ws:conn] server error:', err.message);
  });

  return io;
}

module.exports = { attachWsServer };
