// Lifetime player stats (the client's STATS tab), kept per player so they
// follow the account to a new device. Mirrors the client's PlayerStatsStore:
// the same field names (the client parses them with Unity's JsonUtility, so
// "none yet" is -1 or '', never null) and the same rules for each game.
//
// The client sends finished games as events; it does the playing, so these
// are client-reported (vanity numbers -- nothing is paid out from them).
// Everything is clamped to sane ranges.

const DIFFICULTIES = 4;
const MAX_EVENTS = 50;       // per request
const KEEP_EVENT_IDS = 500;  // recent ids, so a retried batch never counts twice
const MAX_SECONDS = 24 * 3600;
const MAX_COUNT = 1e9;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;   // the player's local day, 'YYYY-MM-DD'
const WORD = /^[A-Z]{1,24}$/;
const OUTCOMES = ['solved', 'replay', 'unsolved'];
const RESULTS = ['win', 'loss', 'draw'];

function emptyStats() {
  return {
    soloPlayed: 0, firstTrySolves: 0, replaySolves: 0, notSolved: 0,
    fastestSolve: -1, fastestDifficulty: 0, slowestSolve: -1, slowestDifficulty: 0,
    solveSecondsTotal: 0,
    solvedByDifficulty: Array(DIFFICULTIES).fill(0),
    bestByDifficulty: Array(DIFFICULTIES).fill(-1),
    cleanSolves: 0, hintsUsed: 0, continuesUsed: 0,
    secondsPlayed: 0, wordsFound: 0, longestWord: '',
    daysPlayed: 0, lastDay: '', dayStreak: 0, bestDayStreak: 0,
    dailySolves: 0, bestDailyRank: 0, bestDailyMs: -1,
    matches: 0, wins: 0, losses: 0, draws: 0, winStreak: 0, bestWinStreak: 0, bestMatchScore: 0,
    peakTrophies: 0,
  };
}

function num(value, min, max, int = true) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = min;
  n = Math.min(max, Math.max(min, n));
  return int ? Math.floor(n) : n;
}

const word = (value) => (typeof value === 'string' && WORD.test(value) ? value : '');
const day = (value) => (typeof value === 'string' && DAY.test(value) ? value : '');

// A stored or client-sent stats object, every field present and in range.
function cleanStats(raw) {
  const s = emptyStats();
  if (!raw || typeof raw !== 'object') return s;
  for (const key of Object.keys(s)) {
    const v = raw[key];
    if (Array.isArray(s[key])) {
      const fill = s[key][0];
      s[key] = s[key].map((_, i) => (Array.isArray(v) && v[i] !== undefined
        ? num(v[i], fill, key === 'bestByDifficulty' ? MAX_SECONDS : MAX_COUNT, key !== 'bestByDifficulty')
        : fill));
    } else if (key === 'longestWord') s[key] = word(v);
    else if (key === 'lastDay') s[key] = day(v);
    else if (key === 'fastestDifficulty' || key === 'slowestDifficulty') s[key] = num(v, 0, DIFFICULTIES - 1);
    else if (['fastestSolve', 'slowestSolve'].includes(key)) s[key] = num(v, -1, MAX_SECONDS, false);
    else if (['solveSecondsTotal', 'secondsPlayed'].includes(key)) s[key] = num(v, 0, MAX_COUNT, false);
    else if (key === 'bestDailyMs') s[key] = num(v, -1, MAX_SECONDS * 1000);
    else s[key] = num(v, 0, MAX_COUNT);
  }
  return s;
}

// One finished game from the client, or null if it isn't one.
function cleanEvent(raw) {
  if (!raw || typeof raw !== 'object' || !ID.test(raw.id || '')) return null;
  const base = { id: raw.id, day: day(raw.day), words: num(raw.words, 0, 200), longestWord: word(raw.longestWord) };
  switch (raw.type) {
    case 'puzzle':
      if (!OUTCOMES.includes(raw.outcome)) return null;
      return {
        ...base, type: 'puzzle', outcome: raw.outcome,
        difficulty: num(raw.difficulty, 0, DIFFICULTIES - 1),
        seconds: num(raw.seconds, 0, MAX_SECONDS, false),
        hints: num(raw.hints, 0, 1000), continues: num(raw.continues, 0, 1000),
      };
    case 'daily':
      return {
        ...base, type: 'daily', void: !!raw.void,
        ms: num(raw.ms, 0, MAX_SECONDS * 1000), rank: num(raw.rank, 0, MAX_COUNT),
      };
    case 'match':
      if (!RESULTS.includes(raw.result)) return null;
      return { ...base, type: 'match', result: raw.result, score: num(raw.score, 0, 200) };
    default:
      return null;
  }
}

// POST /me/stats body -> { seedId, seed, events }, or null if malformed.
// seed: the stats a device had before it started syncing (sent once).
function cleanBatch(body) {
  if (!body || typeof body !== 'object') return null;
  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length > MAX_EVENTS) return null;
  const cleaned = events.map(cleanEvent);
  if (cleaned.includes(null)) return null;
  const seedId = typeof body.seedId === 'string' && body.seedId !== '' ? body.seedId : null;
  if (seedId && !ID.test(seedId)) return null;
  return { seedId, seed: seedId ? cleanStats(body.seed) : null, events: cleaned };
}

