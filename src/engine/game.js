import { getCard } from '../data/cardDb.js';
import {
  createGameState, createHorizonEntry, createTurnFlags,
  drawCards, sendToDusk, sendToZenith, opponent, controllerOf, computeActualCost,
  isDeckSpent, pointsOf,
} from './state.js';
import { validatePlay } from './validation.js';
import { executeEffects, executeOnPlayEffects } from '../effects/executor.js';

// ─── Game Lifecycle ───────────────────────────────────────────────────────────

export function startGame(state) {
  state.phase = 'active';
  state.turn = 'p1';
  state.activePlayer = 'p1';
  state.turnNumber = 1;

  // Both players draw opening hands of 5
  drawCards(state, 'p1', 5);
  drawCards(state, 'p2', 5);

  // Reset draw tracking (opening hands don't count as "drawn this turn")
  state.cardsDrawnThisTurn = { p1: 0, p2: 0 };

  return [{ type: 'GAME_STARTED', firstPlayer: 'p1' }];
}

// ─── Playing a Card ───────────────────────────────────────────────────────────

export function playCard(state, playerId, cardId, context = {}) {
  if (state.phase !== 'active') return [{ type: 'ERROR', code: 'GAME_NOT_ACTIVE' }];

  // A granted free play (Metamorphosis 61, Reinstate 84, Predict 54) bypasses
  // priority, play restrictions, energy cost, and additional costs.
  if (!context.free) {
    if (state.activePlayer !== playerId) return [{ type: 'ERROR', code: 'NOT_YOUR_PRIORITY' }];
    const error = validatePlay(state, playerId, cardId, context);
    if (error) return [{ type: 'ERROR', code: 'INVALID_PLAY', message: error }];
  }

  const card = getCard(cardId);
  const events = [];

  if (!context.free) {
    // Pay energy cost
    const cost = computeActualCost(state, cardId, playerId, context);
    state.players[playerId].energy -= cost;
    events.push({ type: 'ENERGY_SPENT', player: playerId, amount: cost });

    // Pay additional costs (validated separately, surfaced as pending choices)
    for (const addCost of card.additionalCosts ?? []) {
      state.pendingTriggers.push({ type: 'additionalCost', player: playerId, cost: addCost });
      events.push({ type: 'ADDITIONAL_COST_REQUIRED', player: playerId, cost: addCost });
    }
  } else {
    events.push({ type: 'FREE_PLAY', player: playerId, cardId });
  }

  // Remove from source zone
  if (context.fromDusk) {
    const idx = state.zones.dusk.indexOf(cardId);
    state.zones.dusk.splice(idx, 1);
  } else {
    const hand = state.players[playerId].hand;
    hand.splice(hand.indexOf(cardId), 1);
  }

  // Build horizon entry
  const entry = createHorizonEntry(cardId, playerId, {
    respondedToCardIndex: state.zones.horizon.length > 0 ? 0 : null,
    respondedToCardType:  state.zones.horizon.length > 0 ? getCard(state.zones.horizon[0].cardId).type : null,
  });

  // Injustice (67): if this player's next action is protected, lock responses
  // to this entry and consume the protection.
  if (card.type === 'action' && state.turnFlags.protectNextSelfAction === playerId) {
    entry.responsesLocked = true;
    state.turnFlags.protectNextSelfAction = null;
  }

  // Place on top of horizon
  state.zones.horizon.unshift(entry);

  // Track play
  state.cardsPlayedThisTurn.push({ cardId, playedBy: playerId });

  events.push({ type: 'CARD_PLAYED', player: playerId, cardId, horizonSize: state.zones.horizon.length });

  // Fire on-play effects (Insanity 18, Erase Reason 11, Invest 27)
  const onPlayEvents = executeOnPlayEffects(state, entry);
  events.push(...onPlayEvents);

  // Check static triggers (Sow 29, Reap 30, Treasure Anew 24, Endure 21, Trip 37)
  const triggerEvents = checkPlayTriggers(state, entry, playerId);
  events.push(...triggerEvents);

  // Priority passes to other player (pass count resets)
  state.priorityPassCount = 0;
  state.activePlayer = opponent(playerId);
  events.push({ type: 'PRIORITY_PASSED', to: state.activePlayer });

  return events;
}

// ─── Priority Passing ─────────────────────────────────────────────────────────

/**
 * A player only ever holds priority in two situations:
 *   1. Their own main phase — their turn with an empty horizon.
 *   2. There's an opponent-controlled card on top of the horizon to respond to.
 * Every other window is "dead": there's no way to act, so the player should be
 * skipped rather than handed a pass-only prompt.
 */
