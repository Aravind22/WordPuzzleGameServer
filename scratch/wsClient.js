// Tiny Socket.IO-like wrapper over `ws` for the scratch verification
// scripts, matching the wsAdapter.js envelope: { type, payload } messages,
// authenticated with a Firebase ID token in the upgrade request's
// Authorization header (same as the Unity client).
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class TestClient extends EventEmitter {
  constructor(url, user) {
    super();
    this.id = user?.uid;
    this._queue = [];
    const headers = user?.idToken ? { Authorization: `Bearer ${user.idToken}` } : {};
    this.ws = new WebSocket(url, { headers });
    this.ws.on('open', () => {
      for (const raw of this._queue) this.ws.send(raw);
      this._queue = [];
      super.emit('connect');
    });
    this.ws.on('unexpected-response', (_req, res) => super.emit('rejected', res.statusCode));
    this.ws.on('error', (err) => super.emit('wsError', err));
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      super.emit(msg.type, msg.payload);
    });
  }

  // Queues sends made before the handshake finishes (mirrors socket.io-client's
  // buffering) so callers don't have to wait for 'connect' before emitting.
  emit(type, payload) {
    const raw = JSON.stringify({ type, payload });
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
    } else {
      this._queue.push(raw);
    }
  }

  close() {
    this.ws.close();
  }
}

module.exports = { connect: (url, user) => new TestClient(url, user) };