function dayNumber(d) {
  return Math.round(Date.parse(`${d}T00:00:00Z`) / 86400000);
}

// Days with at least one finished game, and the run of consecutive ones.
// Out-of-order days don't move it.
function addDay(s, d) {
  if (!d) return;
  if (s.lastDay && dayNumber(d) <= dayNumber(s.lastDay)) return;
  s.dayStreak = s.lastDay && dayNumber(d) - dayNumber(s.lastDay) === 1 ? s.dayStreak + 1 : 1;
  s.bestDayStreak = Math.max(s.bestDayStreak, s.dayStreak);
  s.daysPlayed++;
  s.lastDay = d;
}

function addWords(s, e) {
  s.wordsFound += e.words;
  if (e.longestWord.length > s.longestWord.length) s.longestWord = e.longestWord;
}

function applyEvent(s, e) {
  if (e.type === 'puzzle') {
    s.soloPlayed++;
    s.hintsUsed += e.hints;
    s.continuesUsed += e.continues;
    s.secondsPlayed += e.seconds;
    if (e.outcome === 'unsolved') s.notSolved++;
    else {
      if (e.outcome === 'replay') s.replaySolves++;
      else s.firstTrySolves++;
      const t = e.seconds;
      const d = e.difficulty;
      s.solveSecondsTotal += t;
      s.solvedByDifficulty[d]++;
      if (s.bestByDifficulty[d] < 0 || t < s.bestByDifficulty[d]) s.bestByDifficulty[d] = t;
      if (s.fastestSolve < 0 || t < s.fastestSolve) { s.fastestSolve = t; s.fastestDifficulty = d; }
      if (t > s.slowestSolve) { s.slowestSolve = t; s.slowestDifficulty = d; }
      if (e.hints === 0 && e.continues === 0) s.cleanSolves++;
    }
  } else if (e.type === 'daily') {
    s.dailySolves++;
    if (!e.void) {
      if (e.rank > 0 && (s.bestDailyRank === 0 || e.rank < s.bestDailyRank)) s.bestDailyRank = e.rank;
      if (e.ms > 0 && (s.bestDailyMs < 0 || e.ms < s.bestDailyMs)) s.bestDailyMs = e.ms;
    }
    if (e.ms > 0) s.secondsPlayed += e.ms / 1000;
  } else if (e.type === 'match') {
    s.matches++;
    if (e.result === 'win') {
      s.wins++;
      s.winStreak++;
      s.bestWinStreak = Math.max(s.bestWinStreak, s.winStreak);
    } else {
      if (e.result === 'draw') s.draws++;
      else s.losses++;
      s.winStreak = 0;
    }
    s.bestMatchScore = Math.max(s.bestMatchScore, e.score);
  }
  addWords(s, e);
  addDay(s, e.day);
}

const minKnown = (a, b) => (a < 0 ? b : b < 0 ? a : Math.min(a, b));

// Folds b (another device's earlier games, or a merged guest) into a: the
// games are different ones, so totals add and bests combine.
function mergeStats(a, b) {
  for (const key of ['soloPlayed', 'firstTrySolves', 'replaySolves', 'notSolved', 'solveSecondsTotal', 'cleanSolves',
    'hintsUsed', 'continuesUsed', 'secondsPlayed', 'wordsFound', 'daysPlayed', 'dailySolves',
    'matches', 'wins', 'losses', 'draws']) a[key] += b[key];
  for (let i = 0; i < DIFFICULTIES; i++) {
    a.solvedByDifficulty[i] += b.solvedByDifficulty[i];
    a.bestByDifficulty[i] = minKnown(a.bestByDifficulty[i], b.bestByDifficulty[i]);
  }
  if (b.fastestSolve >= 0 && (a.fastestSolve < 0 || b.fastestSolve < a.fastestSolve)) {
    a.fastestSolve = b.fastestSolve;
    a.fastestDifficulty = b.fastestDifficulty;
  }
  if (b.slowestSolve > a.slowestSolve) {
    a.slowestSolve = b.slowestSolve;
    a.slowestDifficulty = b.slowestDifficulty;
  }
  if (b.longestWord.length > a.longestWord.length) a.longestWord = b.longestWord;
  if (b.lastDay && (!a.lastDay || dayNumber(b.lastDay) > dayNumber(a.lastDay))) {
    a.lastDay = b.lastDay;
    a.dayStreak = b.dayStreak;
  } else if (b.lastDay && b.lastDay === a.lastDay) a.dayStreak = Math.max(a.dayStreak, b.dayStreak);
  if (b.bestDailyRank > 0 && (a.bestDailyRank === 0 || b.bestDailyRank < a.bestDailyRank)) a.bestDailyRank = b.bestDailyRank;
  a.bestDailyMs = minKnown(a.bestDailyMs, b.bestDailyMs);
  if (a.matches === b.matches) a.winStreak = b.winStreak; // a had none of its own
  for (const key of ['bestDayStreak', 'bestWinStreak', 'bestMatchScore', 'peakTrophies']) a[key] = Math.max(a[key], b[key]);
  return a;
}

module.exports = { emptyStats, cleanStats, cleanBatch, applyEvent, mergeStats, KEEP_EVENT_IDS, MAX_EVENTS };
