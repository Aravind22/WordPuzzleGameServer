const crypto = require('crypto');
const PlayerStore = require('./PlayerStore');
const { ARENA_WIDTH, ARENA_COUNT, arenaForTrophies } = require('./arena');

// Bots must be indistinguishable from real players in everything the client
// sees (matchStart / wordFound / gameOver payloads), so their identity mirrors
// a real account's: a Firebase-UID-shaped playerId (no "bot" marker -- ids
// reach the client), mostly the same PLAYER-XXXX default name most players
// keep, a random avatar, and trophies close to the human's, in their arena.

const UID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UID_LENGTH = 28;
const DEFAULT_NAME_CHANCE = 0.6;
const TROPHY_SPREAD = 100;

// Player-style handles (all <= PlayerStore.NAME_MAX_LENGTH).
const NAMES = [
  'WordWizard', 'LetterHunter', 'Puzzler', 'QuickFinder', 'SpellBound', 'Lexi', 'GridMaster', 'WordNerd',
  'NightOwl', 'Sunny', 'Maverick', 'Shadow', 'Pixel', 'Nova', 'Ace', 'Blaze', 'Echo', 'Luna', 'Rex', 'Zara',
  'Ninja99', 'Tiger', 'Falcon', 'Storm', 'Ghost', 'Viper', 'Rocket', 'Comet', 'Orion', 'Atlas',
  'Ravi', 'Arjun', 'Priya', 'Ananya', 'Rahul', 'Sneha', 'Vikram', 'Kavya', 'Rohan', 'Isha',
  'Aditya', 'Meera', 'Karthik', 'Divya', 'Sanjay', 'Pooja', 'Nikhil', 'Lakshmi', 'Varun', 'Asha',
  'Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Mia', 'Lucas', 'Sofia', 'Ethan', 'Chloe',
  'Mateo', 'Lucia', 'Diego', 'Camila', 'Hana', 'Yuki', 'Kenji', 'Mei', 'Chen', 'Ali',
  'Fatima', 'Omar', 'Layla', 'Yusuf', 'Amir', 'Sara', 'Leo', 'Ivy', 'Max', 'Zoe',
  'john_d', 'mike77', 'sam', 'alex', 'jess', 'tom', 'kat', 'ben', 'dan', 'lily',
  'raj007', 'anu', 'vicky', 'chinnu', 'bunny', 'pinky', 'sonu', 'monu', 'appu', 'kuttu',
  'WordKing', 'WordQueen', 'Champ', 'TheFinder', 'Seeker', 'Hawkeye', 'Sharp', 'Brainy', 'Clever', 'Smarty',
  'Cool Cat', 'Lazy Panda', 'Happy Fox', 'Mr Words', 'Ms Puzzle', 'Big Brain', 'Lucky Star', 'Red Dragon', 'Blue Jay', 'Wild Wolf',
  'xXProXx', 'gamer_girl', 'noob_master', 'speedy', 'flash', 'turbo', 'zen', 'chill', 'vibes', 'boss',
  'Aaron', 'Bella', 'Carlos', 'Dina', 'Eli', 'Fiona', 'Gabe', 'Hugo', 'Iris', 'Jade',
  'Kiran', 'Leela', 'Manu', 'Nisha', 'Om', 'Pari', 'Rishi', 'Sia', 'Tara', 'Uma',
];

function randomUid() {
  let id = '';
  for (let i = 0; i < UID_LENGTH; i++) id += UID_ALPHABET[crypto.randomInt(UID_ALPHABET.length)];
  return id;
}

function randomName(playerId, avoidName) {
  for (let i = 0; i < 5; i++) {
    const name = Math.random() < DEFAULT_NAME_CHANCE ? PlayerStore.defaultName(playerId) : NAMES[crypto.randomInt(NAMES.length)];
    if (name !== avoidName) return name;
  }
  return PlayerStore.defaultName(playerId);
}

// Within +/- TROPHY_SPREAD of the human, clamped to the human's arena.
function trophiesNear(trophies) {
  const arena = arenaForTrophies(trophies);
  const lo = (arena - 1) * ARENA_WIDTH;
  const hi = arena >= ARENA_COUNT ? Infinity : arena * ARENA_WIDTH - 1;
  const t = trophies + crypto.randomInt(-TROPHY_SPREAD, TROPHY_SPREAD + 1);
  return Math.max(lo, Math.min(hi, t));
}

// A Room player record for a bot facing `human` ({ name, trophies }).
function makeBot(human) {
  const playerId = randomUid();
  return {
    playerId,
    socketId: null,
    name: randomName(playerId, human.name),
    avatar: PlayerStore.randomAvatar(),
    trophies: trophiesNear(human.trophies || 0),
    isBot: true,
  };
}

module.exports = { makeBot };
