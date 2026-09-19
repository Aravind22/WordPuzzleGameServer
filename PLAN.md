# 1v1 Multiplayer Word Search — Node.js game server + Unity client

## Context

Word Hunt (`E:\Unity\WordPuzzle`) is currently single-player: `WordSearchScreen` generates
a 10x10 grid with 8 words locally via `WordSearchGenerator`/`WordPicker`/`WordBank`, and the
player finds words solo. The user wants a competitive 1v1 mode — two players see the *same*
grid, race to find words, and whoever finds the most words wins — with:

- A dedicated Node.js game server (new repo at `E:\Unity\WordPuzzleGS`, currently empty).
- Manual rooms (player A creates, gets a room code; player B enters the code to join).
- Auto matchmaking (queue-based, no code needed).
- Live sync: when either player finds a word, both boards update immediately.

Decided already (via user Q&A):
- Server: **plain `ws` WebSocket server** with hand-rolled room/matchmaking logic (not Colyseus).
  Originally planned as Socket.IO, but switched after inspecting the official C# client
  (`SocketIOClient` 4.x)'s NuGet dependency tree: it pulls a reflection-heavy DI container plus
  a dozen+ transitive .NET-10-era packages with no official Unity support — high risk of
  working in-editor and failing silently under IL2CPP AOT on device. The server now speaks
  `{ type, payload }` JSON messages over plain WebSocket (see `src/net/wsAdapter.js`, which
  gives the rest of the server an `io`/`socket`-shaped API so the event-handler code below
  didn't need to change); Unity uses the `NativeWebSocket` package instead of a Socket.IO
  client. Event names/payloads in the "Socket.IO event contract" section below are unchanged
  by this switch — only the wire transport differs.
- Identity: **anonymous device ID** (GUID generated once, stored in PlayerPrefs) — no accounts.
- Hosting: **local machine/LAN** for now; connect Unity via LAN IP, deploy later.
- Win rule: a player wins the instant they reach **majority** of the word count (5 of 8) —
  round ends immediately rather than waiting for all 8 to be found. If the words run out
  with no majority (possible on a 4-4 split of an 8-word game), the match ends in a **tie**.

The server is authoritative: it owns word-list selection, grid generation, and word
validation, so both clients are guaranteed to see the same puzzle and neither client can
cheat by reporting a fabricated "found" word.

## Server: `E:\Unity\WordPuzzleGS` (new Node.js project)

```
WordPuzzleGS/
  package.json                # express + ws + nanoid
  src/
    server.js                 # http server + ws bootstrap, port from env
    game/
      wordBank.js              # port of Assets/Scripts/WordSearch/WordBank.cs word list
      wordPicker.js            # port of WordPicker.cs (cooldown-based pick, per-queue instance)
      gridGenerator.js         # port of WordSearchGenerator.cs (H/V placement, 100 attempts, fill)
      Room.js                  # room state + win-condition/scoring logic
    net/
      RoomManager.js           # create/join-by-code/matchmaking-queue/cleanup, in-memory Map
      wsAdapter.js             # Socket.IO-shaped io/socket facade over plain `ws` (see decision above)
      socketHandlers.js        # wires events to RoomManager/Room (unchanged by the ws switch)
  .gitignore                  # node_modules
```

Porting `WordBank`/`WordPicker`/`WordSearchGenerator` to JS keeps the exact same puzzle
generation rules (word list, 100-attempt placement, H/V only) so a future "watch difficulty
settings match single-player" stays trivial. These become the single source of truth for
multiplayer puzzles; the Unity-side C# versions remain as-is for solo play.

### Room model (`Room.js`)
- `id`: 6-char human-friendly code (uppercase, excludes ambiguous chars like 0/O/1/I), via `nanoid` custom alphabet.
- `players[]`: up to 2, each `{ deviceId, socketId, name, foundWords: [], connected }`.
- `grid`, `gridSize`, `placedWords` (word + cells) — generated once both players are present.
- `foundBy`: `Map<word, deviceId>` plus insertion order (for a results screen later).
- `status`: `waiting -> playing -> finished`.
- `winner`: `deviceId | 'tie' | null`.
- `createdAt`/`lastActivityAt` for a sweep interval that reaps abandoned rooms (e.g. no
  activity for 5 minutes while `waiting`, or both players disconnected while `playing`).

### Matchmaking (`RoomManager.js`)
- **Manual**: `createRoom` → new `Room` (status `waiting`), returns code. `joinRoom(code)` →
  validates room exists/not full/not already started, adds player 2, generates the grid,
  emits `matchStart` to both sockets (joined to a Socket.IO room keyed by room id).
- **Auto**: `findMatch` → push `{deviceId, socketId}` onto a FIFO queue; whenever the queue
  has ≥2, pop two, create a room the same way as manual, emit `matchStart` to both. FIFO is
  enough for v1 (no skill-based matching). `cancelFindMatch` removes from the queue.
- Reconnect: `rejoinRoom(code, deviceId)` lets a client that dropped mid-match rejoin the
  same room within a grace period (see below) — matched by `deviceId`, not `socketId`.

### Socket.IO event contract
Client → server: `createRoom`, `joinRoom {code}`, `findMatch`, `cancelFindMatch`,
`submitWord {cells: [{row,col}, ...]}`, `leaveRoom`, `rejoinRoom {code}`.

Server → client: `roomCreated {code}`, `opponentJoined {opponentName}`, `matchStart {grid,
gridSize, words, players}`, `wordFound {word, cells, deviceId, scores}` (broadcast to both —
this is what makes player A's find show up on player B's board), `wordRejected` (sender
only, optional UX polish), `opponentDisconnected {graceSeconds}`, `opponentReconnected`,
`gameOver {winner, scores}`, plus `errorMsg {code}` for room-not-found/room-full/etc.

### Word validation (anti-cheat, `Room.js`)
Client sends the **cell path** it dragged (row/col pairs), never a word string. Server:
1. Confirms the path is a straight horizontal/vertical line of the grid's own cells.
2. Reads letters along that path (and reversed) from the server's authoritative grid.
3. Matches against `placedWords` for an unfound word of equal length.
4. On match: records `foundBy`, broadcasts `wordFound` to the room, then checks the win
   condition (majority reached → `gameOver`; all words found with no majority → `gameOver`
   with `winner: 'tie'`).

### Disconnect handling
On socket disconnect during `playing`, start a ~20s grace timer and emit
`opponentDisconnected` to the remaining player; if the same `deviceId` reconnects
(`rejoinRoom`) before it expires, resume and emit `opponentReconnected`; otherwise the
remaining player is declared the winner and the room closes.

## Unity client: `E:\Unity\WordPuzzle`

Reuses the existing logic/view split — `WordSearchBoard`/`WordSearchCell` stay almost
unchanged since they already just render a `char[]` grid and emit `PathSelected`.

```
Assets/Scripts/
  Network/
    DeviceId.cs                 # GUID generated once, cached in PlayerPrefs
    GameServerClient.cs         # NativeWebSocket wrapper singleton (DontDestroyOnLoad),
                                 # sends/receives { type, payload } JSON envelopes,
                                 # exposes C# events: RoomCreated, OpponentJoined, MatchStart,
                                 # WordFound, OpponentDisconnected/Reconnected, GameOver, Error
  Multiplayer/
    MultiplayerMenuController.cs  # Create Room / Join Room (code input) / Quick Match (queue+cancel)
    MultiplayerGameScreen.cs      # 1v1 variant of WordSearchScreen — grid comes from server,
                                   # OnPathSelected sends the path instead of checking locally,
                                   # renders both players' found words + a scoreboard
Assets/Editor/
  MultiplayerMenuBuilder.cs     # procedural scene builder, same pattern as MainMenuBuilder.cs
  MultiplayerGameSceneBuilder.cs # same pattern as GameSceneBuilder.cs, adds scoreboard UI
  UiBuilder.cs                  # + new CreateInputField helper (room-code text entry;
                                 # doesn't exist yet, needed for Join Room)
```

Key integration points:
- `WordSearchBoard.Render(char[], int)` and `SetCellsFound(List<Vector2Int>)` are reused
  as-is — the multiplayer screen just calls them with server-sent data instead of a local
  generator's output.
- `WordSearchCell.SetFound` currently has one `FoundColor`; extend it with an optional color
  parameter so a word found by the opponent renders in a different tint than one found by the
  local player (small, backward-compatible change — default keeps existing solo behavior).
- `MultiplayerGameScreen.OnPathSelected` sends `{cells}` to `GameServerClient.SubmitWord`
  instead of calling `CheckMatch` locally; the actual "found" animation/strikethrough/sound
  fires only when the `WordFound` server event arrives — this is what keeps both players'
  boards in sync and prevents a local-only optimistic update from drifting from the
  authoritative state.
- `MainMenuController` gets one more button ("1v1") wired to load a new `MultiplayerMenu`
  scene, following the exact pattern `PlayGame()` uses for `GameScene`.

### WebSocket client dependency (risk de-risked before writing any Unity code)
Originally planned as the `socket.io-client-csharp` package. Before touching Unity, its NuGet
dependency tree was inspected directly: `SocketIOClient` 4.0.5 depends on
`Microsoft.Extensions.DependencyInjection`, `Microsoft.Extensions.Logging`, and
`System.Text.Json` all pinned to `10.0.3` (.NET-10-era packages), plus a reflection-based DI
container internally, with no official Unity support. That's ~15+ transitive DLLs to hand-vendor
and a real risk of working in the Editor (Mono) but failing silently under IL2CPP AOT on device.
Switched to the fallback instead: the server now speaks plain WebSocket (`src/net/wsAdapter.js`,
`{ type, payload }` JSON messages), and Unity uses the `NativeWebSocket` package
(github.com/endel/NativeWebSocket, UPM git URL `https://github.com/endel/NativeWebSocket.git#upm-2`)
— zero external DLLs, wraps the platform's built-in `System.Net.WebSockets`, explicitly supports
WebGL/mobile/desktop.

## Build order

1. Node server skeleton (`package.json`, `server.js`, health check), run locally. **DONE**
2. Port `wordBank.js` / `gridGenerator.js` / `wordPicker.js` from the C# originals. **DONE**
3. `Room.js` + `RoomManager.js`: manual room create/join by code, matchmaking queue, cleanup sweep. **DONE**
4. `socketHandlers.js`: wire the full event contract above, including word validation and win logic. **DONE**
   (`wsAdapter.js` added on top so the transport is plain `ws` instead of Socket.IO — see decision above.)
   Verified via `scratch/test.js` (majority win), `scratch/testTie.js` (4-4 tie), `scratch/testDisconnect.js`
   (reconnect-in-grace and grace-expiry-declares-winner), all passing end to end.
5. Unity: add the `NativeWebSocket` UPM package + do a throwaway connect/send/receive smoke test. **DONE**
   Package resolves cleanly via UPM git URL, compiles with zero errors. The first smoke-test
   version had a real bug (a blocking `Thread.Sleep` spin-loop in the harness starved the
   `SynchronizationContext` `SendText`'s continuation needed, so sends silently never
   completed) — fixed by pumping `NativeWebSocket` via `EditorApplication.update` and using
   proper async/await instead. Confirmed working end to end: Unity connected, sent
   `createRoom`, and received the server's `roomCreated` ack (`Assets/Editor/MultiplayerSmokeTest.cs`,
   verified against the server's own connection log).
6. Unity: `DeviceId`, `GameServerClient` wrapper with typed C# events. **DONE** — compiles clean.
   `scores` payloads were changed from a deviceId-keyed object to an array of `{deviceId, count}`
   (`Room.js`'s `scores()`) since `JsonUtility` can't deserialize dynamic dictionary keys.
7. Unity: `MultiplayerMenuController` + `MultiplayerMenuBuilder` (Create/Join/Quick Match UI), MainMenu "1v1" button. **DONE**
   Added `UiBuilder.CreateInputField` for the room-code entry field. Compiles clean;
   `MultiplayerMenu.unity` and the updated `MainMenu.unity` (now with a 4th "1V1" button, card
   grown to fit) both built successfully via their menu items with no runtime errors.
8. Unity: `MultiplayerGameScreen` + `MultiplayerGameSceneBuilder` — server-driven grid, scoreboard, per-player found-word coloring, game-over screen (win/lose/tie + back-to-menu). **DONE**
   `WordSearchCell.SetFound`/`WordSearchBoard.SetCellsFound` got the planned optional
   `Color? foundColor` parameter (backward-compatible default keeps solo play unchanged) so an
   opponent's find renders in a different tint. Compiles clean; `MultiplayerGameScene.unity`
   built successfully with no runtime errors.
9. Disconnect/reconnect grace period + UI surfacing (room-full, room-not-found, opponent-left toasts). **DONE**
   Server side: `Room.js` timers, verified by `scratch/testDisconnect.js`. Unity side:
   `MultiplayerGameScreen` surfaces `OpponentDisconnected`/`OpponentReconnected` in the status
   text; `MultiplayerMenuController` surfaces `errorMsg` (room-full/room-not-found/etc.) the
   same way.
10. End-to-end manual test: run `node src/server.js` on LAN, two Unity Editor instances (or Editor + installed APK) pointed at the LAN IP, play a full match via both manual room and quick match paths. **NOT DONE YET** — needs interactive two-player playtesting, which is on the user to run.

## Verification

- Server: `scratch/test.js` / `scratch/testTie.js` / `scratch/testDisconnect.js` — plain `ws`
  Node scripts simulating two players through create/join/submitWord to confirm room + win
  logic before touching Unity. **DONE** — all three pass.
- Unity: two Editor Play sessions (ParrelSync or a built APK on a second device) connected
  to the same LAN server — verify grid matches on both screens, a find on one screen appears
  on the other, majority-win and tie end states both trigger correctly, and disconnect/
  reconnect doesn't desync the board.

# Solo-mode features — puzzle history, sharing, and settings

A separate feature set from the 1v1 plan above, layered onto the existing single-player
`WordSearchScreen` flow. Everything lives in the existing `GameScene`/`MainMenu` scenes —
no new menu scenes, per the "single menu" requirement.

## Done and confirmed working
- Saving solved puzzles (time, words) — `PuzzleHistoryStore` already existed; each puzzle now
  gets a proper `id` assigned at generation time (`WordSearchScreen._currentPuzzleId`), not
  only when solved.
- **History list view** — `GameScene`'s HIST button opens an overlay panel (not a new scene)
  listing locally solved puzzles (date, time, words) via `WordSearchScreen.RenderHistory`.
- **Solved modal** — replaces the old inline "Solved!" status text. Shows time taken, a SHARE
  button, and a NEW PUZZLE button (moved here from the now-removed standalone button below the
  word list).
- "Puzzle solved only when all words found" — already true in `CheckWin()`, no change needed.
- In-game LEVEL badge (`WordSearchScreen.UpdateLevelBadge`) — personal progress (puzzles
  solved locally + 1), shown next to the timer card. **Not** a worldwide stat — that was
  explicitly descoped in favor of this (see below).
- Settings screen: Player section — read-only device ID (`DeviceId.Get()`) + an editable
  display name (`PlayerProfile.cs`, defaults to `PLAYER-XXXX` from the last 4 id chars,
  persisted to PlayerPrefs), reusing the existing `DeviceId` system (no PlayFab/external
  identity service).
- Server: puzzle sharing REST endpoints (`POST /api/puzzles`, `GET /api/puzzles/:code`) and a
  persisted global "solved" counter (`POST /api/stats/solved`, `GET /api/stats`) in
  `src/net/apiRoutes.js`, `src/game/PuzzleShareStore.js`, `src/game/StatsStore.js`. Verified
  via `scratch/testApi.js`, including counter persistence across a server restart. The global
  counter endpoint is still called on solve (`ApiClient.Instance.ReportSolved`, best-effort,
  fire-and-forget) but isn't displayed anywhere — kept for possible future use.

## Built but not reachable yet — the real remaining gap
Sharing a puzzle so someone else gets the *exact same* puzzle only encodes each word's
placement (`WordSearchGenerator.LoadFromPlacements`), not the full grid — filler letters in
unused cells don't affect solvability, so the recipient regenerates those locally.
- `ApiClient.CreateShare`/`GetShare` and `WordSearchScreen.LoadSharedPuzzle(code, data)` exist
  and are wired to check `PuzzleHistoryStore.FindById(code)` first (shows the "already solved"
  box instead of letting a replay record a new/faster time on a puzzle you've already beaten —
  the anti-cheat scenario: solve in 90s, share, reopen your own link, solve again in 10s).
  `AlreadySolvedModal` UI is built.
- **Nothing calls `LoadSharedPuzzle` yet.** The SHARE button creates a code and copies
  `"...wordhunt://puzzle/{code}"` to the clipboard — but there's no "Enter Code" UI to type a
  received code into, and no deep-link handler (no `DeepLinkHandler.cs`, no
  `Assets/Plugins/Android/AndroidManifest.xml` intent-filter for the `wordhunt://` scheme) to
  catch a tapped link. Per an earlier decision: code entry + deep link, both — the code entry
  path (mirrors 1v1's Join Room UI) doesn't need any platform config and should ship first;
  deep linking is Android-only for now (no Mac/Xcode available here for iOS).
- Until the above exists, the History list, Solved modal, and Share button are all
  individually verified, but the full round-trip (share → someone else opens it → sees the
  same puzzle // same person reopens their own link → sees "already solved") has not been
  tested end to end.

## Not started
- Global worldwide "puzzles solved" counter display — descoped in favor of the personal LEVEL
  badge (see above). The server-side counter still exists and is still pinged on every solve.
