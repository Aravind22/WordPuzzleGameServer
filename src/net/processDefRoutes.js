const express = require('express');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { monitorEventLoopDelay } = require('perf_hooks');
const { ARENA_COUNT } = require('../game/arena');
const { renderProcessDefPage, PROCESS_DEF_SCRIPT } = require('../web/processDefPage');

// Private server/game metrics dashboard at /processDef, for the operator
// only. It is read-only by construction: the only input it accepts is the
// Basic Auth password, and it only reads OS stats and in-memory counters
// (plus one projection-only player lookup). Nothing here can write, and no
// player ids, names, IPs or versions leave it -- just counts.
//
// Guards, in order:
//   1. Off entirely unless PROCESS_DEF_PASSWORD is set (>= 24 chars).
//   2. HTTPS only (req.secure via the reverse proxy + TRUST_PROXY), or a
//      direct loopback request for local testing. Anything else 404s
//      before the auth challenge, so a browser never sends the password
//      over plain HTTP.
//   3. Lockout: MAX_FAILS_PER_IP bad passwords per IP, and MAX_FAILS_GLOBAL
//      across all IPs, per FAIL_WINDOW_MS. While locked, even the right
//      password is refused.
//   4. Constant-time password compare.
// Stats are computed at most once per STATS_TTL_MS however often it's hit.

const MIN_PASSWORD_LENGTH = 24;
const STATS_TTL_MS = 5000;
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IP = 5;
const MAX_FAILS_GLOBAL = 30;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

function isSecure(req) {
  if (req.secure) return true;
  return LOOPBACK.has(req.socket.remoteAddress) && !req.headers['x-forwarded-for'];
}

// Fixed-window failure counters: per IP and global.
function createLockout() {
  const perIp = new Map(); // ip -> { count, since }
  let global = { count: 0, since: Date.now() };

  const fresh = (entry, now) => entry && now - entry.since < FAIL_WINDOW_MS;

  return {
    isLocked(ip, now = Date.now()) {
      if (fresh(global, now) && global.count >= MAX_FAILS_GLOBAL) return true;
      const entry = perIp.get(ip);
      return fresh(entry, now) && entry.count >= MAX_FAILS_PER_IP;
    },
    recordFailure(ip, now = Date.now()) {
      if (!fresh(global, now)) global = { count: 0, since: now };
      global.count++;
      let entry = perIp.get(ip);
      if (!fresh(entry, now)) {
        entry = { count: 0, since: now };
        perIp.set(ip, entry);
      }
      entry.count++;
      if (perIp.size > 10000) {
        for (const [key, value] of perIp) if (!fresh(value, now)) perIp.delete(key);
      }
      return { ipCount: entry.count, globalCount: global.count };
    },
  };
}

// Returns the password from an `Authorization: Basic ...` header, or null.
// The username is ignored.
function basicAuthPassword(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1 ? null : decoded.slice(colon + 1);
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const t of Object.values(cpu.times)) total += t;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

