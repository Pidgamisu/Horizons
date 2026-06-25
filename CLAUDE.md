# CLAUDE.md

Guidance for working in this repo. Horizons is a two-player, real-time digital card game
(MTG-style stack & priority) built on **tldraw v5** + **React** for the client and a
**WebSocket** (`ws`) game server. Goal: first to 5 points wins.

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
    state.js            ← GameState model, zones, deck/draw/trash helpers, static-effect queries
    game.js             ← Turn flow, priority passing, stack resolution (startGame, playCard,
                          passPriority, resolveTopOfStack, endTurn, voidCard)
    validation.js       ← Play-legality checks (validatePlay)
    choices.js          ← Resolving player choices (trash N, pick target, etc.) (resolveChoice)
  effects/
    executor.js         ← Effect execution engine (executeEffects, executeOnPlayEffects)
  data/
    cards.json          ← All 90 cards (ids "00"–"89") with structured effects
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

There is **no `start` or `test` script** in `package.json` — run these directly. The `.js`
files use ESM `import` syntax and run under Node's automatic ESM detection.

```bash
# Client dev server (Vite) → http://localhost:5173
npm run dev

# Client production build
npm run build

# Game server (WebSocket) → ws://localhost:8080
node src/index.js          # override port with: PORT=9000 node src/index.js

# Tests (Node's built-in runner; tests use describe/test globals)
node --test tests/
```

To play: start the server, run the client, open `http://localhost:5173` in two tabs, create a
game in one and join via the shared room URL in the other.

## Core model (how a turn works)

- **Zones:** deck, hand (per player), stack (shared, LIFO), trash, void.
- **Energy:** gained by *voiding* a card from hand (+3 each). Wiped at end of turn.
- **Stack:** last-in-first-out. Playing a card pushes it; both players pass priority to resolve
  the top entry. Point cards require an empty stack on your turn; action cards can be played in
  response.
- **Static vs. triggered effects:** `cards.json` separates `effects` (triggered, run on resolve
  via `executor.js`) from `staticEffects` (continuous, queried by `state.js` — e.g. `lockStack`).
- **End of turn:** energy wiped, trash → void, draw back up to 5; 25-minute priority clock per player.

## Conventions

- Card ids are zero-padded strings `"00"`–`"89"` matching `public/cards/NN.png`.
- Engine functions take `state` first and **return event arrays** describing what happened;
  the server broadcasts derived per-player projections. Don't mutate state outside the engine.
- When adding a card mechanic, prefer extending the structured effect schema in `cards.json`
  + handling it in `executor.js` / `state.js` over special-casing it in the server or client.

## Git workflow

After completing a feature or meaningful change, commit **and push** to `origin/main` so progress
stays tracked in the GitHub history.
