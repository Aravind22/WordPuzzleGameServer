const ARENA_WIDTH = 500;
const ARENA_COUNT = 8;

// 8 arenas, 500 trophies wide each (0-499, 500-999, ..., 3000-3499), with
// the 8th arena open-ended above 3500. Mirrored client-side in
// Assets/Scripts/Network/ArenaUtil.cs -- keep both in sync if this changes.
function arenaForTrophies(trophies) {
  return Math.min(ARENA_COUNT, Math.floor(trophies / ARENA_WIDTH) + 1);
}

module.exports = { arenaForTrophies, ARENA_WIDTH, ARENA_COUNT };