export function isLivePriorityWindow(state, playerId) {
  const horizon = state.zones.horizon;
  if (state.turn === playerId && horizon.length === 0) return true;        // own main phase
  if (horizon.length > 0 && controllerOf(horizon[0]) !== playerId) return true; // opponent's card to respond to
  return false;
}

export function passPriority(state, playerId) {
  if (state.phase !== 'active') return [{ type: 'ERROR', code: 'GAME_NOT_ACTIVE' }];
  if (state.activePlayer !== playerId) return [{ type: 'ERROR', code: 'NOT_YOUR_PRIORITY' }];

  const events = [];
  state.priorityPassCount++;

  if (state.priorityPassCount >= 2) {
    // Both passed — resolve top of horizon or end turn
    if (state.zones.horizon.length > 0) {
      events.push(...riseTopOfHorizon(state));
      if (state.winner) return events;
      // After resolution, active turn player gets priority
      state.priorityPassCount = 0;
      state.activePlayer = state.turn;
      events.push({ type: 'PRIORITY_RETURNED', to: state.turn });
    } else {
      // Horizon empty — end turn
      const endEvents = endTurn(state);
      events.push(...endEvents);
    }
  } else {
    // One pass — priority moves to other player
    state.activePlayer = opponent(playerId);
    events.push({ type: 'PRIORITY_PASSED', to: state.activePlayer });
  }

  return events;
}

// ─── Rising ───────────────────────────────────────────────────────────────────

/**
 * The top card of the horizon rises.
 *
 * Rulebook order (p2 / p4): the card LEAVES the horizon first — into the dusk if
 * it's an action, into its controller's zenith if it's a point — and only then
 * does its controller do the card's text. That ordering matters: a risen card is
 * never a legal target for its own effect, and a point is already banked (and
 * counts for Sunset scoring) before its text runs.
 */
export function riseTopOfHorizon(state) {
  if (state.zones.horizon.length === 0) return [];
  const events = [];

  const entry = state.zones.horizon[0];
  const card = getCard(entry.cardId);
  const controller = controllerOf(entry);

  events.push({ type: 'CARD_RISING', cardId: entry.cardId, controller });

  // 1. Off the horizon, into its destination.
  removeHorizonEntry(state, entry);
  if (entry.returnToHandOnRise) {
    // Reverse (052) / Forever Borrow (036): the borrowed card goes back to
    // whoever originally played it instead of to the dusk or a zenith.
    const owner = entry.returnToHandOnRise;
    state.players[owner].hand.push(entry.cardId);
    events.push({ type: 'CARD_RETURNED_TO_HAND', cardId: entry.cardId, player: owner });
  } else if (card.type === 'point') {
    sendToZenith(state, controller, entry.cardId);
    events.push({ type: 'CARD_TO_ZENITH', cardId: entry.cardId, player: controller });
  } else {
    sendToDusk(state, entry.cardId);
    events.push({ type: 'CARD_TO_DUSK', cardId: entry.cardId });
  }

  // 2. Now the controller does the card's text.
  const effectEvents = executeEffects(state, entry);
  events.push(...effectEvents);

  // Fire "opponent's card took effect" triggers (Share the Loot 085)
  if (!state.winner) {
    events.push(...checkRiseTriggers(state, entry));
  }

  // The card has finished rising — if the deck ran dry, the sun sets now.
  events.push(...checkSunset(state));

  return events;
}

/** Remove a specific entry from the horizon (no-op if already gone). */
function removeHorizonEntry(state, entry) {
  const i = state.zones.horizon.indexOf(entry);
  if (i !== -1) state.zones.horizon.splice(i, 1);
}

// ─── Sunset ───────────────────────────────────────────────────────────────────

/**
 * Sunset (rulebook p8): once the deck is empty and no reshuffles remain, finish
 * letting the current card rise, then put everything left on the horizon into
 * the dusk and end the game. Most points in your zenith wins.
 *
 * Called after a card finishes rising and after the end-of-turn refill — the two
 * moments the deck can run dry. A tie is a draw; only Answer Fate (048) can hand
 * back a reshuffle and push Sunset further out.
 */
