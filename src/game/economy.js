// Server-owned economy prices and grants (the client only displays what
// /me.config sends). All numbers are placeholders: the whole economy is to
// be rebalanced before launch.
const STARTER_GEMS = 100;
const STARTER_HINTS = 3;

// +30s continue on Time's Up, per puzzle attempt: 1st, 2nd, 3rd and later.
// The 1st can also be paid with a rewarded ad, which still counts toward
// the escalation.
const CONTINUE_PRICES = [40, 80, 120];

// Replaying a timed-out puzzle from History.
const REPLAY_PRICE = 30;

// MORE HINTS: gems for a pack, or one hint per rewarded ad (capped per UTC day).
const HINT_PACK = { gems: 20, hints: 3 };
const AD_HINTS_PER_DAY = 5;

// Ranked: hints for each arena reached for the first time.
const ARENA_HINTS = 2;

// Daily Puzzle (one per UTC day, reset at 00:00 UTC): gems for the top 3,
// paid when the day closes. Solves faster than DAILY_MIN_MS are rejected.
const DAILY_PRIZES = [100, 50, 25];
const DAILY_MIN_MS = 10 * 1000;

// Login Gift: the first claim of each UTC day moves one step along this
// 7-day cycle; a missed day starts it over.
const LOGIN_GIFTS = [5, 10, 15, 20, 25, 30, 50];

function continuePrice(index) {
  return CONTINUE_PRICES[Math.min(Math.max(index, 0), CONTINUE_PRICES.length - 1)];
}

const clientConfig = {
  prices: { continue: CONTINUE_PRICES, replay: REPLAY_PRICE, hintPackGems: HINT_PACK.gems, hintPackHints: HINT_PACK.hints },
  adHintsPerDay: AD_HINTS_PER_DAY,
  arenaHints: ARENA_HINTS,
  dailyPrizes: DAILY_PRIZES,
  loginGifts: LOGIN_GIFTS,
};

module.exports = {
  STARTER_GEMS, STARTER_HINTS, CONTINUE_PRICES, REPLAY_PRICE, HINT_PACK, AD_HINTS_PER_DAY, ARENA_HINTS,
  DAILY_PRIZES, DAILY_MIN_MS, LOGIN_GIFTS, continuePrice, clientConfig,
};
