const gridGenerator = require('./gridGenerator');
const { WordPicker } = require('./wordPicker');
const { WORDS } = require('./wordBank');
const { DAILY_PRIZES: ALL_PRIZES, DAILY_MIN_MS, streakBonus: bonusFor, monetizationOn } = require('./economy');

// Gem prizes / streak bonuses only while monetization is on (MONETIZATION).
const prizeList = () => (monetizationOn() ? ALL_PRIZES : []);
const streakBonus = (count) => (monetizationOn() ? bonusFor(count) : 0);
const PRIZE_SLOTS = ALL_PRIZES.length;
const { DAY_MS, utcDay, dayStartMs, nextResetMs, previousDay } = require('./utcDay');

const GRID_SIZE = 10;
const WORDS_PER_PUZZLE = 8;
const LEADERBOARD_SIZE = 50;

// Daily #1 (the number in the share text). Set to the launch day.
const FIRST_DAILY = '2026-10-08';
const dailyNumber = (day) => Math.round((dayStartMs(day) - dayStartMs(FIRST_DAILY)) / DAY_MS) + 1;

// Solved, ranked attempts of a day.
const ranked = (day) => ({ day, solvedAt: { $exists: true }, void: { $ne: true } });

function cellsEqual(a, b) {
  return a.length === b.length && a.every((cell, i) => cell.row === b[i].row && cell.col === b[i].col);
}

// One horizontal or vertical step at a time (the generator's directions).
function isStraightLine(cells) {
  if (cells.length < 2) return false;
  const dr = cells[1].row - cells[0].row;
  const dc = cells[1].col - cells[0].col;
  if (!((dr === 0 && Math.abs(dc) === 1) || (dc === 0 && Math.abs(dr) === 1))) return false;
  return cells.every((c, i) => i === 0 || (c.row - cells[i - 1].row === dr && c.col - cells[i - 1].col === dc));
}

// The Daily Puzzle: one puzzle per UTC day, the same for everyone (Casual
// rules, no power-ups, one attempt). The server is authoritative, like a
// multiplayer match: the client only gets the letters and the word list,
// never where the words are. Each swipe is sent here and checked against
// the placements; the server timestamps every word found. Time = the last
// word's timestamp - when the server first handed out the puzzle; ranked by
// time (ties: whoever finished first). When the day ends (00:00 UTC) the
// board closes and the top 3 are paid through the economy ledger.
//
//   daily_puzzles  { _id: day, gridSize, grid, words, placements, createdAt }
//   daily_attempts { _id: day:playerId, day, playerId, name, startedAt,
//                    found: { WORD: ms }, solvedAt?, timeMs?, void?,
//                    rank?, prize?, prizeSeen? }
//   (void = solved faster than DAILY_MIN_MS: kept, but never ranked or paid)
//   daily_results  { _id: day, finalizedAt, players, winners: [{ playerId, name, rank, timeMs, prize }] }
//   players.dailyStreak { day: last solved day, count, best }
//
// Streak: consecutive days with the Daily solved (void solves don't count).
// Reaching a streakBonus length pays gems on the spot (attempt.streak /
// attempt.streakBonus record it for the solved card).
class DailyStore {
  constructor(db, { economyStore, playerStore }) {
    this.players = db.collection('players');
    this.puzzles = db.collection('daily_puzzles');
    this.attempts = db.collection('daily_attempts');
    this.results = db.collection('daily_results');
    this.economyStore = economyStore;
    this.playerStore = playerStore;
    this.picker = new WordPicker(WORDS);
  }

  async init() {
    await this.attempts.createIndex({ day: 1, timeMs: 1, solvedAt: 1 });
    await this.attempts.createIndex({ playerId: 1, day: -1 });
  }

