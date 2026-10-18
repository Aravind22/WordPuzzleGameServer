// Per-arena tuning for ranked (Quick Match) bots -- see BotDriver.js.
//
// A bot doesn't play at a fixed speed (win rates would then be ~0% or ~100%
// depending only on whether the human is faster). Each match it decides up
// front whether it is playing to win (chance 1 - humanWinRate), then paces
// itself off this human's own pace -- a bit faster when playing to win, a bit
// slower when not -- clamped to the arena's [fastestSec, slowestSec], so a
// very fast human still beats an arena-1 bot and a very slow one still loses
// to an arena-8 bot. Tune from the `[bot] match` log lines (server log).
//
//   humanWinRate  target share of bot matches the human wins
//   priorSec      assumed human seconds per word before they find any
//   fastestSec    bot never finds words faster than this (s/word)...
//   slowestSec    ...or slower than this
//   firstWord     [min, max] extra seconds before the bot's first word
//   jitter        +/- fraction applied to every delay
//   pauseChance   chance a word gets a "stuck" pause of `pause` [min, max] seconds
//   shortFirst    0..1: chance the bot goes for one of the shortest words left
const BOT_ARENAS = {
  1: { humanWinRate: 0.65, priorSec: 14, fastestSec: 8, slowestSec: 30, firstWord: [3, 6], jitter: 0.35, pauseChance: 0.12, pause: [2, 5], shortFirst: 0.7 },
  2: { humanWinRate: 0.62, priorSec: 13, fastestSec: 7, slowestSec: 28, firstWord: [3, 6], jitter: 0.35, pauseChance: 0.11, pause: [2, 5], shortFirst: 0.65 },
  3: { humanWinRate: 0.6, priorSec: 12, fastestSec: 6.5, slowestSec: 26, firstWord: [2, 5], jitter: 0.33, pauseChance: 0.1, pause: [2, 4], shortFirst: 0.6 },
  4: { humanWinRate: 0.58, priorSec: 11, fastestSec: 6, slowestSec: 24, firstWord: [2, 5], jitter: 0.33, pauseChance: 0.09, pause: [2, 4], shortFirst: 0.55 },
  5: { humanWinRate: 0.56, priorSec: 10, fastestSec: 5.5, slowestSec: 22, firstWord: [2, 4], jitter: 0.3, pauseChance: 0.08, pause: [2, 4], shortFirst: 0.5 },
  6: { humanWinRate: 0.54, priorSec: 9, fastestSec: 5, slowestSec: 20, firstWord: [2, 4], jitter: 0.3, pauseChance: 0.07, pause: [2, 4], shortFirst: 0.45 },
  7: { humanWinRate: 0.52, priorSec: 8, fastestSec: 4.5, slowestSec: 18, firstWord: [1, 3], jitter: 0.28, pauseChance: 0.06, pause: [2, 3], shortFirst: 0.4 },
  8: { humanWinRate: 0.5, priorSec: 7, fastestSec: 4, slowestSec: 16, firstWord: [1, 3], jitter: 0.28, pauseChance: 0.05, pause: [2, 3], shortFirst: 0.35 },
};

// Pace multipliers on the human's estimated s/word (lower = faster bot).
const PLAY_TO_WIN_PACE = [0.6, 0.78];
const PLAY_TO_LOSE_PACE = [1.25, 1.55];

function botConfigForArena(arena) {
  return BOT_ARENAS[arena] || BOT_ARENAS[1];
}

// The client shows a VS intro + 3-2-1 countdown (~4.5s after matchStart,
// plus the scene load) before the human can touch the board; the bot's clock
// starts after it so it never scores before the human could have.
const CLIENT_INTRO_MS = 5000;

module.exports = { BOT_ARENAS, botConfigForArena, CLIENT_INTRO_MS, PLAY_TO_WIN_PACE, PLAY_TO_LOSE_PACE };
