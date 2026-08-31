# CLAUDE.md

Guidance for working in this repo. Horizons is a two-player, real-time digital card game
(MTG-style stack & priority — the shared LIFO zone is called the **horizon** in this game)
built on **tldraw v5** + **React** for the client and a
**WebSocket** (`ws`) game server. The deck is finite: when it runs out the game ends
(**Sunset**) and whoever has the most points in their **zenith** wins.

## ⚠️ Repo layout vs. README

The `README.md` describes a two-folder layout (`horizons-server/` and `horizons-client/`).
**That is out of date.** The actual repo is a *single* npm package with both the server and
the client living under `src/`. Trust the structure below, not the README, until the README
is corrected.

## Project structure

```
src/
  index.js              ← Server entry point (boots WebSocket server on PORT, default 8080)
  server.js             ← WebSocket server: room management + per-player state broadcast
                          (each player sees only their own hand)
  engine/               ← Pure game logic, no I/O — the authoritative rules engine
    state.js            ← GameState model, zones, deck/draw/dusk helpers, static-effect queries
    game.js             ← Turn flow, priority passing, horizon resolution (startGame, playCard,
                          passPriority, riseTopOfHorizon, checkSunset, endTurn, voidCard)
    validation.js       ← Play-legality checks (validatePlay)
    choices.js          ← Resolving player choices (dusk N, pick target, etc.) (resolveChoice)
  effects/
    executor.js         ← Effect execution engine (executeEffects, executeOnPlayEffects)
  data/
    cards.json          ← All 105 cards (ids "000"–"104") with structured effects
    cardDb.js           ← Card lookup by id

  main.jsx              ← Client entry point (React root)
  App.jsx               ← Root component; wires tldraw canvas + UI + game client together
  game/
    client.js           ← WebSocket game client (talks to server.js)
    BoardManager.js     ← Maps server game state → tldraw shapes on the canvas
  shapes/
    CardShapeUtil.jsx   ← Custom tldraw shape for cards
    ZoneShapeUtil.jsx   ← Custom tldraw shape for zones
  ui/                   ← React HUD overlay (HUD, ActionBar, ChoicePrompt, CardTooltip,
                          GameOver, Lobby, Toast)

tests/                  ← Engine + server tests (node:test style: describe/test globals)
public/cards/           ← Card art 00.png–89.png (also referenced via horizons-client/public in README)
index.html              ← Vite HTML entry
vite.config.js          ← Vite + React plugin, dev server on port 5173
.env                    ← VITE_SERVER_URL (client → server websocket URL)
```

The engine (`src/engine/`, `src/effects/`, `src/data/`) is **pure and authoritative** — it has
no DOM/network dependencies and is what the tests exercise. The server wraps it; the client only
renders state and sends intents. Keep game-rule logic in the engine, not in the client or server
glue.

## Commands

There is **no `start` script** in `package.json` — run the server directly. There **is** a
`test` script (`npm test`). The `.js` files use ESM `import` syntax and run under Node's
automatic ESM detection.

```bash
# Client dev server (Vite) → http://localhost:5173
npm run dev

# Client production build
npm run build

# Game server (WebSocket) → ws://localhost:8080
node src/index.js          # override port with: PORT=9000 node src/index.js

# Tests (Node's built-in runner) — 125 tests, all passing
npm test

# Every card executes through the engine — expect 105/105, 0 issues
node cards-sweep.mjs

# Random full games to Sunset — expect 0 hardlocked, 0 crashed
node fuzz-games.mjs 100
# equivalently:
node --test tests/game.test.js tests/server.test.js
```

> The test bodies are written in **Jest style** (`expect().toBe()`, `toHaveLength`,
> `beforeAll`, …), which `node:test` doesn't provide. `tests/helpers.js` shims `expect` over
> `node:assert/strict` and re-exports `describe`/`test`/`beforeAll`/`afterAll`; both test files
> import from it. When adding tests, import from `./helpers.js` and extend the shim if you need a
> matcher it doesn't have yet.

To play: start the server, run the client, open `http://localhost:5173` in two tabs, create a
game in one and join via the shared room URL in the other.

## Core model (how a turn works)

- **Zones:** deck, hand (per player), horizon (shared, LIFO), **dusk** (one shared face-up
  pile holding risen actions *and* voided cards), **zenith** (per player, face-up, risen points).
- **Energy:** gained by *voiding* a card from hand into the dusk (+3 each). Wiped at end of
  turn for **both** players.
- **Horizon:** last-in-first-out. Playing a card pushes it; when both players pass, the top
  entry **rises**. Points need an empty horizon on your own turn; actions can also be played in
  response to a card an *opponent* controls on top. (Zone key: `state.zones.horizon`.)
- **Rising:** a card **leaves the horizon before its text runs** — into the dusk if it's an
  action, into its controller's zenith if it's a point — then its controller does the card's
  text. A rising card is therefore never a legal target for its own effect.
- **Scoring:** one point per point card in your zenith. There is no points counter; use
  `pointsOf(state, playerId)`.
- **Sunset:** the deck is finite. A 2-player game gets zero reshuffles (reshuffles =
  players − 2), so when the deck runs dry the current card finishes rising, the horizon is
  dumped into the dusk, and the bigger zenith wins. Ties are a draw. Sunset can fire mid-turn.
- **Static vs. triggered effects:** `cards.json` separates `effects` (triggered, run on rise
  via `executor.js`) from `staticEffects` (continuous, queried by `state.js` — e.g. `lockHorizon`).
- **End of turn:** energy wiped for both players, draw back up to 5 (no maximum hand size);
  25-minute priority clock per player. The dusk persists — it is one pile all game.

## Conventions

- Card ids are zero-padded strings `"000"`–`"104"` matching `public/cards/NNN.png`.
  `000`–`049` are points, `050`–`104` are actions.
- **Card text beats the rules.** Where a card contradicts the rulebook it wins — Strafe (006)
  and Forever Borrow (036) are points playable in response, and Pay No Mind (047) leaves the
  horizon without ever rising. Encode the card, not the general rule. (Answer Fate, the old
  047, was the one card that granted a 2-player reshuffle; it was replaced on 2026-08-31, so
  no card grants one any more.)
- Engine functions take `state` first and **return event arrays** describing what happened;
  the server broadcasts derived per-player projections. Don't mutate state outside the engine.
- When adding a card mechanic, prefer extending the structured effect schema in `cards.json`
  + handling it in `executor.js` / `state.js` over special-casing it in the server or client.

## Git workflow

After completing a feature or meaningful change, commit **and push** to `origin/main` so progress
stays tracked in the GitHub history.