export function checkSunset(state) {
  if (state.phase !== 'active' || state.winner) return [];
  if (!isDeckSpent(state)) return [];

  const events = [{ type: 'SUNSET' }];

  // Anything still on the horizon never rises — it goes straight to the dusk.
  for (const entry of state.zones.horizon) {
    sendToDusk(state, entry.cardId);
    events.push({ type: 'CARD_TO_DUSK', cardId: entry.cardId, reason: 'sunset' });
  }
  state.zones.horizon = [];

  const p1 = pointsOf(state, 'p1');
  const p2 = pointsOf(state, 'p2');
  state.winner = p1 === p2 ? 'draw' : (p1 > p2 ? 'p1' : 'p2');
  state.phase = 'ended';

  events.push({ type: 'GAME_OVER', winner: state.winner, reason: 'sunset', points: { p1, p2 } });
  return events;
}

// ─── End of Turn ──────────────────────────────────────────────────────────────

export function endTurn(state) {
  if (state.zones.horizon.length > 0) {
    return [{ type: 'ERROR', code: 'HORIZON_NOT_EMPTY', message: 'Horizon must be empty to end the turn.' }];
  }

  const events = [];
  const currentPlayer = state.turn;
  const otherPlayer = opponent(currentPlayer);
  const isFirstTurn = state.turnNumber === 1;

  // 2. Wipe energy for both players
  state.players.p1.energy = 0;
  state.players.p2.energy = 0;
  events.push({ type: 'ENERGY_WIPED' });

  // 4. Current player draws up to 5
  const currentHand = state.players[currentPlayer].hand.length;
  const drawCount = Math.max(0, 5 - currentHand);
  if (drawCount > 0) {
    const drawn = drawCards(state, currentPlayer, drawCount);
    events.push({ type: 'CARDS_DRAWN', player: currentPlayer, cards: drawn });
  }

  // 5. If this is turn 1 (P1's first turn), P2 also draws up to 5 now
  if (isFirstTurn && currentPlayer === 'p1') {
    const p2Hand = state.players[otherPlayer].hand.length;
    const p2Draw = Math.max(0, 5 - p2Hand);
    if (p2Draw > 0) {
      const drawn = drawCards(state, otherPlayer, p2Draw);
      events.push({ type: 'CARDS_DRAWN', player: otherPlayer, cards: drawn });
    }
  }

  // 5b. Capture deferred "start of next turn" triggers (Prepare 50 draw, Last
  //     Chance 76 trash, …) before the per-turn reset wipes pendingTriggers.
  const deferred = state.pendingTriggers.filter(
    t => t.type === 'draw' || t.type === 'endOfTurnDusk'
  );

  // 6. Reset per-turn state
  state.cardsPlayedThisTurn = [];
  state.cardsDrawnThisTurn = { p1: 0, p2: 0 };
  state.cardsToDuskThisTurn = [];
  state.turnFlags = createTurnFlags();
  state.players.p1.lockedFromPlaying = false;
  state.players.p2.lockedFromPlaying = false;
  state.players.p1.pointResponseToActions = false;
  state.players.p2.pointResponseToActions = false;
  state.pendingTriggers = []; // clear all leftover triggers

  // 6b. Fire the captured deferred triggers AFTER the refill + reset: queued
  //     draws happen now (on top of the 5-card hand); a deferred trash becomes
  //     a choice the owner resolves at the start of their next turn.
  const triggerEvents = flushDeferredTriggers(state, deferred);
  events.push(...triggerEvents);

  // 7. Pass turn
  state.turn = otherPlayer;
  state.activePlayer = otherPlayer;
  state.priorityPassCount = 0;
  state.turnNumber++;

  events.push({ type: 'TURN_ENDED', nextTurn: otherPlayer, turnNumber: state.turnNumber });

  // The refill is the usual way the deck runs dry.
  events.push(...checkSunset(state));

  return events;
}

// ─── Voiding ──────────────────────────────────────────────────────────────────

export function voidCard(state, playerId, cardId) {
  if (state.phase !== 'active') return [{ type: 'ERROR', code: 'GAME_NOT_ACTIVE' }];
  if (state.activePlayer !== playerId) return [{ type: 'ERROR', code: 'NOT_YOUR_PRIORITY' }];

  const hand = state.players[playerId].hand;
  const idx = hand.indexOf(cardId);
  if (idx === -1) return [{ type: 'ERROR', code: 'CARD_NOT_IN_HAND' }];

  hand.splice(idx, 1);
  state.zones.dusk.push(cardId);
  state.players[playerId].energy += 3;

  return [{ type: 'CARD_VOIDED', player: playerId, cardId, energyNow: state.players[playerId].energy }];
}

// ─── Trigger Helpers ──────────────────────────────────────────────────────────

