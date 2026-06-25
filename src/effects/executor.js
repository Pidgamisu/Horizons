import { getCard } from '../data/cardDb.js';
import {
  drawCards, trashCardFromHand, trashHand, trashFromStack,
  sendToTrash, removeFromStack, shuffle, opponent, controllerOf,
} from '../engine/state.js';

/**
 * Execute all effects of a card when it resolves.
 * entry = the StackEntry that just resolved.
 * Returns an array of event objects describing what happened (for broadcast).
 */
export function executeEffects(state, entry) {
  const card = getCard(entry.cardId);
  const controller = controllerOf(entry);
  const events = [];

  // Point cards always grant a point first (before any additional effects)
  if (card.type === 'point') {
    grantPoints(state, controller, 1, events);
    if (state.winner) return events; // game over — stop processing
  }

  for (const effect of card.effects ?? []) {
    const newEvents = executeEffect(state, effect, controller, entry, {});
    events.push(...newEvents);
    if (state.winner) break; // stop if game ended mid-effect
  }

  return events;
}

/**
 * Execute onPlayEffects — triggered when the card hits the stack, not on resolution.
 */
export function executeOnPlayEffects(state, entry) {
  const card = getCard(entry.cardId);
  const controller = controllerOf(entry);
  const events = [];

  for (const effect of card.onPlayEffects ?? []) {
    const newEvents = executeEffect(state, effect, controller, entry, {});
    events.push(...newEvents);
  }

  return events;
}

// ─── Internal dispatcher ──────────────────────────────────────────────────────

