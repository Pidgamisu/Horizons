/**
 * Play many random full games to Sunset, auto-answering every choice, to catch
 * crashes and hardlocks that the per-card sweep cannot see. cards-sweep.mjs
 * checks each card in isolation; this checks that a whole game of them still
 * terminates.
 *
 * Run: node fuzz-games.mjs [gameCount]   (default 60)
 *
 * A healthy run reports every game finished, with 0 hardlocked and 0 crashed.
 * The "rejected choice answers" list is mostly the fuzz picking an illegal
 * option on purpose; an "Unhandled ... type" line there is a real gap.
 */
import { createGameState, initDeck, pointsOf } from './src/engine/state.js';
import { startGame, playCard, passPriority, voidCard } from './src/engine/game.js';
import { resolveChoice } from './src/engine/choices.js';
import { advancePendingChoices } from './src/server.js';
import { getCard } from './src/data/cardDb.js';

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function answer(state) {
  const c = state.pendingChoice;
  if (!c) return false;
  const me = c.player;
  const hand = state.players[me].hand;
  const dusk = state.zones.dusk;
  const horizonIdx = state.zones.horizon.map((_, i) => i);
  const n = c.count ?? 1;
  const t = c.type;
  let payload;

  if (t === 'optional') payload = { accept: Math.random() < 0.7 };
  else if (t === 'duskUnlessControllerPays') payload = { pay: Math.random() < 0.5 };
  else if (t === 'mayPlayFromHand') payload = { play: false };
  else if (t === 'mayPlayTopOfDeck' || t === 'confirmFreePlay') payload = { play: false };
  else if (t === 'duskAnyNumberFromHand') payload = { cardIds: hand.slice(0, 1) };
  else if (t === 'duskFromHand') payload = { cardIds: hand.slice(0, n) };
  else if (t === 'putFromDuskToHand' || t === 'putFromDuskToDeckBottom'
        || t === 'putFromDuskToDeckTop' || t === 'opponentChoosesFromDusk') {
    payload = { cardIds: dusk.slice(0, n) };
  }
  else if (t === 'putPointFromDuskIntoZenith') {
    payload = { cardId: dusk.find((id) => getCard(id).type === 'point') };
  }
  else if (t === 'putHandCardOnDeckTop' || t === 'duskFromHandThenMatchCost') payload = { cardId: hand[0] };
  else if (t === 'chooseCardToDuskFromRevealedHand' || t === 'opponentChoosesOne') {
    payload = { cardId: c.revealedHand?.[0] ?? c.revealedCards?.[0] };
  }
  else if (t === 'lookAtTopN') payload = { duskCardId: (c.revealed ?? [])[0] };
  else if (t === 'chooseNumber') payload = { number: 1 };
  else if (t === 'revealUntilType') payload = { cardType: pick(['point', 'action']) };
  else if (t === 'returnTwoDifferentControllers') {
    const byController = {};
    state.zones.horizon.forEach((e, i) => {
      const ctrl = e.controlledBy ?? e.playedBy;
      (byController[ctrl] ??= []).push(i);
    });
    const groups = Object.values(byController);
    payload = groups.length >= 2 ? { horizonIndexes: [groups[0][0], groups[1][0]] } : { horizonIndexes: [0, 1] };
  }
  else if (t === 'additionalCost') {
    payload = c.cost?.type === 'putHandCardOnDeckTop' ? { cardId: hand[0] }
      : c.cost?.type === 'payAnyAmount' ? { amount: 0 }
      : { cardIds: (c.cost?.type === 'putFromDuskToDeckBottom' ? dusk : hand).slice(0, c.cost?.count ?? 1) };
  }
  else if (horizonIdx.length) payload = { horizonIndex: pick(horizonIdx) };
  else payload = {};

  const { error } = resolveChoice(state, me, payload);
  if (error) {
    // A refused answer must not wedge the game: clear it and move on.
    state.pendingChoice = null;
    return { error: `${t}: ${error}` };
  }
  return true;
}

let crashes = [], hardlocks = 0, finished = 0, errors = new Map();
const GAMES = Number(process.argv[2] ?? 60);

for (let g = 0; g < GAMES; g++) {
  const state = createGameState();
  initDeck(state);
  startGame(state);
  let guard = 0;
  try {
    while (state.phase === 'active' && guard++ < 6000) {
      if (state.pendingChoice) {
        const r = answer(state);
        if (r && r.error) errors.set(r.error, (errors.get(r.error) ?? 0) + 1);
        continue;
      }
      if (advancePendingChoices(state)) continue;

      const me = state.activePlayer;
      const hand = state.players[me].hand;
      const roll = Math.random();
      if (roll < 0.35 && hand.length) {
        voidCard(state, me, pick(hand));
      } else if (roll < 0.75 && hand.length) {
        playCard(state, me, pick(hand));   // illegal plays return an ERROR event, harmless
      } else {
        passPriority(state, me);
      }
    }
    if (state.phase === 'ended') finished++;
    else hardlocks++;
  } catch (err) {
    crashes.push(err.message);
  }
}

console.log(`${GAMES} games — finished: ${finished}, hardlocked: ${hardlocks}, crashed: ${crashes.length}`);
if (crashes.length) {
  const counts = new Map();
  for (const c of crashes) counts.set(c, (counts.get(c) ?? 0) + 1);
  console.log('\nCrashes:');
  for (const [msg, n] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${n}x ${msg}`);
}
if (errors.size) {
  console.log('\nRejected choice answers (fuzz picked an illegal option — not necessarily a bug):');
  for (const [msg, n] of [...errors].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${n}x ${msg}`);
}
