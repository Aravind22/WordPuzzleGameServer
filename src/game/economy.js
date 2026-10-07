// Server-owned economy prices (the client only displays what /me.config
// sends). Gems only for now; owned items (hints, continues) join with the
// Hint feature and the Store.
const STARTER_GEMS = 100;

// +30s continue on Time's Up, per puzzle attempt: 1st, 2nd, 3rd and later.
// The 1st can also be paid with a rewarded ad, which still counts toward
// the escalation.
const CONTINUE_PRICES = [40, 80, 120];

// Replaying a timed-out puzzle from History.
const REPLAY_PRICE = 30;

function continuePrice(index) {
  return CONTINUE_PRICES[Math.min(Math.max(index, 0), CONTINUE_PRICES.length - 1)];
}

const clientConfig = {
  prices: { continue: CONTINUE_PRICES, replay: REPLAY_PRICE },
};

module.exports = { STARTER_GEMS, CONTINUE_PRICES, REPLAY_PRICE, continuePrice, clientConfig };
