// Public "request account deletion" page required by Google Play's User
// Data policy for apps with accounts (linked from the Play Console Data
// safety form). Served at GET /delete-account. The player signs in with the
// Google account linked in the game (Firebase JS SDK, popup), sees which
// game profile it is, confirms, and the page calls DELETE /api/me -- the
// same deletion the in-app button performs.
const FIREBASE_JS_VERSION = '12.19.0';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderDeleteAccountPage({ apiKey, projectId, supportEmail }) {
  const config = JSON.stringify({ apiKey, authDomain: `${projectId}.firebaseapp.com`, projectId });
  const contact = supportEmail
    ? `email <a href="mailto:${escapeHtml(supportEmail)}?subject=Word%20Search%20account%20deletion">${escapeHtml(supportEmail)}</a>`
    : 'contact us through the developer email on our Google Play listing';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Delete your Word Search account</title>
<style>
  :root { --bg:#222C38; --card:#2A3646; --border:#141B24; --gold:#F1C726; --text:#F4F1E8; --muted:#B9C0CA; --red:#D9534F; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  main { max-width:560px; margin:0 auto; padding:32px 16px 48px; }
  h1 { color:var(--gold); font-size:26px; margin:0 0 8px; }
  h2 { font-size:18px; margin:0 0 8px; }
  .card { background:var(--card); border:3px solid var(--border); border-radius:12px; padding:20px; margin:16px 0; }
  ul { margin:8px 0 0; padding-left:20px; color:var(--muted); }
  p { margin:8px 0; }
  .muted { color:var(--muted); font-size:14px; }
  button { font:inherit; font-weight:700; border:0; border-radius:10px; padding:12px 18px; cursor:pointer; width:100%; }
  .google { background:#fff; color:#222; }
  .danger { background:var(--red); color:#fff; margin-top:12px; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  label { display:flex; gap:10px; align-items:flex-start; margin-top:12px; }
  .hidden { display:none; }
  .status { margin-top:12px; color:var(--gold); min-height:1.5em; }
  a { color:var(--gold); }
</style>
</head>
<body>
<main>
  <h1>Delete your Word Search account</h1>
  <p>Word Search - Multiplayer (by RunicLabs) lets you permanently delete your account and its data.</p>

  <div class="card">
    <h2>What gets deleted</h2>
    <ul>
      <li>Your player profile: display name, trophies and arena</li>
      <li>Your account and every sign-in linked to it (Google, Google Play Games)</li>
    </ul>
    <p class="muted">Deletion is immediate and can't be undone. Puzzles you shared with a code aren't linked to you and stay available to whoever has the code. Puzzle history stored on your phone is removed when you delete from inside the app, or when you uninstall it.</p>
  </div>

  <div class="card" id="step-signin">
    <h2>1. Sign in with Google</h2>
    <p class="muted">Use the Google account you linked in the game (Settings &rarr; Account).</p>
    <button class="google" id="signin">Sign in with Google</button>
  </div>

  <div class="card hidden" id="step-confirm">
    <h2>2. Confirm</h2>
    <p>Account: <strong id="who"></strong></p>
    <label><input type="checkbox" id="confirm"> I understand my Word Search account and progress will be permanently deleted.</label>
    <button class="danger" id="delete" disabled>Delete my account permanently</button>
  </div>

  <div class="card hidden" id="step-done">
    <h2>Your account has been deleted</h2>
    <p>All data listed above has been removed. If the game is still installed, it will start as a new guest next time you open it.</p>
  </div>

  <p class="status" id="status" role="status"></p>

  <div class="card">
    <h2>Can't sign in with Google?</h2>
    <p class="muted">If you play as a guest or only with Google Play Games: open the game, go to <strong>Settings &rarr; Account &rarr; Delete account</strong>. If you no longer have the game, ${contact} with your Player ID (shown in Settings) and we'll delete your account within 30 days.</p>
  </div>
</main>

<script type="module">
  import { initializeApp } from 'https://www.gstatic.com/firebasejs/${FIREBASE_JS_VERSION}/firebase-app.js';
  import { getAuth, GoogleAuthProvider, signInWithPopup, getAdditionalUserInfo, signOut }
    from 'https://www.gstatic.com/firebasejs/${FIREBASE_JS_VERSION}/firebase-auth.js';

  const auth = getAuth(initializeApp(${config}));
  const $ = (id) => document.getElementById(id);
  const status = (text) => { $('status').textContent = text; };
  const api = async (method, token) => fetch('/api/me', { method, headers: { Authorization: 'Bearer ' + token } });

  $('signin').addEventListener('click', async () => {
    status('');
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const token = await result.user.getIdToken();
      if (getAdditionalUserInfo(result)?.isNewUser) {
        // This Google account was never linked in the game: signing in just
        // created an empty account -- remove it again.
        await api('DELETE', token);
        await signOut(auth);
        status('No Word Search account is linked to this Google account. See "Can\\'t sign in with Google?" below.');
        return;
      }
      const res = await api('GET', token);
      if (!res.ok) throw new Error('Could not load your account (' + res.status + ')');
      const me = await res.json();
      $('who').textContent = me.name + ' - ' + me.trophies + ' trophies (' + result.user.email + ')';
      $('step-signin').classList.add('hidden');
      $('step-confirm').classList.remove('hidden');
    } catch (err) {
      if (err?.code === 'auth/popup-closed-by-user' || err?.code === 'auth/cancelled-popup-request') return;
      status('Sign-in failed: ' + (err?.message || err));
    }
  });

  $('confirm').addEventListener('change', (e) => { $('delete').disabled = !e.target.checked; });

  $('delete').addEventListener('click', async () => {
    $('delete').disabled = true;
    status('Deleting...');
    try {
      const token = await auth.currentUser.getIdToken();
      const res = await api('DELETE', token);
      if (!res.ok) throw new Error('Deletion failed (' + res.status + '). Please try again.');
      await signOut(auth).catch(() => {});
      status('');
      $('step-confirm').classList.add('hidden');
      $('step-done').classList.remove('hidden');
    } catch (err) {
      status(err?.message || String(err));
      $('delete').disabled = false;
    }
  });
</script>
</body>
</html>`;
}

module.exports = { renderDeleteAccountPage, FIREBASE_JS_VERSION };