function checkPlayTriggers(state, newEntry, playedBy) {
  const events = [];

  for (const horizonEntry of state.zones.horizon) {
    if (horizonEntry === newEntry) continue;
    const card = getCard(horizonEntry.cardId);
    const entryController = controllerOf(horizonEntry);

    for (const se of card.staticEffects ?? []) {
      if (se.type !== 'trigger') continue;
      const { on, effect } = se;

      if (on === 'opponentPlaysCard' && playedBy !== entryController) {
        events.push(...executeStaticTriggerEffect(state, effect, entryController));
      }
      if (on === 'anyPlayerPlaysCard') {
        events.push(...executeStaticTriggerEffect(state, effect, playedBy, entryController));
      }
      if (on === 'nthCardPlayedThisTurn' && se.n === state.cardsPlayedThisTurn.length) {
        // Trip (37) — trash itself
        if (effect.type === 'duskSelf') {
          const idx = state.zones.horizon.indexOf(horizonEntry);
          if (idx !== -1) {
            state.zones.horizon.splice(idx, 1);
            sendToDusk(state, horizonEntry.cardId);
            events.push({ type: 'CARD_TO_DUSK_BY_TRIGGER', cardId: horizonEntry.cardId });
          }
        }
      }
    }
  }

  return events;
}

function checkRiseTriggers(state, resolvedEntry) {
  const events = [];
  const resolvedController = controllerOf(resolvedEntry);

  // Share the Loot (75) — find if any active trigger matches "opponentCardTakesEffect"
  for (const trigger of state.pendingTriggers) {
    if (trigger.type === 'registerTurnTrigger' && trigger.on === 'opponentCardTakesEffect') {
      if (resolvedController !== trigger.owner) {
        events.push(...executeStaticTriggerEffect(state, trigger.effect, trigger.owner));
      }
    }
  }

  return events;
}

function executeStaticTriggerEffect(state, effect, contextPlayer, thatPlayer) {
  const events = [];
  const target = effect.player === 'controller' ? contextPlayer
    : effect.player === 'thatPlayer' ? (thatPlayer ?? contextPlayer)
    : effect.player === 'both' ? 'both'
    : contextPlayer;

  switch (effect.type) {
    case 'draw': {
      if (target === 'both') {
        const d1 = drawCards(state, 'p1', effect.count);
        const d2 = drawCards(state, 'p2', effect.count);
        events.push({ type: 'CARDS_DRAWN', p1: d1, p2: d2 });
      } else {
        const drawn = drawCards(state, target, effect.count);
        events.push({ type: 'CARDS_DRAWN', player: target, cards: drawn });
      }
      break;
    }
    case 'gainEnergy': {
      if (target === 'both') {
        state.players.p1.energy += effect.amount;
        state.players.p2.energy += effect.amount;
        events.push({ type: 'ENERGY_GAINED', both: effect.amount });
      } else {
        state.players[target].energy += effect.amount;
        events.push({ type: 'ENERGY_GAINED', player: target, amount: effect.amount });
      }
      break;
    }
    case 'duskFromHand': {
      // Reap (30) — each player must trash a card
      const players = target === 'both' ? ['p1', 'p2'] : [target];
      for (const p of players) {
        state.pendingTriggers.push({ type: 'duskFromHandChoice', player: p, count: effect.count ?? 1 });
        events.push({ type: 'CHOICE_REQUIRED', player: p, choiceType: 'duskFromHand', count: effect.count ?? 1 });
      }
      break;
    }
  }

  return events;
}

function flushDeferredTriggers(state, deferred) {
  const events = [];
  for (const trigger of deferred) {
    if (trigger.type === 'draw') {
      // Prepare (50) etc. — draw on top of the refilled hand.
      const drawn = drawCards(state, trigger.player, trigger.count);
      events.push({ type: 'CARDS_DRAWN', player: trigger.player, cards: drawn, reason: 'endOfTurnTrigger' });
    } else if (trigger.type === 'endOfTurnDusk') {
      // Last Chance (76) — the owner now chooses which cards to trash. Clamp to
      // what they actually hold; an empty hand trashes nothing.
      const effective = Math.min(trigger.count, state.players[trigger.player].hand.length);
      if (effective === 0) continue;
      state.pendingTriggers.push({ type: 'duskFromHandChoice', player: trigger.player, count: effective, optional: false });
      events.push({ type: 'CHOICE_REQUIRED', player: trigger.player, choiceType: 'duskFromHand', count: effective });
    }
  }
  return events;
}
