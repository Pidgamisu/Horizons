import { getCard } from '../data/cardDb.js';
import {
  createGameState, createHorizonEntry, createTurnFlags,
  drawCards, sendToTrash, opponent, controllerOf, computeActualCost,
  isChoiceTrigger,
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
  if (context.fromTrash) {
    const idx = state.zones.trash.indexOf(cardId);
    state.zones.trash.splice(idx, 1);
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
      const resolveEvents = resolveTopOfHorizon(state);
      events.push(...resolveEvents);
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

// ─── Horizon Resolution ─────────────────────────────────────────────────────────

export function resolveTopOfHorizon(state) {
  if (state.zones.horizon.length === 0) return [];
  const events = [];

  // The resolving card stays ON the horizon while its effect runs, so it's still
  // visible to both players and is a legal target for its own effect (e.g. Stop
  // 44 may trash itself). It's removed + trashed only once resolution completes.
  const entry = state.zones.horizon[0];
  const card = getCard(entry.cardId);

  events.push({ type: 'CARD_RESOLVING', cardId: entry.cardId, controller: controllerOf(entry) });

  // moveSelf / swapHorizonPositions relocate the card itself; pull it off the
  // horizon first so those effects don't act on (or duplicate) a card that's
  // still sitting there.
  const selfMoved = card.effects?.some(e => e.type === 'moveSelf' || e.type === 'swapHorizonPositions');
  if (selfMoved) {
    removeHorizonEntry(state, entry);
  } else {
    entry.resolving = true;
  }

  // Execute effects
  const effectEvents = executeEffects(state, entry);
  events.push(...effectEvents);

  if (!selfMoved && state.zones.horizon.includes(entry)) {
    // The effect may have removed the card itself (it targeted / trashed itself).
    // If it's still on the horizon, finish trashing it — but only once it has
    // FULLY taken effect. A spawned player choice (Stop 44 → trashFromHorizon,
    // Dig for Ideas 45 → putFromTrashToHand, …) resolves asynchronously, so keep
    // the card on the horizon (still visible + targetable) and defer the trash
    // until the choice chain drains (see flushResolutionTrash).
    if (state.pendingTriggers.some(isChoiceTrigger)) {
      state.pendingResolutionTrash.push(entry);
    } else {
      entry.resolving = false;
      removeHorizonEntry(state, entry);
      sendToTrash(state, entry.cardId);
      events.push({ type: 'CARD_TRASHED', cardId: entry.cardId });
    }
  } else {
    entry.resolving = false;
  }

  // Fire "opponent's card took effect" triggers (Share the Loot 75)
  if (!state.winner) {
    const lootEvents = checkResolveTriggers(state, entry);
    events.push(...lootEvents);
  }

  return events;
}

/** Remove a specific entry from the horizon (no-op if already gone). */
function removeHorizonEntry(state, entry) {
  const i = state.zones.horizon.indexOf(entry);
  if (i !== -1) state.zones.horizon.splice(i, 1);
}

/**
 * Trash any cards that finished resolving while a player choice was outstanding.
 * Called once the choice chain drains (no pending choice) so a resolved card
 * reaches the trash only after its effect is fully complete — and before the
 * next card on the horizon starts resolving.
 */
export function flushResolutionTrash(state) {
  if (state.pendingResolutionTrash.length === 0) return [];
  const events = [];
  for (const entry of state.pendingResolutionTrash) {
    entry.resolving = false;
    const i = state.zones.horizon.indexOf(entry);
    if (i !== -1) {
      state.zones.horizon.splice(i, 1);
      sendToTrash(state, entry.cardId);
      events.push({ type: 'CARD_TRASHED', cardId: entry.cardId });
    }
    // else: the card left the horizon during its own resolution (it targeted
    // itself, e.g. Stop trashing itself) — its destination is already handled.
  }
  state.pendingResolutionTrash = [];
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

  // 5b. Capture deferred "start of next turn" triggers (Prepare 50 draw, Last
  //     Chance 76 trash, …) before the per-turn reset wipes pendingTriggers.
  const deferred = state.pendingTriggers.filter(
    t => t.type === 'draw' || t.type === 'endOfTurnTrash'
  );

  // 6. Reset per-turn state
  state.cardsPlayedThisTurn = [];
  state.cardsDrawnThisTurn = { p1: 0, p2: 0 };
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
        if (effect.type === 'trashSelf') {
          const idx = state.zones.horizon.indexOf(horizonEntry);
          if (idx !== -1) {
            state.zones.horizon.splice(idx, 1);
            sendToTrash(state, horizonEntry.cardId);
            events.push({ type: 'CARD_TRASHED_BY_TRIGGER', cardId: horizonEntry.cardId });
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

function flushDeferredTriggers(state, deferred) {
  const events = [];
  for (const trigger of deferred) {
    if (trigger.type === 'draw') {
      // Prepare (50) etc. — draw on top of the refilled hand.
      const drawn = drawCards(state, trigger.player, trigger.count);
      events.push({ type: 'CARDS_DRAWN', player: trigger.player, cards: drawn, reason: 'endOfTurnTrigger' });
    } else if (trigger.type === 'endOfTurnTrash') {
      // Last Chance (76) — the owner now chooses which cards to trash. Clamp to
      // what they actually hold; an empty hand trashes nothing.
      const effective = Math.min(trigger.count, state.players[trigger.player].hand.length);
      if (effective === 0) continue;
      state.pendingTriggers.push({ type: 'trashFromHandChoice', player: trigger.player, count: effective, optional: false });
      events.push({ type: 'CHOICE_REQUIRED', player: trigger.player, choiceType: 'trashFromHand', count: effective });
    }
  }
  return events;
}
