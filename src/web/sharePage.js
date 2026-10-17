// Landing page for a shared puzzle link, GET /p/:code. With the app
// installed and the link verified (Android App Links, see assetlinks.json in
// server.js) Android opens the game straight away and this page is never
// shown; otherwise (in-app browsers, desktop, app not installed) it offers
// "Open in the app" (an intent:// link that falls back to the Play Store)
// and "Get it on Google Play" (carrying the code through the install as the
// Play install referrer, so the first launch opens the puzzle).
const PACKAGE = 'com.runiclabs.wordsearch';
const APP_NAME = 'Word Search - Multiplayer';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatTime(seconds) {
  const total = Math.floor(Number(seconds) || 0);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function playStoreUrl(code) {
  const referrer = code ? `&referrer=${encodeURIComponent(`puzzle=${code}`)}` : '';
  return `https://play.google.com/store/apps/details?id=${PACKAGE}${referrer}`;
}

// record: the stored share (null when the code is unknown).
function renderSharePage({ origin, code, record }) {
  const name = record && record.sharedByName ? record.sharedByName : null;
  const time = record && record.sharedByTimeSeconds > 0 ? formatTime(record.sharedByTimeSeconds) : null;
  const words = record && Array.isArray(record.words) ? record.words.length : 0;

  let headline;
  let detail;
  if (!record) {
    headline = 'This puzzle link has expired';
    detail = `Get ${APP_NAME} and play a new puzzle.`;
  } else if (time) {
    headline = `${name || 'A friend'} solved this puzzle in ${time}`;
    detail = `Can you beat that time? ${words} words are hidden in the grid.`;
  } else {
    headline = `${name || 'A friend'} challenged you to a puzzle`;
    detail = `${words} words are hidden in the grid. Can you find them all?`;
  }

  const pageUrl = `${origin}/p/${code}`;
  const store = playStoreUrl(record ? code : null);
  const intentUrl = `intent://${pageUrl.replace(/^https?:\/\//, '')}#Intent;scheme=https;package=${PACKAGE};`
    + `S.browser_fallback_url=${encodeURIComponent(store)};end`;
  const image = `${origin}/share-card.png`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(headline)} - ${APP_NAME}</title>
<meta name="description" content="${escapeHtml(detail)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${APP_NAME}">
<meta property="og:title" content="${escapeHtml(headline)}">
<meta property="og:description" content="${escapeHtml(detail)}">
<meta property="og:url" content="${escapeHtml(pageUrl)}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1080">
<meta property="og:image:height" content="1920">
<meta name="twitter:card" content="summary_large_image">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #FFF4DA;
    background: #1d3a2b url("/share-card.png") center top / cover no-repeat;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
  }
  .card {
    width: 100%;
    max-width: 420px;
    background: rgba(42, 20, 8, 0.86);
    border: 3px solid #8E5A30;
    border-radius: 20px;
    padding: 28px 22px;
    text-align: center;
  }
  h1 { font-size: 24px; line-height: 1.25; margin: 0 0 10px; color: #FFE58A; }
  p { margin: 0 0 22px; line-height: 1.5; }
  .code { font-size: 14px; color: #E8C9A0; margin: 18px 0 0; }
  .code b { letter-spacing: 3px; color: #FFF4DA; }
  a.button {
    display: block;
    margin: 12px 0 0;
    padding: 15px 18px;
    border-radius: 14px;
    font-weight: 700;
    font-size: 17px;
    text-decoration: none;
  }
  .open { background: #F5B43C; color: #2A1408; }
  .play { background: #2F7D5B; color: #FFFFFF; }
</style>
</head>
<body>
<main class="card">
  <h1>${escapeHtml(headline)}</h1>
  <p>${escapeHtml(detail)}</p>
  ${record ? `<a class="button open" href="${escapeHtml(intentUrl)}">Open in the app</a>` : ''}
  <a class="button play" href="${escapeHtml(store)}">Get it on Google Play</a>
  ${record ? `<p class="code">Puzzle code <b>${escapeHtml(code)}</b></p>` : ''}
</main>
</body>
</html>`;
}

// Digital Asset Links for Android App Links: lets Android open
// https://<host>/p/... links straight in the app. ANDROID_CERT_SHA256 is a
// comma-separated list of signing certificate SHA-256 fingerprints
// (Play Console > Test and release > App integrity: the app signing key, and
// the upload key for sideloaded builds).
function assetLinks() {
  const fingerprints = String(process.env.ANDROID_CERT_SHA256 || '')
    .split(',')
    .map((f) => f.trim().toUpperCase())
    .filter(Boolean);
  if (fingerprints.length === 0) return [];
  return [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: PACKAGE, sha256_cert_fingerprints: fingerprints },
  }];
}

module.exports = { renderSharePage, assetLinks, playStoreUrl };