function createStatsCollector({ io, roomManager, playerStore, db }) {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  let lastCpu = cpuTimes();
  let lastProcCpu = process.cpuUsage();
  let lastAt = process.hrtime.bigint();

  async function serverStats() {
    const now = process.hrtime.bigint();
    const elapsedUs = Number(now - lastAt) / 1000;
    const cpu = cpuTimes();
    const procCpu = process.cpuUsage();
    const totalDelta = cpu.total - lastCpu.total;
    const cpuPercent = totalDelta > 0 ? (1 - (cpu.idle - lastCpu.idle) / totalDelta) * 100 : null;
    const procCpuPercent = elapsedUs > 0 ? ((procCpu.user - lastProcCpu.user + procCpu.system - lastProcCpu.system) / elapsedUs) * 100 : null;
    lastCpu = cpu;
    lastProcCpu = procCpu;
    lastAt = now;

    const loopP99Ms = loopDelay.percentile(99) / 1e6;
    loopDelay.reset();

    let disk = null;
    try {
      const s = await fs.promises.statfs(process.env.PROCESS_DEF_DISK_PATH || '/');
      disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
    } catch (err) {
      console.warn('[processDef] statfs failed:', err.message);
    }

    let dbPingMs = null;
    try {
      const start = process.hrtime.bigint();
      await db.command({ ping: 1 });
      dbPingMs = Number(process.hrtime.bigint() - start) / 1e6;
    } catch (err) {
      console.warn('[processDef] db ping failed:', err.message);
    }

    const mem = process.memoryUsage();
    return {
      cpuCount: os.cpus().length,
      loadAvg: os.loadavg(),
      cpuPercent,
      procCpuPercent,
      memory: { total: os.totalmem(), free: os.freemem() },
      process: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
      disk,
      eventLoopP99Ms: loopP99Ms,
      dbPingMs,
      osUptimeSec: os.uptime(),
      processUptimeSec: process.uptime(),
    };
  }

  async function gameStats() {
    const playerIds = new Set();
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data?.playerId) playerIds.add(socket.data.playerId);
    }

    let byArena = null;
    try {
      const counts = await playerStore.countByArena([...playerIds]);
      byArena = Array.from({ length: ARENA_COUNT }, (_, i) => counts[i + 1] || 0);
    } catch (err) {
      console.warn('[processDef] arena counts failed:', err.message);
    }

    const queueByArena = Array.from({ length: ARENA_COUNT }, () => 0);
    for (const entry of roomManager.queue) {
      if (entry.arena >= 1 && entry.arena <= ARENA_COUNT) queueByArena[entry.arena - 1]++;
    }

    const rooms = { waiting: 0, rankedPlaying: 0, unrankedPlaying: 0, finished: 0, playersInMatch: 0 };
    for (const room of roomManager.rooms.values()) {
      if (room.status === 'playing') {
        if (room.mode === 'ranked') rooms.rankedPlaying++;
        else rooms.unrankedPlaying++;
        rooms.playersInMatch += room.players.filter((p) => p.connected !== false).length;
      } else if (room.status === 'waiting') {
        rooms.waiting++;
      } else {
        rooms.finished++;
      }
    }

    return {
      connections: io.sockets.sockets.size,
      onlinePlayers: playerIds.size,
      byArena,
      queue: roomManager.queue.length,
      queueByArena,
      rooms,
      openRematches: roomManager.rematches.size,
    };
  }

  let cached = null; // { at, promise }
  return function getStats() {
    const now = Date.now();
    if (cached && now - cached.at < STATS_TTL_MS) return cached.promise;
    const promise = Promise.all([serverStats(), gameStats()]).then(([server, game]) => ({ at: now, server, game }));
    cached = { at: now, promise };
    promise.catch(() => {
      if (cached?.promise === promise) cached = null;
    });
    return promise;
  };
}

// Returns the router, or null (route not mounted at all) when no usable
// PROCESS_DEF_PASSWORD is configured.
function createProcessDefRouter({ io, roomManager, playerStore, db, password = process.env.PROCESS_DEF_PASSWORD }) {
  if (!password) return null;
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.warn(`[processDef] disabled: PROCESS_DEF_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
    return null;
  }

  const expectedHash = sha256(password);
  const lockout = createLockout();
  const getStats = createStatsCollector({ io, roomManager, playerStore, db });
  const pageHtml = renderProcessDefPage();
  const router = express.Router();

  router.use((req, res, next) => {
    if (!isSecure(req)) return next('router'); // plain 404, no auth challenge

    res.set({
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    });

    const ip = req.ip;
    if (lockout.isLocked(ip)) return res.status(429).type('text').send('Too many attempts. Try again later.');

    const given = basicAuthPassword(req.headers.authorization);
    if (given !== null && crypto.timingSafeEqual(sha256(given), expectedHash)) return next();

    if (given !== null) {
      const { ipCount, globalCount } = lockout.recordFailure(ip);
      console.warn(`[processDef] bad password from ${ip} (ip ${ipCount}/${MAX_FAILS_PER_IP}, global ${globalCount}/${MAX_FAILS_GLOBAL})`);
    }
    res.set('WWW-Authenticate', 'Basic realm="processDef", charset="UTF-8"');
    res.status(401).type('text').send('Unauthorized');
  });

  router.get('/', (_req, res) => res.type('html').send(pageHtml));
  router.get('/app.js', (_req, res) => res.type('js').send(PROCESS_DEF_SCRIPT));
  router.get('/stats', async (_req, res) => {
    try {
      res.json(await getStats());
    } catch (err) {
      console.error('[processDef] stats failed:', err.message);
      res.status(500).json({ error: 'stats-unavailable' });
    }
  });

  return router;
}

module.exports = { createProcessDefRouter };
