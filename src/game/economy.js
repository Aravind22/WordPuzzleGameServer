// Server-owned economy prices and grants (the client only displays what
// /me.config sends). All numbers are placeholders: the whole economy is to
// be rebalanced before launch.
// MONETIZATION=off (free launch build, Plans/Free_Launch_Plan.md): no free
// gem/hint grants -- starter wallet, Daily prizes, streak bonuses, arena
// hints -- until the monetization update. Unset = on.
function monetizationOn() {
  return process.env.MONETIZATION !== 'off';
}

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

// Store > POWER-UPS: the bigger hint pack (the small one is HINT_PACK).
const HINT_PACK_10 = { gems: 60, hints: 10 };

// Store > FREE GEMS: gems per rewarded ad, capped per UTC day.
const AD_GEMS = 10;
const AD_GEMS_PER_DAY = 3;

// Real-money products (Google Play ids). kind: 'consumable' (granted on
// every purchase), 'once' (consumable, but the Store offers it once per
// account), 'permanent' (non-consumable flag) or 'subscription'.
const PRODUCTS = {
  starter_pack: { kind: 'once', grant: { gems: 300, hints: 10 } },
  gems_1: { kind: 'consumable', grant: { gems: 80 } },
  gems_2: { kind: 'consumable', grant: { gems: 500 } },
  gems_3: { kind: 'consumable', grant: { gems: 1200 }, tag: 'MOST POPULAR' },
  gems_4: { kind: 'consumable', grant: { gems: 2500 } },
  gems_5: { kind: 'consumable', grant: { gems: 6500 } },
  gems_6: { kind: 'consumable', grant: { gems: 14000 }, tag: 'BEST VALUE' },
  remove_ads: { kind: 'permanent' },
  forest_pass: { kind: 'subscription' },
};

// Forest Pass: granted once per UTC day while the subscription is active.
const PASS_DAILY = { gems: 20, hints: 1 };

// Rewarded-ad +30s continues: the 1st continue of an attempt only, and at
// most this many per UTC day.
const AD_CONTINUES_PER_DAY = 10;

// How long an ad-hint claim waits for AdMob's SSV callback before falling
// back to the client's word (still capped, flagged unverified).
const AD_SSV_WAIT_MS = 6000;

// Ranked: hints for each arena reached for the first time.
const ARENA_HINTS = 2;

// Daily Puzzle (one per UTC day, reset at 00:00 UTC): gems for the top 3,
// paid when the day closes. Solves faster than DAILY_MIN_MS are rejected.
const DAILY_PRIZES = [100, 50, 25];
const DAILY_MIN_MS = 10 * 1000;

// Login Gift: the first claim of each UTC day moves one step along this
// 7-day cycle; a missed day starts it over.
const LOGIN_GIFTS = [5, 10, 15, 20, 25, 30, 50];

// Daily Puzzle streak: consecutive UTC days with the Daily solved (a void
// solve doesn't count, a missed day starts over). Bonus gems on reaching
// these streak lengths, then the last bonus again every STREAK_REPEAT days.
const STREAK_BONUSES = [[3, 10], [7, 30], [14, 60], [30, 150]];
const STREAK_REPEAT = 30;

function continuePrice(index) {
  return CONTINUE_PRICES[Math.min(Math.max(index, 0), CONTINUE_PRICES.length - 1)];
}

function streakBonus(streak) {
  const exact = STREAK_BONUSES.find(([days]) => days === streak);
  if (exact) return exact[1];
  const [lastDays, lastGems] = STREAK_BONUSES[STREAK_BONUSES.length - 1];
  return streak > lastDays && (streak - lastDays) % STREAK_REPEAT === 0 ? lastGems : 0;
}

const clientConfig = {
  prices: { continue: CONTINUE_PRICES, replay: REPLAY_PRICE, hintPackGems: HINT_PACK.gems, hintPackHints: HINT_PACK.hints },
  adHintsPerDay: AD_HINTS_PER_DAY,
  adContinuesPerDay: AD_CONTINUES_PER_DAY,
  arenaHints: ARENA_HINTS,
  dailyPrizes: DAILY_PRIZES,
  loginGifts: LOGIN_GIFTS,
  streakBonuses: STREAK_BONUSES.map(([days, gems]) => ({ days, gems })),
  streakRepeat: STREAK_REPEAT,
  store: {
    gemPacks: Object.entries(PRODUCTS).filter(([, p]) => p.kind === 'consumable').map(([id, p]) => ({ id, gems: p.grant.gems, tag: p.tag || '' })),
    starter: { id: 'starter_pack', ...PRODUCTS.starter_pack.grant },
    removeAds: 'remove_ads',
    pass: { id: 'forest_pass', dailyGems: PASS_DAILY.gems, dailyHints: PASS_DAILY.hints },
    hintPacks: [
      { item: 'hint-pack', gems: HINT_PACK.gems, hints: HINT_PACK.hints },
      { item: 'hint-pack-10', gems: HINT_PACK_10.gems, hints: HINT_PACK_10.hints },
    ],
    adGems: AD_GEMS,
    adGemsPerDay: AD_GEMS_PER_DAY,
  },
};

module.exports = {
  STARTER_GEMS, STARTER_HINTS, CONTINUE_PRICES, REPLAY_PRICE, HINT_PACK, HINT_PACK_10, AD_HINTS_PER_DAY, AD_GEMS, AD_GEMS_PER_DAY, PRODUCTS, PASS_DAILY, AD_CONTINUES_PER_DAY, AD_SSV_WAIT_MS, ARENA_HINTS,
  monetizationOn, DAILY_PRIZES, DAILY_MIN_MS, LOGIN_GIFTS, STREAK_BONUSES, STREAK_REPEAT, continuePrice, streakBonus, clientConfig,
};
