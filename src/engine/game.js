import { getCard } from '../data/cardDb.js';
import {
  createGameState, createStackEntry, createTurnFlags,
  drawCards, sendToTrash, opponent, controllerOf, computeActualCost,
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
  if (state.activePlayer !== playerId) return [{ type: 'ERROR', code: 'NOT_YOUR_PRIORITY' }];

  // Validate
  const error = validatePlay(state, playerId, cardId, context);
  if (error) return [{ type: 'ERROR', code: 'INVALID_PLAY', message: error }];

  const card = getCard(cardId);
  const events = [];

  // Pay energy cost
  const cost = computeActualCost(state, cardId, playerId, context);
  state.players[playerId].energy -= cost;
  events.push({ type: 'ENERGY_SPENT', player: playerId, amount: cost });

  // Pay additional costs (additionalCosts are validated separately, handled here)
  // For now, additional costs that require choices are added as pending triggers
  for (const addCost of card.additionalCosts ?? []) {
    state.pendingTriggers.push({ type: 'additionalCost', player: playerId, cost: addCost });
    events.push({ type: 'ADDITIONAL_COST_REQUIRED', player: playerId, cost: addCost });
  }

  // Remove from source zone
  if (context.fromTrash) {
    const idx = state.zones.trash.indexOf(cardId);
    state.zones.trash.splice(idx, 1);
  } else {
    const hand = state.players[playerId].hand;
    hand.splice(hand.indexOf(cardId), 1);
  }

  // Build stack entry
  const entry = createStackEntry(cardId, playerId, {
    respondedToCardIndex: state.zones.stack.length > 0 ? 0 : null,
    respondedToCardType:  state.zones.stack.length > 0 ? getCard(state.zones.stack[0].cardId).type : null,
  });

  // Injustice (67): if this player's next action is protected, lock responses
  // to this entry and consume the protection.
  if (card.type === 'action' && state.turnFlags.protectNextSelfAction === playerId) {
    entry.responsesLocked = true;
    state.turnFlags.protectNextSelfAction = null;
  }

  // Place on top of stack
  state.zones.stack.unshift(entry);

  // Track play
  state.cardsPlayedThisTurn.push({ cardId, playedBy: playerId });

  events.push({ type: 'CARD_PLAYED', player: playerId, cardId, stackSize: state.zones.stack.length });

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

export function passPriority(state, playerId) {
  if (state.phase !== 'active') return [{ type: 'ERROR', code: 'GAME_NOT_ACTIVE' }];
  if (state.activePlayer !== playerId) return [{ type: 'ERROR', code: 'NOT_YOUR_PRIORITY' }];

  const events = [];
  state.priorityPassCount++;

  if (state.priorityPassCount >= 2) {
    // Both passed — resolve top of stack or end turn
    if (state.zones.stack.length > 0) {
      const resolveEvents = resolveTopOfStack(state);
      events.push(...resolveEvents);
      if (state.winner) return events;
      // After resolution, active turn player gets priority
      state.priorityPassCount = 0;
      state.activePlayer = state.turn;
      events.push({ type: 'PRIORITY_RETURNED', to: state.turn });
    } else {
      // Stack empty — end turn
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

// ─── Stack Resolution ─────────────────────────────────────────────────────────

export function resolveTopOfStack(state) {
  if (state.zones.stack.length === 0) return [];
  const events = [];

  // Remove from top
  const entry = state.zones.stack.shift();
  const card = getCard(entry.cardId);

  events.push({ type: 'CARD_RESOLVING', cardId: entry.cardId, controller: controllerOf(entry) });

  // Execute effects
  const effectEvents = executeEffects(state, entry);
  events.push(...effectEvents);

  // Send to trash (unless effect moved it — moveSelf effects handle their own destination)
  const selfMoved = card.effects?.some(e => e.type === 'moveSelf' || e.type === 'swapStackPositions');
  if (!selfMoved) {
    sendToTrash(state, entry.cardId);
    events.push({ type: 'CARD_TRASHED', cardId: entry.cardId });
  }

  // Fire "opponent's card took effect" triggers (Share the Loot 75)
  if (!state.winner) {
    const lootEvents = checkResolveTriggers(state, entry);
    events.push(...lootEvents);
  }

  return events;
}

// ─── End of Turn ──────────────────────────────────────────────────────────────

export function endTurn(state) {
  if (state.zones.stack.length > 0) {
    return [{ type: 'ERROR', code: 'STACK_NOT_EMPTY', message: 'Stack must be empty to end the turn.' }];
  }

  const events = [];
  const currentPlayer = state.turn;
  const otherPlayer = opponent(currentPlayer);
  const isFirstTurn = state.turnNumber === 1;

  // 2. Wipe energy for both players
  state.players.p1.energy = 0;
  state.players.p2.energy = 0;
  events.push({ type: 'ENERGY_WIPED' });

  // 3. Move trash → void
  state.zones.void.push(...state.zones.trash);
  state.zones.trash = [];
  events.push({ type: 'TRASH_TO_VOID' });

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

  // 5b. Flush deferred "draw at start of next turn" triggers (Prepare 50,
  //     Foresee 95, etc.) AFTER the refill so they add cards on top of the
  //     5-card hand instead of being absorbed by draw-up-to-5.
  const triggerEvents = flushEndOfTurnTriggers(state);
  events.push(...triggerEvents);

  // 6. Reset per-turn state
  state.cardsPlayedThisTurn = [];
  state.cardsDrawnThisTurn = { p1: 0, p2: 0 };
  state.turnFlags = createTurnFlags();
  state.players.p1.lockedFromPlaying = false;
  state.players.p2.lockedFromPlaying = false;
  state.players.p1.pointResponseToActions = false;
  state.players.p2.pointResponseToActions = false;
  state.pendingTriggers = state.pendingTriggers.filter(t => t.type === 'registerTurnTrigger' && false); // clear all

  // 7. Pass turn
  state.turn = otherPlayer;
  state.activePlayer = otherPlayer;
  state.priorityPassCount = 0;
  state.turnNumber++;

  events.push({ type: 'TURN_ENDED', nextTurn: otherPlayer, turnNumber: state.turnNumber });

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
  state.zones.void.push(cardId);
  state.players[playerId].energy += 3;

  return [{ type: 'CARD_VOIDED', player: playerId, cardId, energyNow: state.players[playerId].energy }];
}

// ─── Trigger Helpers ──────────────────────────────────────────────────────────

function checkPlayTriggers(state, newEntry, playedBy) {
  const events = [];

  for (const stackEntry of state.zones.stack) {
    if (stackEntry === newEntry) continue;
    const card = getCard(stackEntry.cardId);
    const entryController = controllerOf(stackEntry);

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
        if (effect.type === 'trashSelf') {
          const idx = state.zones.stack.indexOf(stackEntry);
          if (idx !== -1) {
            state.zones.stack.splice(idx, 1);
            sendToTrash(state, stackEntry.cardId);
            events.push({ type: 'CARD_TRASHED_BY_TRIGGER', cardId: stackEntry.cardId });
          }
        }
      }
    }
  }

  return events;
}

function checkResolveTriggers(state, resolvedEntry) {
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
    case 'trashFromHand': {
      // Reap (30) — each player must trash a card
      const players = target === 'both' ? ['p1', 'p2'] : [target];
      for (const p of players) {
        state.pendingTriggers.push({ type: 'trashFromHandChoice', player: p, count: effect.count ?? 1 });
        events.push({ type: 'CHOICE_REQUIRED', player: p, choiceType: 'trashFromHand', count: effect.count ?? 1 });
      }
      break;
    }
  }

  return events;
}

function flushEndOfTurnTriggers(state) {
  const events = [];
  // Fire every queued "start of next turn" draw for whichever player owns it.
  // (Each turn boundary is the start of someone's next turn; the trigger is
  // removed once fired so it only happens once.)
  const toProcess = state.pendingTriggers.filter(t => t.type === 'draw');
  state.pendingTriggers = state.pendingTriggers.filter(t => t.type !== 'draw');

  for (const trigger of toProcess) {
    const drawn = drawCards(state, trigger.player, trigger.count);
    events.push({ type: 'CARDS_DRAWN', player: trigger.player, cards: drawn, reason: 'endOfTurnTrigger' });
  }

  return events;
}