function executeEffect(state, effect, controller, entry, ctx) {
  const events = [];
  const opp = opponent(controller);

  switch (effect.type) {

    case 'gainPoints': {
      const target = effect.player === 'self' ? controller : opp;
      grantPoints(state, target, effect.amount, events);
      break;
    }

    case 'gainEnergy': {
      const amount = resolveAmount(state, effect.amount, ctx);
      if (effect.player === 'both') {
        state.players.p1.energy += amount;
        state.players.p2.energy += amount;
        events.push({ type: 'ENERGY_GAINED', p1: amount, p2: amount });
      } else {
        const target = effect.player === 'self' ? controller : opp;
        state.players[target].energy += amount;
        events.push({ type: 'ENERGY_GAINED', player: target, amount });
      }
      break;
    }

    case 'draw': {
      if (effect.timing === 'endOfTurn') {
        state.pendingTriggers.push({ type: 'draw', count: effect.count, player: controller });
        events.push({ type: 'PENDING_DRAW', player: controller, count: effect.count });
        break;
      }
      const count = resolveAmount(state, effect.count, ctx);
      const target = resolvePlayers(effect.player, controller, opp);
      if (target === 'both') {
        const d1 = drawCards(state, controller, count);
        const d2 = drawCards(state, opp, count);
        events.push({ type: 'CARDS_DRAWN', p1: { player: controller, cards: d1 }, p2: { player: opp, cards: d2 } });
      } else {
        const drawn = drawCards(state, target, count);
        events.push({ type: 'CARDS_DRAWN', player: target, cards: drawn });
      }
      break;
    }

    case 'trashFromHand': {
      const count = effect.count;
      const targets = resolvePlayers(effect.player, controller, opp);
      const playerList = targets === 'both' ? [controller, opp] : [targets];
      for (const p of playerList) {
        // In a real server this would be async (prompt player) — here we mark as pending choice
        state.pendingTriggers.push({ type: 'trashFromHandChoice', player: p, count, optional: false });
        events.push({ type: 'CHOICE_REQUIRED', player: p, choiceType: 'trashFromHand', count });
      }
      break;
    }

    case 'trashHand': {
      const target = effect.player === 'self' ? controller : opp;
      const count = trashHand(state, target);
      ctx.cardsJustTrashed = (ctx.cardsJustTrashed ?? 0) + count;
      events.push({ type: 'HAND_TRASHED', player: target, count });
      break;
    }

    case 'trashFromStack': {
      // In real server: prompt chooser to pick a stack card matching filter
      // Here: mark as pending choice
      state.pendingTriggers.push({
        type: 'trashFromStackChoice',
        player: controller,
        filter: effect.filter,
        thenGrant: effect.thenGrant ?? null,
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'trashFromStack', filter: effect.filter });
      break;
    }

    case 'trashAllFromStack': {
      const trashed = [];
      while (state.zones.stack.length > 0) {
        const e = state.zones.stack.shift();
        sendToTrash(state, e.cardId);
        trashed.push(e.cardId);
      }
      ctx.cardsJustTrashed = (ctx.cardsJustTrashed ?? 0) + trashed.length;
      events.push({ type: 'STACK_CLEARED', cards: trashed });
      break;
    }

    case 'trashTopOfDeck': {
      for (let i = 0; i < (effect.count ?? 1); i++) {
        if (state.zones.deck.length === 0) break;
        const card = state.zones.deck.shift();
        sendToTrash(state, card);
        events.push({ type: 'DECK_TOP_TRASHED', card });
      }
      break;
    }

    case 'revealHand': {
      // Reveal is informational — server sends hand contents to both players temporarily
      const target = effect.target === 'opponent' ? opp
        : effect.target === 'both' ? 'both'
        : controller; // 'chosenPlayer' handled by pending choice
      events.push({ type: 'HAND_REVEALED', target, cards: target === 'both'
        ? { [controller]: state.players[controller].hand, [opp]: state.players[opp].hand }
        : state.players[target].hand
      });
      break;
    }

    case 'putFromTrashToHand': {
      state.pendingTriggers.push({ type: 'putFromTrashToHandChoice', player: controller, count: effect.count });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'putFromTrashToHand', count: effect.count });
      break;
    }

    case 'returnToControllerHand': {
      state.pendingTriggers.push({ type: 'returnStackCardToHandChoice', player: controller, filter: effect.filter });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'returnToControllerHand', filter: effect.filter });
      break;
    }

    case 'moveFromStackToHand': {
      // Steal Intensity (86) — puts a point card on stack into your own hand
      state.pendingTriggers.push({ type: 'stealFromStackChoice', player: controller, filter: effect.filter });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'stealFromStack', filter: effect.filter });
      break;
    }

    case 'moveSelf': {
      // The card being resolved (already removed from stack before this runs)
      if (effect.to === 'deckTop') {
        state.zones.deck.unshift(entry.cardId);
        events.push({ type: 'CARD_TO_DECK_TOP', card: entry.cardId });
      } else if (effect.to === 'opponentHand') {
        state.players[opp].hand.push(entry.cardId);
        events.push({ type: 'CARD_TO_OPPONENT_HAND', card: entry.cardId, player: opp });
      }
      break;
    }

    case 'swapStackPositions': {
      // Forever Borrow (36): swap this card's position with the responded-to card
      const selfIdx = state.zones.stack.findIndex(e => e === entry);
      const targetIdx = entry.respondedToCardIndex;
      if (selfIdx !== -1 && targetIdx !== null && targetIdx !== -1) {
        const temp = state.zones.stack[selfIdx];
        state.zones.stack[selfIdx] = state.zones.stack[targetIdx];
        state.zones.stack[targetIdx] = temp;
        events.push({ type: 'STACK_POSITIONS_SWAPPED', indexA: selfIdx, indexB: targetIdx });
      }
      break;
    }

    case 'gainControl': {
      state.pendingTriggers.push({
        type: 'gainControlChoice',
        player: controller,
        filter: effect.filter,
        onResolve: effect.onResolve ?? null,
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'gainControl', filter: effect.filter });
      break;
    }

    case 'lockSelfFromPlaying': {
      state.players[controller].lockedFromPlaying = true;
      events.push({ type: 'PLAYER_LOCKED_FROM_PLAYING', player: controller });
      break;
    }

    case 'lockOpponentFromPlaying': {
      state.turnFlags.opponentLocked = true;
      events.push({ type: 'OPPONENT_LOCKED_FROM_PLAYING' });
      break;
    }

    case 'allowSelfPointResponseToActions': {
      state.players[controller].pointResponseToActions = true;
      events.push({ type: 'POINT_RESPONSE_UNLOCKED', player: controller });
      break;
    }

    case 'lockOpponentActionResponse': {
      state.turnFlags.opponentActionResponseLocked = true;
      events.push({ type: 'OPPONENT_ACTION_RESPONSE_LOCKED' });
      break;
    }

    case 'allowPlayFromTrash': {
      state.turnFlags.playFromTrash = true;
      events.push({ type: 'PLAY_FROM_TRASH_UNLOCKED', player: controller });
      break;
    }

    case 'redirectTrashToDeckBottom': {
      state.turnFlags.redirectTrashToDeckBottom = true;
      events.push({ type: 'TRASH_REDIRECT_ACTIVE' });
      break;
    }

    case 'modifyAllPlayCosts': {
      state.turnFlags.allCardsCostLess += effect.amount;
      events.push({ type: 'COST_MODIFIER_ACTIVE', delta: effect.amount, player: controller });
      break;
    }

    case 'registerTrigger': {
      // Share the Loot (75): on opponent card takes effect, gain energy
      state.pendingTriggers.push({
        type: 'registerTurnTrigger',
        on: effect.on,
        duration: effect.duration,
        effect: effect.effect,
        owner: controller,
      });
      events.push({ type: 'TRIGGER_REGISTERED', on: effect.on });
      break;
    }

    case 'optional': {
      // Prompt player — server suspends and waits for choice
      state.pendingTriggers.push({ type: 'optionalEffectChoice', player: controller, effects: effect.effects });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'optional' });
      break;
    }

    case 'conditional':
    case 'conditionalGainPoints': {
      // Chant (34) — check condition, grant additional point
      if (effect.condition) {
        const met = evaluateResolutionCondition(state, effect.condition);
        if (met) {
          grantPoints(state, controller, effect.amount ?? 1, events);
        }
      }
      break;
    }

    // Complex effects that need player interaction — all queued as pending choices
    case 'revealUntilType':
    case 'chooseCardType':
    case 'chooseNumber':
    case 'controllerMovesCardFromStack':
    case 'opponentChoosesOne':
    case 'lookAtTopN':
    case 'trashFromRevealed':
    case 'conditionalPlay':
    case 'trashUnlessControllerPays':
    case 'chooseCardToTrashFromRevealedHand':
    case 'trashFromRevealedHand':
    case 'trashFromHandChoice':
    case 'mayPlayFromHand':
    case 'mayPlayTopOfDeck':
    case 'moveFromStackToDeckTop':
    case 'putHandCardOnDeckTop': {
      state.pendingTriggers.push({ type: effect.type, player: controller, ...effect });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: effect.type });
      break;
    }

    default:
      events.push({ type: 'UNHANDLED_EFFECT', effectType: effect.type });
  }

  return events;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function grantPoints(state, playerId, amount, events) {
  state.players[playerId].points += amount;
  events.push({ type: 'POINTS_GAINED', player: playerId, amount, total: state.players[playerId].points });
  if (state.players[playerId].points >= 5) {
    state.winner = playerId;
    state.phase = 'ended';
    events.push({ type: 'GAME_OVER', winner: playerId, reason: 'points' });
  }
}

