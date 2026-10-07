// The game's one global day: 00:00 to 24:00 UTC (Daily Puzzle, Login Gift,
// daily caps). Days are 'YYYY-MM-DD' strings.
const DAY_MS = 24 * 60 * 60 * 1000;

const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
const dayStartMs = (day) => Date.parse(`${day}T00:00:00.000Z`);
const nextResetMs = (ms = Date.now()) => dayStartMs(utcDay(ms)) + DAY_MS;
const previousDay = (day) => utcDay(dayStartMs(day) - DAY_MS);

module.exports = { DAY_MS, utcDay, dayStartMs, nextResetMs, previousDay };
