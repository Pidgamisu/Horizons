# Horizons — Digital Card Game

A two-player card game built on tldraw v5.

## Quick Start

You need two terminal windows.

**Terminal 1 — Game Server**
```bash
cd horizons-server
npm install
npm start
# Server runs on ws://localhost:8080
```

**Terminal 2 — Client**
```bash
cd horizons-client
npm install --legacy-peer-deps
npm run dev
# Client runs on http://localhost:5173
```

Then open `http://localhost:5173` in two browser tabs (or two browsers).

## How to Play

1. **Create a game** in one tab — you'll see a room code and shareable URL
2. **Share the URL** — paste it into the second tab to join
3. Both players draw opening hands of 5 cards

## Controls

| Action | How |
|--------|-----|
| Select a card | Click it in your hand |
| Play a card | Select it, then click **Play** |
| Void a card (+3 energy) | Select it, then click **Void** |
| Pass priority | **Spacebar** or click **Pass** |
| Respond to opponent | Click **Play** while opponent has something on the stack |
| Concede | Click **Concede** |

When a choice is required (e.g. "trash 2 cards from your hand"), a prompt slides up from the bottom. Click cards in the prompt to select them, then confirm.

## Card Assets

Card PNGs must be in `horizons-client/public/cards/` as `00.png` through `89.png`. These are included if you received the full project archive.

## Configuration

To change the server URL (e.g. for deployment), edit `horizons-client/.env`:
```
VITE_SERVER_URL=wss://your-server.com
```

## Project Structure

```
horizons-server/
  src/
    data/
      cards.json          ← All 90 cards with structured effects
      cardDb.js           ← Card lookup
    engine/
      state.js            ← GameState model, zone helpers, static effect queries
      validation.js       ← Play legality checks
      game.js             ← Turn flow, priority, stack resolution
      choices.js          ← Player choice resolution (trash, target, etc.)
    effects/
      executor.js         ← Effect execution engine
    server.js             ← WebSocket server, room management, state broadcast

horizons-client/
  public/cards/           ← 90 card PNGs (00.png – 89.png)
  src/
    game/
      client.js           ← WebSocket game client
      BoardManager.js     ← Maps game state → tldraw shapes
    shapes/
      CardShapeUtil.jsx   ← Custom tldraw card shape
      ZoneShapeUtil.jsx   ← Custom tldraw zone shape
    ui/
      HUD.jsx             ← Points, energy, timer display
      ActionBar.jsx       ← Play/Void/Pass/Concede buttons
      ChoicePrompt.jsx    ← Interactive choice modal
      CardTooltip.jsx     ← Hover zoom preview
      GameOver.jsx        ← Win/lose screen, Lobby, Toast
    App.jsx               ← Root component, wires everything together
    main.jsx              ← Entry point

planning/
  horizons-tldraw-planning.md   ← Full design document
  cards.json                    ← Card data (also in server)
```

## Game Rules Summary

- **Goal:** 5 points to win
- **Energy:** Void cards from your hand to gain 3 energy each
- **Playing cards:** Pay energy cost; card goes on the stack
- **Stack:** Last In, First Out (like MTG). Both players pass priority to resolve
- **Point cards:** Can only be played when the stack is empty (on your turn)
- **Action cards:** Can be played on your turn OR in response to opponent's cards
- **End of turn:** Energy wiped, trash moves to void, draw back up to 5
- **Priority clock:** 25 minutes each — clock runs while you hold priority
