import { getCard } from '../data/cardDb.js';
import {
  drawCards, trashCardFromHand, sendToTrash, trashFromStack,
  removeFromStack, opponent, controllerOf, stackEntryMatchesFilter,
} from '../engine/state.js';

/**
 * Process a player's response to a CHOICE_REQUIRED prompt.
 * Returns { events, error } — error is null if valid.
 *
 * state.pendingChoice holds the current suspended choice (set by the server layer).
 * payload = the player's response data (varies by choice type).
 */
export function resolveChoice(state, playerId, payload) {
  const choice = state.pendingChoice;
  if (!choice) return { events: [], error: 'No pending choice.' };
  if (choice.player !== playerId) return { events: [], error: 'Not your choice to make.' };

  const events = [];
  let error = null;

  switch (choice.type) {

    case 'trashFromHand': {
      // payload: { cardIds: string[] }
      const { cardIds } = payload;
      if (!Array.isArray(cardIds) || cardIds.length !== choice.count) {
        error = `Must choose exactly ${choice.count} card(s) to trash.`; break;
      }
      for (const id of cardIds) {
        if (!state.players[playerId].hand.includes(id)) {
          error = `Card ${id} is not in your hand.`; break;
        }
      }
      if (error) break;
      for (const id of cardIds) {
        trashCardFromHand(state, playerId, id);
        events.push({ type: 'CARD_TRASHED_FROM_HAND', player: playerId, cardId: id });
      }
      break;
    }

    case 'trashFromStack': {
      // payload: { stackIndex: number }
      const { stackIndex } = payload;
      const entry = state.zones.stack[stackIndex];
      if (!entry) { error = 'Invalid stack index.'; break; }
      if (!stackEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      const trashed = trashFromStack(state, stackIndex);
      events.push({ type: 'CARD_TRASHED_FROM_STACK', cardId: trashed.cardId });

      // Execute thenGrant if present (Metamorphosis 61, Reinstate 84, etc.)
      if (choice.thenGrant) {
        const grantEvents = executeThenGrant(state, choice.thenGrant, controllerOf(trashed), choice.originalController);
        events.push(...grantEvents);
      }
      break;
    }

    case 'trashAllFromStack': {
      // No player input needed — auto-resolve
      const trashed = [];
      while (state.zones.stack.length > 0) {
        const e = state.zones.stack.shift();
        sendToTrash(state, e.cardId);
        trashed.push(e.cardId);
      }
      events.push({ type: 'STACK_CLEARED', cards: trashed, count: trashed.length });
      break;
    }

    case 'returnToControllerHand': {
      // payload: { stackIndex: number }
      const { stackIndex } = payload;
      const entry = state.zones.stack[stackIndex];
      if (!entry) { error = 'Invalid stack index.'; break; }
      if (!stackEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      const removed = removeFromStack(state, stackIndex);
      const returnTo = controllerOf(removed);
      state.players[returnTo].hand.push(removed.cardId);
      events.push({ type: 'CARD_RETURNED_TO_HAND', cardId: removed.cardId, player: returnTo });
      break;
    }

    case 'stealFromStack': {
      // payload: { stackIndex: number }  — Steal Intensity (86)
      const { stackIndex } = payload;
      const entry = state.zones.stack[stackIndex];
      if (!entry) { error = 'Invalid stack index.'; break; }
      if (!stackEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      const removed = removeFromStack(state, stackIndex);
      state.players[playerId].hand.push(removed.cardId);
      events.push({ type: 'CARD_STOLEN_TO_HAND', cardId: removed.cardId, player: playerId });
      break;
    }

    case 'putFromTrashToHand': {
      // payload: { cardIds: string[] }
      const { cardIds } = payload;
      if (!Array.isArray(cardIds) || cardIds.length !== choice.count) {
        error = `Must choose exactly ${choice.count} card(s).`; break;
      }
      for (const id of cardIds) {
        if (!state.zones.trash.includes(id)) { error = `Card ${id} is not in the trash.`; break; }
      }
      if (error) break;
      for (const id of cardIds) {
        state.zones.trash.splice(state.zones.trash.indexOf(id), 1);
        state.players[playerId].hand.push(id);
        events.push({ type: 'CARD_FROM_TRASH_TO_HAND', cardId: id, player: playerId });
      }
      break;
    }

    case 'putHandCardOnDeckTop': {
      // payload: { cardId: string }
      const { cardId } = payload;
      if (!state.players[playerId].hand.includes(cardId)) {
        error = 'Card is not in your hand.'; break;
      }
      state.players[playerId].hand.splice(state.players[playerId].hand.indexOf(cardId), 1);
      state.zones.deck.unshift(cardId);
      events.push({ type: 'CARD_TO_DECK_TOP', cardId, player: playerId });
      break;
    }

    case 'gainControl': {
      // payload: { stackIndex: number }  — Change of Luck (58), Reverse (42)
      const { stackIndex } = payload;
      const entry = state.zones.stack[stackIndex];
      if (!entry) { error = 'Invalid stack index.'; break; }
      if (!stackEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      entry.controlledBy = playerId;
      events.push({ type: 'CONTROL_GAINED', cardId: entry.cardId, newController: playerId });

      // Reverse (42): when it takes effect, return to initial controller's hand
      if (choice.onResolve?.type === 'returnToInitialControllerHand') {
        events.push({ type: 'ON_RESOLVE_PENDING', effect: choice.onResolve, cardId: entry.cardId });
      }
      break;
    }

    case 'trashUnlessControllerPays': {
      // payload: { pay: boolean, stackIndex: number }
      // The controller of the targeted card chooses to pay or let it be trashed
      const { pay, stackIndex } = payload;
      const entry = state.zones.stack[stackIndex];
      if (!entry) { error = 'Invalid stack index.'; break; }
      const entryController = controllerOf(entry);
      if (playerId !== entryController) { error = 'Only the card\'s controller can respond to this.'; break; }

      if (!pay) {
        const trashed = trashFromStack(state, stackIndex);
        events.push({ type: 'CARD_TRASHED_FROM_STACK', cardId: trashed.cardId, reason: 'ransom_declined' });
      } else {
        // Validate they can afford it
        const ransom = choice.ransom;
        const cost = resolveRansomCost(state, ransom);
        if (state.players[playerId].energy < cost) {
          error = `Not enough energy to pay ransom. Need ${cost}, have ${state.players[playerId].energy}.`; break;
        }
        state.players[playerId].energy -= cost;
        events.push({ type: 'RANSOM_PAID', player: playerId, amount: cost });
      }
      break;
    }

    case 'optional': {
      // payload: { accept: boolean }
      if (payload.accept) {
        // Queue the sub-effects as the next choices
        events.push({ type: 'OPTIONAL_ACCEPTED', pendingEffects: choice.effects });
      } else {
        events.push({ type: 'OPTIONAL_DECLINED' });
      }
      break;
    }

    case 'revealUntilType': {
      // payload: { cardType: 'point' | 'action' }  — Inspiration (35), Inspect (64)
      const { cardType } = payload;
      if (!['point', 'action'].includes(cardType)) { error = 'Must choose point or action.'; break; }

      const revealed = [];
      let found = null;
      while (state.zones.deck.length > 0) {
        const id = state.zones.deck.shift();
        const c = getCard(id);
        if (!found && c.type === cardType) {
          found = id;
        } else {
          revealed.push(id);
        }
        if (found) break;
      }

      events.push({ type: 'CARDS_REVEALED', cards: [...revealed, ...(found ? [found] : [])] });

      if (found) {
        state.players[playerId].hand.push(found);
        events.push({ type: 'CARD_TO_HAND', cardId: found, player: playerId });
      }

      // Destination for the rest
      if (choice.putRest === 'opponentHand') {
        const opp = opponent(playerId);
        for (const id of revealed) {
          state.players[opp].hand.push(id);
        }
        events.push({ type: 'CARDS_TO_OPPONENT_HAND', cards: revealed, player: opp });
      } else if (choice.putRest === 'deckBottom') {
        state.zones.deck.push(...revealed);
        events.push({ type: 'CARDS_TO_DECK_BOTTOM', cards: revealed });
      }
      break;
    }

    case 'lookAtTopN': {
      // payload: { trashCardId: string }  — Search (47): look at top 2, trash one
      const { trashCardId } = payload;
      const top = state.zones.deck.slice(0, choice.count);
      if (!top.includes(trashCardId)) { error = 'Must choose one of the revealed cards.'; break; }

      // Remove trashed card from deck top
      const idx = state.zones.deck.indexOf(trashCardId);
      state.zones.deck.splice(idx, 1);
      sendToTrash(state, trashCardId);
      events.push({ type: 'DECK_TOP_TRASHED', cardId: trashCardId });

      // Draw a card (Search's second effect)
      const drawn = drawCards(state, playerId, 1);
      events.push({ type: 'CARDS_DRAWN', player: playerId, cards: drawn });
      break;
    }

    case 'opponentChoosesOne': {
      // payload: { cardId: string }  — Kinship (46): opponent picks one card
      const { cardId } = payload;
      // The revealed cards are in choice.revealedCards
      if (!choice.revealedCards?.includes(cardId)) {
        error = 'Must choose from the revealed cards.'; break;
      }
      const opp = opponent(playerId); // playerId here is the opponent making the choice
      state.players[opp].hand.push(cardId);
      events.push({ type: 'CARD_TO_HAND', cardId, player: opp });

      const rest = choice.revealedCards.filter(id => id !== cardId);
      const originalPlayer = choice.originalPlayer;
      for (const id of rest) {
        state.players[originalPlayer].hand.push(id);
      }
      events.push({ type: 'CARDS_TO_HAND', cards: rest, player: originalPlayer });
      break;
    }

    case 'controllerMovesCardFromStack': {
      // payload: { stackIndex: number, destination: 'deckTop' | 'deckBottom' }  — Journey (57)
      const { stackIndex, destination } = payload;
      if (!['deckTop', 'deckBottom'].includes(destination)) {
        error = 'Must choose deckTop or deckBottom.'; break;
      }
      const entry = state.zones.stack[stackIndex];
      if (!entry) { error = 'Invalid stack index.'; break; }
      if (getCard(entry.cardId).type !== 'action') { error = 'Must choose an action card.'; break; }
      if (controllerOf(entry) !== playerId) { error = 'You can only move cards you control.'; break; }

      const removed = removeFromStack(state, stackIndex);
      if (destination === 'deckTop') {
        state.zones.deck.unshift(removed.cardId);
      } else {
        state.zones.deck.push(removed.cardId);
      }
      events.push({ type: 'CARD_TO_DECK', cardId: removed.cardId, destination });
      break;
    }

    case 'chooseNumber': {
      // payload: { number: number }  — Predict (54)
      const { number } = payload;
      if (typeof number !== 'number' || number < 0) { error = 'Must choose a non-negative number.'; break; }
      // Reveal top card and check
      if (state.zones.deck.length === 0) { events.push({ type: 'DECK_EMPTY' }); break; }
      const topId = state.zones.deck[0];
      const topCard = getCard(topId);
      events.push({ type: 'CARD_REVEALED', cardId: topId });
      if (topCard.energyCost === number) {
        // Player may play it for 0
        events.push({ type: 'FREE_PLAY_OFFERED', cardId: topId, player: playerId });
        // Remove from top of deck — waiting for player to decide to play or not
        state.pendingChoice = {
          type: 'confirmFreePlay',
          player: playerId,
          cardId: topId,
        };
        state.zones.deck.shift();
        return { events, error: null }; // stay suspended
      }
      break;
    }

    case 'confirmFreePlay': {
      // payload: { play: boolean }  — Predict (54) follow-up
      if (payload.play) {
        const { cardId } = choice;
        // Play the card for 0 energy — put it on stack
        state.players[playerId].hand.push(cardId); // temp add to hand
        events.push({ type: 'FREE_PLAY_CONFIRMED', cardId, player: playerId });
        // Caller (server) will handle the actual playCard call
      } else {
        state.zones.deck.unshift(choice.cardId); // return to top of deck
        events.push({ type: 'FREE_PLAY_DECLINED', cardId: choice.cardId });
      }
      break;
    }

    case 'chooseCardToTrashFromRevealedHand': {
      // payload: { cardId: string, targetPlayer: string }  — Cerebral Snuff (81)
      const { cardId, targetPlayer } = payload;
      if (!state.players[targetPlayer].hand.includes(cardId)) {
        error = 'Card not in that player\'s hand.'; break;
      }
      trashCardFromHand(state, targetPlayer, cardId);
      events.push({ type: 'CARD_TRASHED_FROM_HAND', player: targetPlayer, cardId });
      break;
    }

    case 'additionalCost': {
      // Dispatch to specific additional cost type
      const { cost } = choice;
      switch (cost.type) {
        case 'trashFromHand': {
          const { cardIds } = payload;
          if (!cardIds?.length) { error = 'Must trash a card.'; break; }
          for (const id of cardIds) {
            if (!state.players[playerId].hand.includes(id)) {
              error = `Card ${id} not in hand.`; break;
            }
          }
          if (error) break;
          for (const id of cardIds) {
            trashCardFromHand(state, playerId, id);
            events.push({ type: 'CARD_TRASHED_FROM_HAND', player: playerId, cardId: id });
          }
          break;
        }
        case 'putHandCardOnDeckTop': {
          const { cardId } = payload;
          if (!state.players[playerId].hand.includes(cardId)) {
            error = 'Card not in hand.'; break;
          }
          state.players[playerId].hand.splice(state.players[playerId].hand.indexOf(cardId), 1);
          state.zones.deck.unshift(cardId);
          events.push({ type: 'CARD_TO_DECK_TOP', cardId, player: playerId });
          break;
        }
        default:
          error = `Unhandled additional cost type: ${cost.type}`;
      }
      break;
    }

    default:
      error = `Unknown choice type: ${choice.type}`;
  }

  if (!error) {
    state.pendingChoice = null;
  }

  return { events, error };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveRansomCost(state, ransom) {
  if (typeof ransom.amount === 'number') return ransom.amount;
  if (ransom.amount === 'countInTrash:any') return state.zones.trash.length;
  if (ransom.amount === 'countOnStack:any') return state.zones.stack.length;
  return 0;
}

function executeThenGrant(state, grant, grantTarget, originalController) {
  const events = [];
  const player = grant.player === 'trashedCardController' ? grantTarget
    : grant.player === 'self' ? originalController
    : grantTarget;

  switch (grant.type) {
    case 'gainEnergy':
      state.players[player].energy += grant.amount;
      events.push({ type: 'ENERGY_GAINED', player, amount: grant.amount });
      break;
    case 'mayPlayFromHand':
      state.pendingChoice = {
        type: 'mayPlayFromHand',
        player,
        filter: grant.filter,
        cost: grant.cost,
      };
      events.push({ type: 'CHOICE_REQUIRED', player, choiceType: 'mayPlayFromHand', filter: grant.filter, cost: grant.cost });
      break;
    case 'mayPlayTopOfDeck':
      state.pendingChoice = {
        type: 'mayPlayTopOfDeck',
        player,
        cost: grant.cost,
      };
      events.push({ type: 'CHOICE_REQUIRED', player, choiceType: 'mayPlayTopOfDeck', cost: grant.cost });
      break;
    case 'draw':
      const drawn = drawCards(state, player, grant.count);
      events.push({ type: 'CARDS_DRAWN', player, cards: drawn });
      break;
  }
  return events;
}
