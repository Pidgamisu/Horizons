import { getCard } from '../data/cardDb.js';
import {
  drawCards, trashCardFromHand, trashHand, trashFromStack,
  sendToTrash, removeFromStack, shuffle, opponent, controllerOf,
  stackHasTarget,
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

  // One ctx shared across all of a card's effects, so an earlier effect can
  // pass data to a later one (e.g. revealTopN → opponentChoosesOne).
  const ctx = {};
  for (const effect of card.effects ?? []) {
    const newEvents = executeEffect(state, effect, controller, entry, ctx);
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
        // Clamp to what the player actually holds — "trash N" with fewer than N
        // trashes all of them; with an empty hand it does nothing (no lock).
        const effective = Math.min(count, state.players[p].hand.length);
        if (effective === 0) continue;
        state.pendingTriggers.push({ type: 'trashFromHandChoice', player: p, count: effective, optional: false });
        events.push({ type: 'CHOICE_REQUIRED', player: p, choiceType: 'trashFromHand', count: effective });
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
      // No legal target on the (remaining) stack → skip instead of prompting an
      // impossible choice that would hardlock the game.
      if (!stackHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'trashFromStack', filter: effect.filter });
        break;
      }
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
      const target = effect.target === 'both' ? 'both'
        : effect.target === 'self' ? controller
        : opp; // 'opponent' / 'chosenPlayer' → the opponent (2-player)
      events.push({ type: 'HAND_REVEALED', target, cards: target === 'both'
        ? { [controller]: state.players[controller].hand, [opp]: state.players[opp].hand }
        : state.players[target].hand
      });
      break;
    }

    case 'putFromTrashToHand': {
      // Clamp to what's in the trash; skip if there's nothing to take.
      const effective = Math.min(effect.count ?? 1, state.zones.trash.length);
      if (effective === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'putFromTrashToHand' });
        break;
      }
      state.pendingTriggers.push({ type: 'putFromTrashToHandChoice', player: controller, count: effective });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'putFromTrashToHand', count: effective });
      break;
    }

    case 'returnToControllerHand': {
      if (!stackHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'returnToControllerHand', filter: effect.filter });
        break;
      }
      state.pendingTriggers.push({ type: 'returnStackCardToHandChoice', player: controller, filter: effect.filter });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'returnToControllerHand', filter: effect.filter });
      break;
    }

    case 'moveFromStackToHand': {
      // Steal Intensity (86) — puts a point card on stack into your own hand
      if (!stackHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'moveFromStackToHand', filter: effect.filter });
        break;
      }
      state.pendingTriggers.push({ type: 'stealFromStackChoice', player: controller, filter: effect.filter });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'stealFromStack', filter: effect.filter });
      break;
    }

    case 'moveFromStackToDeckTop': {
      // Regret (41) — controller picks a card on the stack to put on top of the deck
      if (!stackHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'moveFromStackToDeckTop', filter: effect.filter });
        break;
      }
      state.pendingTriggers.push({ type: 'moveFromStackToDeckTop', player: controller, filter: effect.filter });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'moveFromStackToDeckTop', filter: effect.filter });
      break;
    }

    case 'chooseCardToTrashFromRevealedHand': {
      // Inquisition (16), Cerebral Snuff (81): reveal the opponent's hand, then
      // the caster picks a card from it (filtered) to trash.
      const target = opp;
      const filter = effect.filter ?? 'any';
      const candidates = state.players[target].hand.filter(
        id => filter === 'any' || getCard(id).type === filter
      );
      if (candidates.length === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'chooseCardToTrashFromRevealedHand', filter });
        break;
      }
      state.pendingTriggers.push({
        type: 'chooseCardToTrashFromRevealedHand',
        player: controller,
        targetPlayer: target,
        filter,
        revealedHand: [...state.players[target].hand],
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'chooseCardToTrashFromRevealedHand', filter });
      break;
    }

    case 'controllerMovesCardFromStack': {
      // Journey (57): caster picks an action on the stack; step 2 lets THAT
      // card's controller choose to put it on the top or bottom of the deck.
      if (!stackHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'controllerMovesCardFromStack', filter: effect.filter });
        break;
      }
      state.pendingTriggers.push({
        type: 'controllerMovesCardFromStackTarget',
        player: controller,
        filter: effect.filter,
        destinations: effect.destinations ?? ['deckTop', 'deckBottom'],
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'controllerMovesCardFromStackTarget', filter: effect.filter });
      break;
    }

    case 'lookAtTopN': {
      // Search (47): show the caster the top N cards so they can pick one to
      // trash. The deck is hidden, so the revealed ids must travel with the choice.
      const n = effect.count ?? 1;
      const revealed = state.zones.deck.slice(0, n);
      if (revealed.length === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'lookAtTopN' });
        break;
      }
      state.pendingTriggers.push({ type: 'lookAtTopN', player: controller, count: n, revealed });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'lookAtTopN' });
      break;
    }

    case 'revealTopN': {
      // Kinship (46): pull the top N cards off the deck and hold them for the
      // following effect (opponentChoosesOne) via the shared ctx.
      const n = effect.count ?? 1;
      const revealed = state.zones.deck.splice(0, n);
      ctx.revealedCards = revealed;
      events.push({ type: 'CARDS_REVEALED', cards: revealed });
      break;
    }

    case 'opponentChoosesOne': {
      // Kinship (46): the opponent picks one of the revealed cards for their
      // hand; the rest go to the caster's hand.
      const revealed = ctx.revealedCards ?? [];
      if (revealed.length === 0) { break; }
      state.pendingTriggers.push({
        type: 'opponentChoosesOne',
        player: opp,                 // the opponent chooses
        revealedCards: revealed,
        originalPlayer: controller,  // caster gets the rest
        putChosen: effect.putChosen,
        putRest: effect.putRest,
      });
      events.push({ type: 'CHOICE_REQUIRED', player: opp, choiceType: 'opponentChoosesOne' });
      break;
    }

    case 'trashUnlessControllerPays': {
      // Drown in Fog (59), Chains (74), Poke (87), Overconfidence (71).
      // Step 1: the caster picks which stack card to target. Step 2 (set up when
      // this resolves) lets THAT card's controller pay the ransom or lose it.
      if (!stackHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'trashUnlessControllerPays', filter: effect.filter });
        break;
      }
      state.pendingTriggers.push({
        type: 'trashUnlessControllerPaysTarget',
        player: controller,
        filter: effect.filter,
        ransom: effect.ransom,
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'trashUnlessControllerPaysTarget', filter: effect.filter });
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
      if (!stackHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'gainControl', filter: effect.filter });
        break;
      }
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
      // Injustice (67): protect only the controller's NEXT action this turn.
      state.turnFlags.protectNextSelfAction = controller;
      events.push({ type: 'OPPONENT_ACTION_RESPONSE_LOCKED', player: controller });
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
    case 'chooseNumber':
    case 'trashFromHandChoice':
    case 'mayPlayFromHand':
    case 'mayPlayTopOfDeck':
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