  // Today's puzzle, created on first request. Every word must fit, so a
  // short placement is regenerated. Concurrent first requests converge on
  // whichever insert wins.
  async puzzleFor(day) {
    const existing = await this.puzzles.findOne({ _id: day });
    if (existing) return existing;
    let generated;
    for (let tries = 0; tries < 20; tries++) {
      generated = gridGenerator.generate(this.picker.pick(WORDS_PER_PUZZLE), GRID_SIZE);
      if (generated.placedWords.length === WORDS_PER_PUZZLE) break;
    }
    const doc = {
      _id: day,
      gridSize: generated.gridSize,
      grid: generated.grid.join(''),
      words: generated.placedWords.map((p) => p.word),
      placements: generated.placedWords.map((p) => ({ word: p.word, cells: p.cells })),
      createdAt: Date.now(),
    };
    try {
      await this.puzzles.insertOne(doc);
      return doc;
    } catch (err) {
      if (err.code !== 11000) throw err;
      return this.puzzles.findOne({ _id: day });
    }
  }

  // What the client may see: letters and words, no placements.
  static clientPuzzle(p) {
    return { gridSize: p.gridSize, grid: p.grid, words: p.words };
  }

  // Words already found on this attempt, with their cells (resuming).
  static foundList(puzzle, attempt) {
    const found = attempt?.found || {};
    return puzzle.placements.filter((pl) => found[pl.word]).map((pl) => ({ word: pl.word, cells: pl.cells }));
  }

  // The streak as of today: still alive if the last solve was today or
  // yesterday. { count, best }
  static streakState(streak, today) {
    const alive = streak?.day === today || streak?.day === previousDay(today);
    return { count: alive ? streak.count : 0, best: streak?.best || 0 };
  }

  async streakOf(playerId, today) {
    const doc = await this.players.findOne({ _id: playerId }, { projection: { dailyStreak: 1 } });
    return DailyStore.streakState(doc?.dailyStreak, today);
  }

  // A (non-void) solve of day: extends the streak (or starts a new one) and
  // pays its bonus, if any. The day field is the lock: a day counts once.
  // Returns { count, best, bonus, gems?, hints? }.
  async advanceStreak(playerId, day) {
    const doc = await this.players.findOne({ _id: playerId }, { projection: { dailyStreak: 1 } });
    const prev = doc?.dailyStreak;
    if (prev?.day === day) return { count: prev.count, best: prev.best, bonus: 0 };
    const count = prev?.day === previousDay(day) ? prev.count + 1 : 1;
    const best = Math.max(prev?.best || 0, count);
    const moved = await this.players.updateOne(
      { _id: playerId, 'dailyStreak.day': { $ne: day } },
      { $set: { dailyStreak: { day, count, best } } }
    );
    if (!moved.modifiedCount) return { ...(await this.streakOf(playerId, day)), bonus: 0 };
    const bonus = streakBonus(count);
    if (!bonus) return { count, best, bonus };
    await this.economyStore.ensureWallet(playerId); // starter gems before the $inc creates the field
    const wallet = await this.economyStore.apply(playerId, { item: 'daily-streak', key: day, grant: { gems: bonus }, context: { day, streak: count } });
    return wallet.error ? { count, best, bonus: 0 } : { count, best, bonus, gems: wallet.gems, hints: wallet.hints };
  }

  // The player's state for today (no puzzle): for the home tile and the
  // solved card. Also carries an unseen top-3 prize from an earlier day.
  async status(playerId, now = Date.now()) {
    const day = utcDay(now);
    const attempt = await this.attempts.findOne({ _id: `${day}:${playerId}` });
    const streak = await this.streakOf(playerId, day);
    const out = {
      day,
      number: dailyNumber(day),
      streak: streak.count,
      bestStreak: streak.best,
      streakBonus: attempt?.streakBonus || 0,
      endsAt: nextResetMs(now),
      serverNow: now,
      players: await this.attempts.countDocuments(ranked(day)),
      prizes: prizeList(),
      state: attempt ? (attempt.solvedAt ? 'solved' : 'started') : 'new',
      startedAt: attempt?.startedAt || 0,
      timeMs: attempt?.timeMs || 0,
      rank: attempt?.solvedAt && !attempt.void ? await this.rankOf(attempt) : 0,
    };
    const prize = await this.attempts.findOne(
      { playerId, prize: { $gt: 0 }, prizeSeen: { $ne: true } },
      { sort: { day: -1 } }
    );
    if (prize) {
      const result = await this.results.findOne({ _id: prize.day });
      out.unseenPrize = { day: prize.day, rank: prize.rank, prize: prize.prize, timeMs: prize.timeMs, players: result?.players || 0 };
    }
    return out;
  }

