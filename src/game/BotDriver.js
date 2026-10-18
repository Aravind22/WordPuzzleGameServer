const { botConfigForArena, CLIENT_INTRO_MS, PLAY_TO_WIN_PACE, PLAY_TO_LOSE_PACE } = require('./botConfig');
const { arenaForTrophies } = require('./arena');

// Testing only: scales every bot delay (e.g. 0.1 for fast scratch tests).
const TIME_SCALE = Number(process.env.BOT_TIME_SCALE) || 1;
const AVG_WORD_LENGTH = 6;
const MIN_DELAY_MS = 1500;
const HURRY_PACE = 0.75; // extra pace multiplier while closing out a win

function between([min, max]) {
  return min + Math.random() * (max - min);
}

// Plays the bot side of a ranked Room: on a timer, "finds" one unfound word
// at a time and hands it to onFind(entry), which goes through the same
// recordFound / wordFound / gameOver path as a human submit. Each match the
// bot decides whether it is playing to win (per the arena's humanWinRate)
// and paces itself off the human's own pace -- see botConfig.js. Paused
// while the human is disconnected.
class BotDriver {
  constructor(room, bot, onFind) {
    this.room = room;
    this.bot = bot;
    this.onFind = onFind;
    this.config = botConfigForArena(arenaForTrophies(room.otherPlayer(bot.playerId)?.trophies || 0));
    this.playToWin = Math.random() >= this.config.humanWinRate;
    this.pace = between(this.playToWin ? PLAY_TO_WIN_PACE : PLAY_TO_LOSE_PACE);
    this.timer = null;
    this.dueAt = 0;
    this.remainingMs = null; // set while paused
    this.pausedMs = 0; // total time paused, left out of the human's pace
    this.pausedAt = 0;
    this.target = null;
    this.hurried = false;
    this.stopped = false;
  }

  // firstWord is a floor for the first find (time to take in the grid), not
  // an extra delay on top of it.
  start() {
    this._schedule(CLIENT_INTRO_MS + Math.max(between(this.config.firstWord) * 1000 * TIME_SCALE, this._nextDelayMs()));
  }

  pause() {
    if (this.stopped || !this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.pausedAt = Date.now();
    this.remainingMs = Math.max(0, this.dueAt - this.pausedAt);
  }

  // A rejoin replays matchStart, so the client runs its intro again first.
  resume() {
    if (this.stopped || this.timer || this.remainingMs == null) return;
    this.pausedMs += Date.now() - this.pausedAt + CLIENT_INTRO_MS;
    const ms = this.remainingMs + CLIENT_INTRO_MS;
    this.remainingMs = null;
    this._schedule(ms);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }

  _schedule(ms) {
    this.dueAt = Date.now() + ms;
    this.timer = setTimeout(() => this._fire(), ms);
    this.timer.unref?.();
  }

  _unfound() {
    return this.room.placedWords.filter((p) => !this.room.foundBy.has(p.word));
  }

  _pickTarget() {
    const left = this._unfound();
    if (left.length === 0) return null;
    if (Math.random() < this.config.shortFirst) {
      const shortest = left.slice().sort((a, b) => a.word.length - b.word.length).slice(0, 3);
      return shortest[Math.floor(Math.random() * shortest.length)];
    }
    return left[Math.floor(Math.random() * left.length)];
  }

  // The human's seconds per word: time up to their last find over words
  // found, with priorSec counted as one extra word so it starts at the prior
  // and drifts toward what they actually do. A human stuck for longer than
  // that on the current word slows the bot down too.
  _humanSecPerWord(now) {
    const human = this.room.otherPlayer(this.bot.playerId);
    const found = human ? human.foundWords.length : 0;
    const playStart = this.room.startedAt + CLIENT_INTRO_MS;
    const sec = (ms) => Math.max(0, ms - this.pausedMs) / 1000 / TIME_SCALE;
    const lastFind = found > 0 ? human.lastFoundAt : playStart;
    const estimate = (this.config.priorSec + sec(lastFind - playStart)) / (1 + found);
    return Math.max(estimate, sec(now - lastFind));
  }

  // 8 words, first to 5 wins: a 4-4 is a tie, so a decisive result is 5-3
  // or better. Playing to lose, the bot stops at 3 words so the human
  // always gets their 5; playing to win, it speeds up once the human is
  // one word from blocking it (3 found).
  _wordsToWin() {
    return Math.floor(this.room.placedWords.length / 2) + 1;
  }

  _capped() {
    return !this.playToWin && this.room.getPlayer(this.bot.playerId).foundWords.length >= this._wordsToWin() - 2;
  }

  _hurrying() {
    const human = this.room.otherPlayer(this.bot.playerId);
    return this.playToWin && !!human && human.foundWords.length >= this._wordsToWin() - 2;
  }

  // Called (via Room.recordFound) after each human find: a bot playing to
  // win may need its pending find sooner now.
  onHumanFound() {
    if (this.stopped || !this.timer || this.hurried || !this._hurrying()) return;
    this.hurried = true;
    const ms = this._nextDelayMs();
    if (Date.now() + ms < this.dueAt) {
      clearTimeout(this.timer);
      this._schedule(ms);
    }
  }

  // Time to find the next word: picks the target now so its length can
  // shape the delay, then applies jitter and a chance of a "stuck" pause.
  _nextDelayMs(now = Date.now()) {
    const c = this.config;
    this.target = this._pickTarget();
    const len = this.target ? this.target.word.length : AVG_WORD_LENGTH;
    const pace = this.pace * (this._hurrying() ? HURRY_PACE : 1);
    const perWord = Math.min(c.slowestSec, Math.max(c.fastestSec, this._humanSecPerWord(now) * pace));
    let sec = perWord * (0.7 + 0.05 * len);
    sec *= 1 + (Math.random() * 2 - 1) * c.jitter;
    if (Math.random() < c.pauseChance) sec += between(c.pause);
    return Math.max(MIN_DELAY_MS, sec * 1000) * TIME_SCALE;
  }

  _fire() {
    this.timer = null;
    if (this.stopped || this.room.status !== 'playing') return;
    // The human may have taken the target in the meantime -- switch to
    // another one straight away (as if spotted while looking for it).
    let entry = this.target;
    if (!entry || this.room.foundBy.has(entry.word)) entry = this._pickTarget();
    if (!entry) return;
    this.onFind(entry);
    if (!this.stopped && this.room.status === 'playing' && !this._capped()) this._schedule(this._nextDelayMs());
  }
}

module.exports = BotDriver;
