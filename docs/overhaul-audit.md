# Overhaul audit — v3 rulebook + 90-card art vs. the current engine

Audited 2026-11-24 against `Rulebook Horizons v3.zip` and `Horizons_pngs.zip`.
Rules transcription: [overhaul-rules.md](overhaul-rules.md).

## Blocker: the card art filenames are not trustworthy

The art zip has 90 fronts named `<nn><Name>.png`. Ten were opened and compared to
`cards.json`:

| File | Card actually on the art | Verdict |
| --- | --- | --- |
| `00Pretty_Privilege` | Pretty Privilege, 7 | name ok, text changed |
| `15Overwhelm` | Overwhelm, 7 | name ok, **redesigned** |
| `21Paranoia` | Paranoia, 4 | name ok |
| `22Treasure_Anew` | **Offer Perspective**, 5 | mismatch — card is new to the set |
| `26Birth_the_Sky` | **Treasure Anew**, 5 | mismatch |
| `42Pay_No_Mind` | Pay No Mind, 5 | name ok |
| `44Dawn` | Dawn, 6 | name ok, wording changed |
| `53Blinding_Flash` | Blinding Flash, 2 | name ok, **redesigned** |
| `59Journey` | Journey, 2 | name ok, unchanged |
| `67By_Any_Means` | By Any Means, 0 | name ok |

Two of ten slots carry a different card than the filename says, and one of those
(*Offer Perspective*) does not exist anywhere in the current 105-card set. So the filename
list cannot be used to derive the new set — **every one of the 90 fronts has to be read off
the art**, and that transcription is the first build step, not an afterthought.

What the filename diff *suggested* (now only a hypothesis): 45 points at `00`–`44`, 45
actions at `45`–`89`; 15 of the current cards dropped — Strafe, Lurk, Reap, Unbury Intent,
Forever Borrow, Warp, Dig For Ideas, Hesitation, Unrecognized Influence, Fuzzy Memory,
Chains, Cerebral Snuff, Reinstate, Paradox, Honest Sentiment. The 45/45 split and the
point/action ranges did hold on every card actually opened.

## Rules deltas that need engine work

### 1. Rising now takes one pass, not two — `src/engine/game.js` — **DONE**

> Confirmed by the user 2026-11-24 and implemented the same day.

`passPriority` rose the top card only at `priorityPassCount >= 2`. The rulebook is
single-pass: *"If your opponent passes, it rises."* The controller never has to pass their
own card.

The same function also handed priority back to `state.turn` after a rise. The rulebook
instead gives it to **the opponent of the new top card's controller** — which is not the
turn player whenever the stack is interleaved.

