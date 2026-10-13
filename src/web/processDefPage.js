// Private metrics dashboard served at GET /processDef (see
// net/processDefRoutes.js for the auth/lockout guards). The page is static;
// PROCESS_DEF_SCRIPT is served at /processDef/app.js (the CSP forbids inline
// scripts) and polls /processDef/stats every 5s while the tab is visible.
// Values are only ever written with textContent, never as HTML.

const { ARENA_COUNT, ARENA_WIDTH } = require('../game/arena');

function renderProcessDefPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>processDef</title>
<style>
  :root {
    color-scheme: light;
    --surface-0: #f4f4f2;
    --surface-1: #fcfcfb;
    --border: #e4e3df;
    --track: #ecebe7;
    --text-primary: #0b0b0b;
    --text-secondary: #52514e;
    --text-muted: #7a7974;
    --series-1: #2a78d6;
    --good: #0ca30c;
    --warning: #fab219;
    --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme: dark;
      --surface-0: #121211;
      --surface-1: #1a1a19;
      --border: #2c2c2a;
      --track: #2a2a28;
      --text-primary: #f0efec;
      --text-secondary: #c3c2b7;
      --text-muted: #8f8e86;
      --series-1: #3987e5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px 16px 48px;
    background: var(--surface-0);
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.4;
  }
  main { max-width: 1100px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 20px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); margin: 28px 0 10px; }
  .status { color: var(--text-secondary); font-size: 13px; display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); }
  .dot.live { background: var(--good); }
  .dot.down { background: var(--critical); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(160px, 100%), 1fr)); gap: 12px; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; min-width: 0; }
  .label { color: var(--text-secondary); font-size: 12px; }
  .value { font-size: 26px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 2px; }
  .value.small { font-size: 20px; padding-top: 4px; }
  .sub { color: var(--text-muted); font-size: 12px; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .meter { height: 6px; background: var(--track); border-radius: 3px; margin-top: 10px; overflow: hidden; }
  .meter > div { height: 100%; width: 0; border-radius: 3px; background: var(--good); transition: width 0.4s; }
  .meter.warning > div { background: var(--warning); }
  .meter.critical > div { background: var(--critical); }
  .flag { font-size: 11px; font-weight: 600; margin-left: 6px; color: var(--text-secondary); }
  .arenas { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
  .arena-row { display: grid; grid-template-columns: 120px 1fr 90px; align-items: center; gap: 12px; padding: 5px 0; }
  .arena-name { font-size: 13px; }
  .arena-range { color: var(--text-muted); font-size: 11px; display: block; }
  .bar-track { height: 14px; position: relative; }
  .bar { height: 100%; width: 0; min-width: 0; background: var(--series-1); border-radius: 0 4px 4px 0; transition: width 0.4s; }
  .arena-count { text-align: right; font-variant-numeric: tabular-nums; }
  .arena-count small { color: var(--text-muted); display: block; font-size: 11px; }
  .note { color: var(--text-muted); font-size: 12px; margin-top: 8px; }
  @media (max-width: 480px) {
    .arena-row { grid-template-columns: 84px 1fr 64px; gap: 8px; }
    .value { font-size: 22px; }
    .value.small { font-size: 16px; }
    .tile { padding: 12px; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>processDef</h1>
    <div class="status"><span class="dot" id="dot"></span><span id="status">Connecting…</span></div>
  </header>

  <h2>Server</h2>
  <div class="grid">
    <div class="tile"><div class="label">CPU<span class="flag" id="cpu-flag"></span></div><div class="value" id="cpu">–</div><div class="meter" id="cpu-meter"><div></div></div><div class="sub" id="cpu-sub"></div></div>
    <div class="tile"><div class="label">Memory<span class="flag" id="mem-flag"></span></div><div class="value" id="mem">–</div><div class="meter" id="mem-meter"><div></div></div><div class="sub" id="mem-sub"></div></div>
    <div class="tile"><div class="label">Disk<span class="flag" id="disk-flag"></span></div><div class="value" id="disk">–</div><div class="meter" id="disk-meter"><div></div></div><div class="sub" id="disk-sub"></div></div>
    <div class="tile"><div class="label">Load average (1 / 5 / 15 min)</div><div class="value small" id="load">–</div><div class="sub" id="load-sub"></div></div>
    <div class="tile"><div class="label">Node process</div><div class="value" id="proc">–</div><div class="sub" id="proc-sub"></div></div>
    <div class="tile"><div class="label">Event loop delay (p99)</div><div class="value" id="loop">–</div><div class="sub">Above ~100 ms, players feel lag</div></div>
    <div class="tile"><div class="label">MongoDB ping</div><div class="value" id="db">–</div><div class="sub" id="db-sub"></div></div>
    <div class="tile"><div class="label">Uptime</div><div class="value" id="uptime">–</div><div class="sub" id="uptime-sub"></div></div>
  </div>

  <h2>Game</h2>
  <div class="grid">
    <div class="tile"><div class="label">Players online</div><div class="value" id="online">–</div><div class="sub" id="online-sub"></div></div>
    <div class="tile"><div class="label">In a match</div><div class="value" id="inmatch">–</div><div class="sub" id="inmatch-sub"></div></div>
    <div class="tile"><div class="label">Searching for a match</div><div class="value" id="queue">–</div><div class="sub">Quick Match queue</div></div>
    <div class="tile"><div class="label">Private rooms waiting</div><div class="value" id="waiting">–</div><div class="sub" id="waiting-sub"></div></div>
  </div>

  <h2>Online players by arena</h2>
  <div class="arenas" id="arenas"></div>
  <p class="note">Bars show players online now; the smaller number is how many of them are in the Quick Match queue.</p>
</main>
<script src="/processDef/app.js"></script>
</body>
</html>`;
}

const PROCESS_DEF_SCRIPT = `'use strict';
(function () {
  var ARENA_COUNT = ${ARENA_COUNT};
  var ARENA_WIDTH = ${ARENA_WIDTH};
  var POLL_MS = 5000;
  var $ = function (id) { return document.getElementById(id); };

  // Arena rows are built once, then only their numbers/widths change.
  var arenaRows = [];
  for (var i = 0; i < ARENA_COUNT; i++) {
    var row = document.createElement('div');
    row.className = 'arena-row';
    var name = document.createElement('div');
    name.className = 'arena-name';
    name.textContent = 'Arena ' + (i + 1);
    var range = document.createElement('span');
    range.className = 'arena-range';
    range.textContent = i === ARENA_COUNT - 1 ? (i * ARENA_WIDTH) + '+ trophies' : (i * ARENA_WIDTH) + '–' + ((i + 1) * ARENA_WIDTH - 1);
    name.appendChild(range);
    var track = document.createElement('div');
    track.className = 'bar-track';
    var bar = document.createElement('div');
    bar.className = 'bar';
    track.appendChild(bar);
    var count = document.createElement('div');
    count.className = 'arena-count';
    var n = document.createElement('span');
    n.textContent = '–';
    var q = document.createElement('small');
    count.appendChild(n);
    count.appendChild(q);
    row.appendChild(name);
    row.appendChild(track);
    row.appendChild(count);
    $('arenas').appendChild(row);
    arenaRows.push({ row: row, bar: bar, n: n, q: q });
  }

  function bytes(b) {
    if (b == null) return '–';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var u = 0;
    while (b >= 1024 && u < units.length - 1) { b /= 1024; u++; }
    return (b >= 100 || u === 0 ? b.toFixed(0) : b.toFixed(1)) + ' ' + units[u];
  }
  function pct(v) { return v == null ? '–' : v.toFixed(0) + '%'; }
  function ms(v) { return v == null ? '–' : (v < 10 ? v.toFixed(1) : v.toFixed(0)) + ' ms'; }
  function duration(sec) {
    var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
    return d > 0 ? d + 'd ' + h + 'h' : h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  // Status is carried by the label text too, never by color alone.
  function meter(key, percent) {
    var el = $(key + '-meter');
    var level = percent == null ? '' : percent >= 90 ? 'critical' : percent >= 75 ? 'warning' : '';
    el.className = 'meter' + (level ? ' ' + level : '');
    el.firstElementChild.style.width = percent == null ? '0' : Math.min(100, percent) + '%';
    $(key + '-flag').textContent = level === 'critical' ? '● Critical' : level === 'warning' ? '▲ High' : '';
  }

  function render(s) {
    var srv = s.server, g = s.game;

    $('cpu').textContent = pct(srv.cpuPercent);
    meter('cpu', srv.cpuPercent);
    $('cpu-sub').textContent = srv.cpuCount + ' cores';

    var memUsed = srv.memory.total - srv.memory.free;
    var memPct = memUsed / srv.memory.total * 100;
    $('mem').textContent = pct(memPct);
    meter('mem', memPct);
    $('mem-sub').textContent = bytes(memUsed) + ' of ' + bytes(srv.memory.total);

    if (srv.disk) {
      var diskUsed = srv.disk.total - srv.disk.free;
      var diskPct = diskUsed / srv.disk.total * 100;
      $('disk').textContent = pct(diskPct);
      meter('disk', diskPct);
      $('disk-sub').textContent = bytes(srv.disk.free) + ' free of ' + bytes(srv.disk.total);
    } else {
      $('disk').textContent = '–';
      meter('disk', null);
      $('disk-sub').textContent = 'Unavailable';
    }

    $('load').textContent = srv.loadAvg.map(function (v) { return v.toFixed(2); }).join(' / ');
    var loadPerCore = srv.loadAvg[0] / srv.cpuCount;
    $('load-sub').textContent = (loadPerCore * 100).toFixed(0) + '% of ' + srv.cpuCount + ' cores (1 min)';

    $('proc').textContent = bytes(srv.process.rss);
    $('proc-sub').textContent = 'CPU ' + pct(srv.procCpuPercent) + ' of one core · heap ' + bytes(srv.process.heapUsed);

    $('loop').textContent = ms(srv.eventLoopP99Ms);
    $('db').textContent = srv.dbPingMs == null ? 'Down' : ms(srv.dbPingMs);
    $('db-sub').textContent = srv.dbPingMs == null ? 'Ping failed' : 'Round trip';

    $('uptime').textContent = duration(srv.processUptimeSec);
    $('uptime-sub').textContent = 'Server process · machine up ' + duration(srv.osUptimeSec);

    $('online').textContent = g.onlinePlayers;
    $('online-sub').textContent = g.connections + ' sockets';
    var playing = g.rooms.rankedPlaying + g.rooms.unrankedPlaying;
    $('inmatch').textContent = g.rooms.playersInMatch;
    $('inmatch-sub').textContent = playing + ' matches · ' + g.rooms.rankedPlaying + ' ranked, ' + g.rooms.unrankedPlaying + ' private';
    $('queue').textContent = g.queue;
    $('waiting').textContent = g.rooms.waiting;
    $('waiting-sub').textContent = g.openRematches + ' rematch offers open';

    var counts = g.byArena || [];
    var max = Math.max.apply(null, counts.concat([1]));
    for (var i = 0; i < ARENA_COUNT; i++) {
      var c = counts[i];
      var r = arenaRows[i];
      r.n.textContent = c == null ? '–' : c;
      r.q.textContent = g.queueByArena[i] ? g.queueByArena[i] + ' queued' : '';
      r.bar.style.width = c ? (c / max * 100) + '%' : '0';
      r.row.title = 'Arena ' + (i + 1) + ': ' + (c == null ? 'unavailable' : c + ' online, ' + g.queueByArena[i] + ' queued');
    }
  }

  function setStatus(state, text) {
    $('dot').className = 'dot' + (state ? ' ' + state : '');
    $('status').textContent = text;
  }

  var timer = null;
  var busy = false;
  function poll() {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    fetch('/processDef/stats', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error(res.status === 401 ? 'Signed out, reload the page' : res.status === 429 ? 'Locked out, try later' : 'HTTP ' + res.status);
        return res.json();
      })
      .then(function (s) {
        render(s);
        setStatus('live', 'Live · ' + new Date(s.at).toLocaleTimeString());
      })
      .catch(function (err) { setStatus('down', 'Offline · ' + err.message); })
      .then(function () {
        busy = false;
        if (!document.hidden) timer = setTimeout(poll, POLL_MS);
      });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  poll();
})();
`;

module.exports = { renderProcessDefPage, PROCESS_DEF_SCRIPT };