function resolvePlayers(spec, controller, opp) {
  if (spec === 'self') return controller;
  if (spec === 'opponent') return opp;
  if (spec === 'both') return 'both';
  return controller;
}

function resolveAmount(state, amount, ctx) {
  if (typeof amount === 'number') return amount;
  if (amount === 'cardsJustTrashed') return ctx.cardsJustTrashed ?? 0;
  if (amount === 'highestCostOnStack') {
    if (state.zones.stack.length === 0) return 0;
    return Math.max(...state.zones.stack.map(e => getCard(e.cardId).energyCost));
  }
  if (amount === 'distinctEnergyCostsInTrash') {
    return new Set(state.zones.trash.map(id => getCard(id).energyCost)).size;
  }
  if (typeof amount === 'string' && amount.startsWith('countInTrash:')) {
    const filter = amount.split(':')[1];
    return filter === 'any'
      ? state.zones.trash.length
      : state.zones.trash.filter(id => getCard(id).type === filter).length;
  }
  if (typeof amount === 'string' && amount.startsWith('countOnStack:')) {
    return state.zones.stack.length;
  }
  return 0;
}

function evaluateResolutionCondition(state, condition) {
  if (condition.type === 'countInTrash') {
    const count = state.zones.trash.filter(id => {
      const c = getCard(id);
      return condition.filter === 'any' || c.type === condition.filter;
    }).length;
    return count >= (condition.minimum ?? 0);
  }
  return false;
}