  // Starts (or resumes) today's one attempt and hands out the puzzle. The
  // clock started on the first call; resuming doesn't reset it.
  async start(playerId, now = Date.now()) {
    const day = utcDay(now);
    const puzzle = await this.puzzleFor(day);
    const id = `${day}:${playerId}`;
    try {
      await this.attempts.insertOne({ _id: id, day, playerId, startedAt: now });
    } catch (err) {
      if (err.code !== 11000) throw err;
    }
    const attempt = await this.attempts.findOne({ _id: id });
    return {
      day,
      number: dailyNumber(day),
      streak: (await this.streakOf(playerId, day)).count,
      puzzle: DailyStore.clientPuzzle(puzzle),
      found: DailyStore.foundList(puzzle, attempt),
      startedAt: attempt.startedAt,
      serverNow: now,
      endsAt: nextResetMs(now),
      state: attempt.solvedAt ? 'solved' : 'started',
      timeMs: attempt.timeMs || 0,
    };
  }

  // One swipe of today's attempt: cells = [{ row, col }, ...] in drag
  // order. The server decides whether it's a word and timestamps it; the
  // last word finishes the attempt. Returns
  //   { word: null }                                   not a word (or already found)
  //   { word, cells, foundCount, solved: false }
  //   { word, cells, foundCount, solved: true, timeMs, rank, players, void?,
  //     streak, streakBonus, gems?, hints? }   (gems/hints: after a bonus)
  //   { error }: 'not-started', 'wrong-day' (the day ended), 'solved', 'invalid-cells'
  async submitWord(playerId, { day, cells }, now = Date.now()) {
    if (day !== utcDay(now)) return { error: 'wrong-day' };
    const id = `${day}:${playerId}`;
    const attempt = await this.attempts.findOne({ _id: id });
    if (!attempt) return { error: 'not-started' };
    if (attempt.solvedAt) return { error: 'solved' };
    const puzzle = await this.puzzles.findOne({ _id: day });
    const size = puzzle.gridSize;
    if (!Array.isArray(cells) || cells.length > size
      || !cells.every((c) => Number.isInteger(c?.row) && Number.isInteger(c?.col) && c.row >= 0 && c.row < size && c.col >= 0 && c.col < size)
      || !isStraightLine(cells)) {
      return { error: 'invalid-cells' };
    }
    const path = cells.map((c) => ({ row: c.row, col: c.col }));
    const reversed = [...path].reverse();
    const placement = puzzle.placements.find((pl) => cellsEqual(pl.cells, path) || cellsEqual(pl.cells, reversed));
    if (!placement || attempt.found?.[placement.word]) return { word: null };

    await this.attempts.updateOne({ _id: id, [`found.${placement.word}`]: { $exists: false } }, { $set: { [`found.${placement.word}`]: now } });
    const updated = await this.attempts.findOne({ _id: id });
    const foundCount = Object.keys(updated.found || {}).length;
    const out = { word: placement.word, cells: placement.cells, foundCount, solved: false };
    if (foundCount < puzzle.words.length) return out;

    // Finished: the clock stops at the server's timestamp of the last word.
    const finishedAt = Math.max(...Object.values(updated.found));
    const timeMs = finishedAt - updated.startedAt;
    const { player } = await this.playerStore.getOrCreate(playerId);
    const isVoid = timeMs < DAILY_MIN_MS;
    const finished = await this.attempts.updateOne(
      { _id: id, solvedAt: { $exists: false } },
      { $set: { solvedAt: finishedAt, timeMs, name: player.name, ...(isVoid ? { void: true } : {}) } }
    );
    // Only the request that finished the attempt moves the streak.
    let streak = null;
    if (finished.modifiedCount && !isVoid) {
      streak = await this.advanceStreak(playerId, day);
      await this.attempts.updateOne({ _id: id }, { $set: { streak: streak.count, streakBonus: streak.bonus } });
    }
    const solved = await this.attempts.findOne({ _id: id });
    return {
      ...out,
      solved: true,
      timeMs: solved.timeMs,
      rank: solved.void ? 0 : await this.rankOf(solved),
      players: await this.attempts.countDocuments(ranked(day)),
      ...(solved.void ? { void: true } : {}),
      streak: streak ? streak.count : (await this.streakOf(playerId, day)).count,
      streakBonus: solved.streakBonus || 0,
      ...(streak?.bonus ? { gems: streak.gems, hints: streak.hints } : {}),
    };
  }

