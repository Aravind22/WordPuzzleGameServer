// Public privacy policy, served at GET /privacy (Play Store listing, Play
// Data safety form, AdMob consent message). Keep it in step with what the
// game and this server actually collect: accounts (Firebase Auth), the
// player record + gem ledger in MongoDB, multiplayer, shared puzzles, ads
// (banner + rewarded with server-side verification) and UMP consent.
const UPDATED = 'October 7, 2026';
const CONTACT_EMAIL = 'hello.runiclabs@gmail.com';

function renderPrivacyPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Privacy Policy - Word Search</title>
<style>
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.6;
    color: #222;
    max-width: 820px;
    margin: 0 auto;
    padding: 32px 20px 80px;
    background: #ffffff;
  }
  h1 { font-size: 28px; margin-bottom: 4px; }
  .updated { color: #666; font-size: 14px; margin-bottom: 32px; }
  h2 { font-size: 20px; margin-top: 40px; border-bottom: 1px solid #e5e5e5; padding-bottom: 6px; }
  h3 { font-size: 16px; margin-top: 24px; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  th, td { text-align: left; padding: 8px 10px; border: 1px solid #ddd; font-size: 14px; vertical-align: top; }
  th { background: #f5f5f5; }
  code { background: #f5f5f5; padding: 1px 5px; border-radius: 3px; font-size: 13px; }
  a { color: #0b5fff; }
  ul { padding-left: 22px; }
  .contact-box { background: #f8f9fb; border: 1px solid #e5e5e5; border-radius: 8px; padding: 16px 20px; margin-top: 12px; }
  footer { margin-top: 60px; color: #888; font-size: 13px; }
</style>
</head>
<body>

<h1>Privacy Policy for Word Search</h1>
<p class="updated">Last updated: ${UPDATED}</p>

<p>
  This Privacy Policy explains how Runic Labs ("we," "us," "our") handles information
  in connection with the Word Search - Multiplayer mobile application (the "App"),
  package name <code>com.runiclabs.wordsearch</code>, available on Google Play.
</p>
<p>
  You can play without giving us your name, email address or phone number. The
  sections below describe exactly what data the App handles, and why.
</p>

<h2>1. Information We Collect</h2>

<h3>1.1 Your game account</h3>
<p>
  On first launch the App signs you in automatically with an anonymous
  <strong>guest account</strong> through Google Firebase Authentication. This
  creates a random account identifier (a "player ID"). It is not derived from
  your phone number, email or device hardware. We use it to keep your progress
  (display name, trophies and gems) and to secure every request the App makes to
  our server.
</p>
<p>
  You can optionally <strong>link</strong> your account so you can restore it on a
  new phone or after reinstalling:
</p>
<ul>
  <li><strong>Google Play Games</strong>: links your Play Games player profile
    (player ID and gamer name) to your game account. The App may sign in to Play
    Games automatically when it starts.</li>
  <li><strong>Sign in with Google</strong>: links your Google account. Google shares
    your name, email address and Google account ID with Firebase Authentication,
    which holds them so you can sign in again. Our game server does not store your
    email address.</li>
</ul>
<p>Linking is optional. Guests can play every part of the App.</p>

<h3>1.2 Player record on our server</h3>
<p>For each account our game server stores:</p>
<ul>
  <li>Your player ID (Section 1.1)</li>
  <li>Your display name. The default looks like "PLAYER-A1B2", and you can change it
    in Settings. It is shown to opponents in multiplayer, so please don't use your
    real name if you don't want opponents to see it.</li>
  <li>Your ranked trophies and arena</li>
  <li>Your gem balance (the App's virtual currency, see Section 1.5)</li>
  <li>When the account was created and last used</li>
  <li>If you restored a saved account over a guest account on this device, a note
    of that merge (the guest's player ID and trophies)</li>
</ul>

<h3>1.3 Multiplayer gameplay data</h3>
<p>When you play a live multiplayer match, the following is sent to our game server to run it:</p>
<ul>
  <li>Your player ID, display name and trophies</li>
  <li>Room codes you create or join, and rematch requests</li>
  <li>The words you find and each player's score in that match</li>
  <li>Connection state (e.g. temporary disconnects), used to give a reconnect grace period</li>
</ul>
<p>
  Match data is held in server memory only for the duration of the match. The only
  lasting result is the trophy change after a ranked match, which is saved to your
  player record.
</p>

<h3>1.4 Shared puzzles</h3>
<p>
  If you share a puzzle, its word list and word placements (and, for solved
  puzzles, your solve time) are stored on our server so the share code keeps working
  for whoever you send it to. Shared puzzles are not linked to your player ID or
  display name.
</p>

<h3>1.5 Gems (virtual currency)</h3>
<p>
  Gems are given to you in the App (for example a starting balance) and can be spent on in-game help, such as
  "+30 seconds" when time runs out or replaying a puzzle. Your balance is kept on our
  server. Each grant and spend is recorded in a transaction log (amount, reason, time
  and the puzzle it was for) to prevent double charges and abuse. The App currently
  offers no real-money purchases. If we add them, we will update this policy first.
</p>

<h3>1.6 Aggregate statistics</h3>
<p>
  The App reports when a puzzle is solved for the first time, to maintain a single
  App-wide "total puzzles solved" counter. No record of who solved what is kept.
</p>

<h3>1.7 Data stored only on your device</h3>
<p>
  Your solo puzzle history (puzzles played, found words, times, and +30 second uses),
  your sound and music settings, and a cached copy of your display name, trophies
  and gem balance (so menus work offline) are saved in the App's local storage.
  Puzzle history never leaves your device unless you share a puzzle (Section 1.4).
</p>

<h3>1.8 Advertising</h3>
<p>
  The App shows <strong>banner ads</strong> and optional <strong>rewarded video
  ads</strong> (for example, watch an ad for +30 seconds) served by Google AdMob
  (Google Mobile Ads SDK). To serve and measure ads, Google AdMob and its partners
  may collect:
</p>
<ul>
  <li>Advertising ID (a resettable identifier provided by Android for advertising)</li>
  <li>General device information (device model, OS version, language, screen size)</li>
  <li>Approximate, IP-based location (for regional ad delivery)</li>
  <li>Ad interaction data (impressions, clicks, rewarded ads completed)</li>
</ul>
<p>
  This data is processed by Google under
  <a href="https://policies.google.com/privacy" target="_blank" rel="noopener">Google's Privacy Policy</a>
  (see also <a href="https://policies.google.com/technologies/ads" target="_blank" rel="noopener">how Google uses data in ads</a>).
</p>
<p>
  When you finish a rewarded ad, Google sends our server a signed confirmation
  (server-side verification). It contains your player ID, a transaction ID, the ad
  unit and the reward, and we record it in the transaction log described in
  Section 1.5.
</p>
<p>
  Where required by law (for example in the EEA, the UK and Switzerland), the App
  asks for your consent through Google's User Messaging Platform before ads are
  requested. You can review or change your choice at any time in
  <strong>Settings &rarr; PRIVACY</strong>. You can also limit ad personalization or
  reset or delete your Advertising ID in your device settings (Settings &rarr; Google
  &rarr; Ads, or Settings &rarr; Privacy &rarr; Ads, depending on your device).
</p>

<h3>1.9 Firebase</h3>
<p>
  Account sign-in uses Google Firebase. The Firebase SDK included in the App
  contains Google Analytics for Firebase, which may collect an app-instance
  identifier and basic usage and device information on Google's behalf. See
  <a href="https://firebase.google.com/support/privacy" target="_blank" rel="noopener">Privacy and Security in Firebase</a>.
</p>

<h2>2. How We Use Information</h2>
<ul>
  <li>To create and secure your game account and let you restore it on another device</li>
  <li>To run multiplayer matches and ranked trophies, and to show your display name to opponents</li>
  <li>To keep your gem balance, apply what you spend gems on, and prevent double charges and fraud</li>
  <li>To let you share and open puzzles with a share code</li>
  <li>To maintain an App-wide "total solved" counter</li>
  <li>To show ads (including rewarded ads) that keep the App free</li>
</ul>
<p>We do not sell your information, and we do not use it to build advertising profiles of our own.</p>

<h2>3. Data Retention</h2>
<div class="table-wrap">
<table>
  <tr><th>Data</th><th>Where it lives</th><th>Retention</th></tr>
  <tr><td>Player record (player ID, display name, trophies, gems, dates)</td><td>Game server database</td><td>Until you delete your account (Section 7)</td></tr>
  <tr><td>Sign-in accounts (guest, Play Games, Google name/email)</td><td>Firebase Authentication (Google)</td><td>Until you delete your account</td></tr>
  <tr><td>Gem and rewarded-ad transaction log</td><td>Game server database</td><td>Kept for fraud prevention and accounting. When you delete your account, its entries are anonymised: no longer linked to your player ID.</td></tr>
  <tr><td>Live match data</td><td>Game server memory only</td><td>Cleared when the match ends, a player stays disconnected past the grace period (~20 seconds), or a waiting room is abandoned</td></tr>
  <tr><td>Shared puzzle content</td><td>Game server database</td><td>Kept so share codes keep working; contains no personal information</td></tr>
  <tr><td>"Total solved" counter</td><td>Game server database</td><td>A single global number, not tied to anyone</td></tr>
  <tr><td>Puzzle history, settings, cached profile</td><td>Your device only</td><td>Until you delete your account, clear the App's data or uninstall</td></tr>
  <tr><td>Advertising and Firebase Analytics data</td><td>Google</td><td>Governed by Google's own retention practices</td></tr>
</table>
</div>

<h2>4. Data Sharing and Third Parties</h2>
<p>We do not sell your information. We share the limited data described above only with:</p>
<ul>
  <li>Your matched opponent, who sees your display name and trophies during a match</li>
  <li>Google (Firebase Authentication, Google Play Games, Google AdMob, Google Analytics for Firebase), as described above</li>
  <li>Our infrastructure providers (database and server hosting), solely to operate the App</li>
  <li>Authorities, if required by law</li>
</ul>

<h2>5. Data Security</h2>
<p>
  All communication between the App and our server is encrypted in transit (HTTPS,
  and secure WebSocket for multiplayer). Every request is authenticated with a
  short-lived Firebase sign-in token, so only your own account can read or change
  your player record and gems.
</p>

<h2>6. Children's Privacy</h2>
<p>
  The App is intended for a general audience and is not directed at children under
  13. We do not knowingly collect personal information from children. If you believe
  a child has provided us with personal information (for example, a real name as
  their display name), please contact us and we will address it.
</p>

<h2>7. Your Choices and Account Deletion</h2>
<ul>
  <li>Change your display name at any time in Settings.</li>
  <li>Link or not link Google Play Games or Google, as you prefer.</li>
  <li>Review or change your ad consent in Settings &rarr; PRIVACY (where required), and manage your Advertising ID in your device settings.</li>
  <li><strong>Delete your account in the App:</strong> Settings &rarr; DELETE ACCOUNT. This permanently deletes your player record (display name, trophies, gems) and your sign-in account, and clears the App's local data on that device.</li>
  <li><strong>Delete your account on the web</strong>, without the App:
    <a href="/delete-account">https://gs04node.com/delete-account</a></li>
  <li>Or email us (Section 10) and we will delete your data within 30 days.</li>
</ul>

<h2>8. Permissions</h2>
<p>
  The App uses internet access (multiplayer, accounts, sharing, ads) and the Advertising
  ID permission required by the Google Mobile Ads SDK. It uses Google Play Games
  services for optional sign-in. It does not request access to your contacts,
  location, camera, microphone, photos or files.
</p>

<h2>9. Changes to This Policy</h2>
<p>
  We may update this Privacy Policy, for example when we add features that change
  what data the App handles. Changes will be reflected by updating the "Last updated"
  date at the top of this page.
</p>

<h2>10. Contact Us</h2>
<p>If you have any questions about this Privacy Policy or your data, contact us at:</p>
<div class="contact-box">
  Runic Labs<br>
  Email: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a><br>
  Based in India
</div>

<footer>
  This policy applies only to the Word Search - Multiplayer app. Third-party services
  used within it (such as Google Play, Firebase and Google AdMob) are governed by their
  own privacy policies.
</footer>

</body>
</html>`;
}

module.exports = { renderPrivacyPage };