Both halves are now rewritten, `priorityPassCount` is deleted from the state model (and
from the server projection and the tutorial's fake state), and a pass with an empty horizon
ends the turn directly instead of going through a dead opponent window.

Worth knowing: in *networked play* this was close to a no-op, because
`server.js:autoSkipDeadPriority` was already auto-passing the controller's dead window and
collapsing two passes into one. The rule now lives in the engine where it belongs, so the
tests, `cards-sweep.mjs` and `fuzz-games.mjs` exercise the real thing. `autoSkipDeadPriority`
stays as a safety net: effects that yank a card off the horizon mid-resolution can still
leave `activePlayer` pointing at a window with nothing to do.

### 2. "Void" is now "energize" — engine, server, client, tests

Same mechanic (hand to dusk, +3, priority required, `pendingEnergyPayment` exception for
ransoms). Only the name changes: `voidCard`, `voidedThisTurn`, `CARD_VOIDED`, `voidOnly`,
and the UI labels. Purely a rename, but it touches every layer, so it is worth doing as one
isolated commit.

### 3. Points in response: the whole subsystem is now dead — **confirmed, not yet deleted**

> Confirmed by the user 2026-11-24: points in response are cut outright. Birth the Sky's
> fate no longer matters — nothing grants it.

`validation.js` carries `responseOnly`, `playableOnlyOnOpponentTurn`,
`checkPointResponsePermission`, `opponentPointResponseAllowed` and
`players[x].pointResponseToActions` to support four cards. All four are gone:

- Strafe (006) and Forever Borrow (036) — cut from the set
- Overwhelm (017) — redesigned to "costs 1 less energy for each card played this turn"
  (was "for each card on the horizon" plus response-only)
- Blinding Flash (061) — redesigned to "Your opponent can't respond to your cards this
  turn. Draw a card."

Birth the Sky (028) was the one remaining grantor; with the subsystem cut it is gone or
rewritten too. The machinery can be deleted outright — and with it the standing "card text
beats rules" exception for points.

Not done yet, deliberately: all four cards are themselves being cut or redesigned, so
deleting the machinery means editing `cards.json` piecemeal before the full 90-card
transcription exists. It belongs in step 4/5 of the build order, as one commit with the
card rewrite.

### 4. Blinding Flash needs a mechanic that doesn't exist

"Your opponent can't respond to your cards this turn" is a turn-scoped response lock. The
closest existing thing is `lockHorizon` (a *static* effect read off the horizon), but this
one persists after the card rises into the dusk, so it belongs in `turnFlags`, not
`staticEffects`.

### 5. Pretty Privilege — no code change needed

Text goes from "your opponents can't play cards" to "your opponent can't play actions".
While Pretty Privilege is on the horizon the horizon is non-empty, so the opponent could
never play a point anyway — once the point-in-response cards are gone the two readings are
identical. The `lockHorizon` static effect stands as-is; only `effectText` updates.

### 6. Dawn — "costs 0" became "you may play this for 0"

`cards.json` has "This costs 0 energy if you reveal three points from your hand."; the art
says "**You may play this** for 0 energy if you reveal three points from your hand." The
discount becomes an opt-in alternative cost rather than an automatic one. Small, but it is
a choice the player now has to be offered.

## Already correct — no work needed

- **Deck size.** Built from `ALL_CARD_IDS`, so 105 to 90 follows from `cards.json` alone.
- **Reshuffles.** `reshufflesRemaining: 0`, and the rulebook never grants one.
- **Sunset.** Finish the rising card, dump the horizon to the dusk, biggest zenith wins —
  matches `checkSunset` exactly.
- **First-turn refill.** `endTurn` step 5 already draws the second player up to 5 at the end
  of turn 1, which is the rulebook's "draw up to 5 at the start of your first turn".
- **Energy wipe for both players at end of turn**, and the draw-to-5.
- **Energize timing.** `voidCard` already requires priority = "any time you can play a card".

## Collateral: what renumbering breaks

The engine itself is clean — no card ids are hardcoded in `engine/`, `effects/` or
`server.js`; everything is data-driven off `cards.json`. Three places are not:

- **`src/game/tutorialClient.js`** pins ten ids (`042`, `053`, `079`, `055`, `063`, `004`,
  `020`, `060`, `083`, `097`). `055` is Dig For Ideas, which is on the cut list, so the
  tutorial script needs rewriting, not just remapping. (The tutorial isn't mentioned in
  CLAUDE.md; that should be fixed too.)
- **`tests/game.test.js`** pins ids throughout, including `'044'`, `'047'`, `'097'` and
  `'104'` — `104` (Honest Sentiment) is cut.
- **`public/cards/`** holds `000.png`–`104.png` plus `back.png` and must be replaced
  wholesale with the 90 new fronts. Decide now whether ids stay 3-digit (`000`) or move to
  the art's 2-digit (`00`) — the art, `CardShapeUtil`, `cards.json` and `BoardManager` all
  have to agree.

Code comments already reference a stale, inconsistent numbering ("With the Sky (28)",
"Blinding Flash (51)", "Prepare 50", "Possess Love (83)"). Renumbering makes those actively
misleading; they should be fixed in the same pass.

## Client-side

**The horizon is drawn in the wrong axis.** `BoardManager._collectHorizon` stacks entries
vertically (`y + i * PITCH`, constant `x`) with index 0 — the newest — at the top of the
screen. The rulebook shows a horizontal fan overlapping to the right, **rightmost = top**.
That is a layout change to `_collectHorizon` plus the horizon zone's width and height.

## Not in the rulebook

The **25-minute priority clock** that CLAUDE.md documents appears nowhere in the rulebook.
Worth confirming whether it survives as a digital-only rule.

## Suggested build order

1. Transcribe all 90 fronts to a `docs/cards-v4.md` table (id, name, type, cost, text) and
   reconcile it against `cards.json`. Nothing else can start until this exists.
2. `passPriority` single-pass rewrite plus the new priority-after-rise rule. Tests first.
3. The `void` to `energize` rename, one commit, all layers.
4. Rewrite `cards.json` to the new 90: ids, costs, text, effects.
5. Delete the point-in-response machinery (pending Birth the Sky's fate); add the
   turn-scoped response lock for Blinding Flash.
6. Card art swap and the id-format decision; rewrite the tutorial script; fix the tests.
7. Horizon layout; CLAUDE.md and README updates.

Gate every step on `npm test`, `node cards-sweep.mjs` (which becomes 90/90) and
`node fuzz-games.mjs 100`.