  // 1 + everyone faster (or as fast, but earlier).
  async rankOf(attempt) {
    const ahead = await this.attempts.countDocuments({
      ...ranked(attempt.day),
      $or: [{ timeMs: { $lt: attempt.timeMs } }, { timeMs: attempt.timeMs, solvedAt: { $lt: attempt.solvedAt } }],
    });
    return ahead + 1;
  }

  // Board for a day: the top LEADERBOARD_SIZE, the player's own row, and
  // whether it's final (closed and paid).
  async leaderboard(playerId, day, now = Date.now()) {
    const solvedFilter = ranked(day);
    const top = await this.attempts.find(solvedFilter).sort({ timeMs: 1, solvedAt: 1 }).limit(LEADERBOARD_SIZE).toArray();
    const mine = await this.attempts.findOne({ _id: `${day}:${playerId}`, ...ranked(day) });
    const result = await this.results.findOne({ _id: day });
    return {
      day,
      final: !!result,
      endsAt: day === utcDay(now) ? nextResetMs(now) : 0,
      serverNow: now,
      players: await this.attempts.countDocuments(solvedFilter),
      prizes: prizeList(),
      rows: top.map((a, i) => ({ rank: i + 1, name: a.name || 'PLAYER', timeMs: a.timeMs, prize: prizeList()[i] || 0, me: a.playerId === playerId })),
      me: mine ? { rank: await this.rankOf(mine), timeMs: mine.timeMs } : null,
    };
  }

  async markPrizeSeen(playerId, day) {
    await this.attempts.updateOne({ _id: `${day}:${playerId}` }, { $set: { prizeSeen: true } });
  }

  // Closes a finished day: ranks the top 3 and pays them. The results doc
  // is the lock, so running twice (restart, two instances) pays once; the
  // ledger key makes each payout idempotent as well.
  async finalize(day) {
    if (day >= utcDay()) return null; // still running
    if (await this.results.findOne({ _id: day })) return null;
    const top = await this.attempts.find(ranked(day))
      .sort({ timeMs: 1, solvedAt: 1 }).limit(PRIZE_SLOTS).toArray();
    const players = await this.attempts.countDocuments(ranked(day));
    const winners = top.map((a, i) => ({ playerId: a.playerId, name: a.name, rank: i + 1, timeMs: a.timeMs, prize: prizeList()[i] || 0 }));
    try {
      await this.results.insertOne({ _id: day, finalizedAt: Date.now(), players, winners });
    } catch (err) {
      if (err.code === 11000) return null;
      throw err;
    }
    for (const w of winners) {
      // Monetization off: still ranked, but no gems.
      if (w.prize) await this.economyStore.grantDailyPrize(w.playerId, day, w.rank, w.prize);
      await this.attempts.updateOne({ _id: `${day}:${w.playerId}` }, { $set: { rank: w.rank, prize: w.prize } });
    }
    console.log(`[daily] ${day} finalized: ${players} players, winners ${winners.map((w) => `${w.rank}:${w.playerId}`).join(' ')}`);
    return { day, players, winners };
  }

  // Finalizes every past day that has attempts but no results (catches up
  // after downtime), then re-arms for the next 00:00 UTC.
  async finalizePending() {
    const days = await this.attempts.distinct('day', { day: { $lt: utcDay() } });
    const done = new Set(await this.results.distinct('_id', { _id: { $in: days } }));
    for (const day of days.sort()) if (!done.has(day)) await this.finalize(day);
  }

  scheduleFinalizer() {
    const run = () => this.finalizePending().catch((err) => console.error('[daily] finalize failed:', err.message));
    run();
    const arm = () => {
      const wait = nextResetMs() - Date.now() + 5000; // a few seconds past midnight
      this._timer = setTimeout(() => { run(); arm(); }, wait);
    };
    arm();
  }
}

module.exports = DailyStore;
module.exports.previousDay = previousDay;
module.exports.dailyNumber = dailyNumber;
