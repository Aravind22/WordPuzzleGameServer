const gridGenerator = require('./gridGenerator');
const { WordPicker } = require('./wordPicker');
const { WORDS } = require('./wordBank');

const GRID_SIZE = 10;
const WORDS_PER_PUZZLE = 8;
const DISCONNECT_GRACE_MS = Number(process.env.DISCONNECT_GRACE_MS) || 20 * 1000;
const ABANDONED_WAITING_MS = 5 * 60 * 1000;

// Shared across all rooms so the cooldown (avoid repeating recent puzzles)
// applies server-wide, same spirit as the single-player WordPicker instance.
const sharedWordPicker = new WordPicker(WORDS);

function majorityThreshold(totalWords) {
  return Math.floor(totalWords / 2) + 1;
}

function cellsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((cell, i) => cell.row === b[i].row && cell.col === b[i].col);
}

function isStraightLine(cells) {
  if (cells.length < 2) return false;
  const rowDelta = cells[1].row - cells[0].row;
  const colDelta = cells[1].col - cells[0].col;
  // Only horizontal or vertical, one cell step at a time (matches
  // gridGenerator's placement directions).
  const isHorizontal = rowDelta === 0 && (colDelta === 1 || colDelta === -1);
  const isVertical = colDelta === 0 && (rowDelta === 1 || rowDelta === -1);
  if (!isHorizontal && !isVertical) return false;

  for (let i = 1; i < cells.length; i++) {
    const dr = cells[i].row - cells[i - 1].row;
    const dc = cells[i].col - cells[i - 1].col;
    if (dr !== rowDelta || dc !== colDelta) return false;
  }
  return true;
}

class Room {
  constructor(id) {
    this.id = id;
    this.players = []; // { deviceId, socketId, name, foundWords: [], connected }
    this.grid = null;
    this.gridSize = GRID_SIZE;
    this.placedWords = []; // [{ word, cells }]
    this.foundBy = new Map(); // word -> deviceId
    this.foundOrder = [];
    this.status = 'waiting'; // waiting -> playing -> finished
    this.winner = null; // deviceId | 'tie' | null
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.disconnectTimers = new Map(); // deviceId -> Timeout
  }

  touch() {
    this.lastActivityAt = Date.now();
  }

  isAbandoned(now = Date.now()) {
    if (this.status === 'waiting') {
      return now - this.lastActivityAt > ABANDONED_WAITING_MS;
    }
    if (this.status === 'playing') {
      return this.players.every((p) => !p.connected);
    }
    return this.status === 'finished';
  }

  isFull() {
    return this.players.length >= 2;
  }

  hasStarted() {
    return this.status !== 'waiting';
  }

  addPlayer({ deviceId, socketId, name }) {
    const player = { deviceId, socketId, name, foundWords: [], connected: true };
    this.players.push(player);
    this.touch();
    return player;
  }

  getPlayer(deviceId) {
    return this.players.find((p) => p.deviceId === deviceId);
  }

  otherPlayer(deviceId) {
    return this.players.find((p) => p.deviceId !== deviceId);
  }

  start() {
    const words = sharedWordPicker.pick(WORDS_PER_PUZZLE);
    const { grid, gridSize, placedWords } = gridGenerator.generate(words, GRID_SIZE);
    this.grid = grid;
    this.gridSize = gridSize;
    this.placedWords = placedWords;
    this.status = 'playing';
    this.touch();
  }

  // Array shape (not a deviceId-keyed object) so the Unity client can
  // deserialize it with JsonUtility, which requires fixed field names and
  // can't handle dynamic dictionary keys.
  scores() {
    return this.players.map((p) => ({ deviceId: p.deviceId, count: p.foundWords.length }));
  }

  totalWordCount() {
    return this.placedWords.length;
  }

  // Validates a submitted cell path against the authoritative grid/placedWords.
  // Returns the matched placedWord entry, or null if invalid/already found.
  validateSubmission(cells) {
    if (!Array.isArray(cells) || !isStraightLine(cells)) return null;

    const reversed = [...cells].reverse();
    for (const entry of this.placedWords) {
      if (this.foundBy.has(entry.word)) continue;
      if (entry.cells.length !== cells.length) continue;
      if (cellsEqual(entry.cells, cells) || cellsEqual(entry.cells, reversed)) {
        return entry;
      }
    }
    return null;
  }

  // Records a found word for deviceId. Caller must have already validated
  // via validateSubmission. Returns { scores, gameOver, winner }.
  recordFound(entry, deviceId) {
    this.foundBy.set(entry.word, deviceId);
    this.foundOrder.push({ word: entry.word, deviceId });
    const player = this.getPlayer(deviceId);
    player.foundWords.push(entry.word);
    this.touch();

    return this.checkWinCondition();
  }

  checkWinCondition() {
    const total = this.totalWordCount();
    const threshold = majorityThreshold(total);
    const scores = this.scores();

    for (const p of this.players) {
      if (p.foundWords.length >= threshold) {
        this.status = 'finished';
        this.winner = p.deviceId;
        return { scores, gameOver: true, winner: this.winner };
      }
    }

    if (this.foundBy.size >= total) {
      // All words found, nobody reached majority -> tie (e.g. 4-4 on 8 words).
      this.status = 'finished';
      this.winner = 'tie';
      return { scores, gameOver: true, winner: this.winner };
    }

    return { scores, gameOver: false, winner: null };
  }

  markDisconnected(deviceId) {
    const player = this.getPlayer(deviceId);
    if (player) player.connected = false;
    this.touch();
  }

  markReconnected(deviceId, socketId) {
    const player = this.getPlayer(deviceId);
    if (player) {
      player.connected = true;
      player.socketId = socketId;
    }
    this.touch();
    this.clearDisconnectTimer(deviceId);
  }

  clearDisconnectTimer(deviceId) {
    const timer = this.disconnectTimers.get(deviceId);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(deviceId);
    }
  }

  // Starts the grace-period timer for a disconnected player. onExpire is
  // called if they don't reconnect in time (caller declares the other
  // player the winner and closes the room).
  startDisconnectTimer(deviceId, onExpire) {
    this.clearDisconnectTimer(deviceId);
    const timer = setTimeout(() => {
      this.disconnectTimers.delete(deviceId);
      onExpire(deviceId);
    }, DISCONNECT_GRACE_MS);
    this.disconnectTimers.set(deviceId, timer);
  }

  clearAllTimers() {
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
  }
}

Room.DISCONNECT_GRACE_MS = DISCONNECT_GRACE_MS;
Room.GRID_SIZE = GRID_SIZE;
Room.WORDS_PER_PUZZLE = WORDS_PER_PUZZLE;

module.exports = Room;
