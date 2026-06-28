import { getCard } from '../data/cardDb.js';
import {
  computeActualCost, isStackLocked, canPlayFromTrash,
  opponentPointResponseAllowed, opponent, controllerOf,
} from './state.js';

/**
 * Returns null if the play is legal, or an error string if not.
 * context = { fromTrash?: bool, respondingToStackIndex?: number }
 */
export function validatePlay(state, playerId, cardId, context = {}) {
  const card = getCard(cardId);
  const player = state.players[playerId];
  const isOwnTurn = state.turn === playerId;
  const stackEmpty = state.zones.stack.length === 0;

  // ── Source zone check ────────────────────────────────────────────────────
  const inHand = player.hand.includes(cardId);
  const inTrash = state.zones.trash.includes(cardId);

  if (context.fromTrash) {
    if (!inTrash) return 'Card is not in the trash.';
    if (!canPlayFromTrash(state, playerId)) return 'You cannot play cards from the trash right now.';
  } else {
    if (!inHand) return 'Card is not in your hand.';
  }

  // ── Global lock (Unstoppable 00, Erase Reason 11) ────────────────────────
  if (isStackLocked(state, playerId)) return 'Cards cannot be played while this card is on the stack.';
  if (player.lockedFromPlaying) return 'You cannot play any more cards this turn.';

  // ── Opponent lock (Stifle Speech 52) ─────────────────────────────────────
  // Only the specific player the caster locked is blocked — not both players.
  if (state.turnFlags.lockedPlayer === playerId) {
    return 'You cannot play any more cards this turn.';
  }

  // ── Turn / stack timing rules ─────────────────────────────────────────────
  if (card.type === 'point') {
    // Check if card has responseOnly restriction first — if so, skip the proactive stack-empty check
    const isResponseOnly = card.playRestrictions?.some(r => r.type === 'responseOnly');

    if (!isResponseOnly) {
      // Point cards need empty stack to play proactively on own turn
      if (isOwnTurn && !stackEmpty) {
        const canRespond = checkPointResponsePermission(state, playerId, context);
        if (!canRespond) return 'Point cards can only be played when the stack is empty.';
      }
      // Opponent playing a point card — only allowed via With the Sky / Blinding Flash
      if (!isOwnTurn) {
        const canRespond = checkPointResponsePermission(state, playerId, context);
        if (!canRespond) return 'You cannot play a point card in response on your opponent\'s turn.';
      }
    }
    // responseOnly cards are handled purely by the playRestrictions loop below
  }

  if (card.type === 'action') {
    // Actions: own turn (stack empty) OR response to an opponent's card.
    // The empty-stack + opponent's-turn case is the opponent's end-of-turn
    // window — you can't sneak an action in there.
    if (!isOwnTurn && stackEmpty) {
      return 'You can only play action cards on your turn or in response to an opponent\'s card.';
    }
    // You can't respond to your own card — let it resolve first. Responses are
    // only legal against a card the opponent controls on top of the stack. This
    // also constrains granted play-from-trash (Consult the Past 38, Brought
    // Back 72): the grant lets you play from the trash, but timing still applies
    // — you may only do so proactively or in response to the opponent's card.
    if (!stackEmpty && controllerOf(state.zones.stack[0]) === playerId) {
      return 'You cannot respond to your own card; let it resolve first.';
    }
    // Injustice (67) — can't play an action in response to a protected action.
    const top = state.zones.stack[0];
    if (top?.responsesLocked && controllerOf(top) !== playerId) {
      return 'That action card is protected from action responses.';
    }
  }

  // ── Per-card play restrictions ────────────────────────────────────────────
  for (const restriction of card.playRestrictions ?? []) {
    switch (restriction.type) {
      case 'responseOnly': {
        // Must be played in response to the specified type
        if (stackEmpty) return `${card.name} can only be played in response.`;
        if (restriction.filter !== 'any') {
          const topCard = getCard(state.zones.stack[0].cardId);
          if (topCard.type !== restriction.filter) {
            return `${card.name} can only be played in response to ${restriction.filter} cards.`;
          }
        }
        break;
      }
      case 'mustBeFirstCardThisTurn':
        if (state.cardsPlayedThisTurn.length > 0) {
          return `${card.name} must be the first card you play this turn.`;
        }
        break;
      case 'exactEnergy':
        if (player.energy !== restriction.amount) {
          return `${card.name} requires exactly ${restriction.amount} energy.`;
        }
        break;
    }
  }

  // ── Energy check ──────────────────────────────────────────────────────────
  const cost = computeActualCost(state, cardId, playerId, context);
  if (player.energy < cost) {
    return `Not enough energy. Need ${cost}, have ${player.energy}.`;
  }

  // ── Additional costs must be payable (Sneak 08, Vitalize 25) ──────────────
  // Treated like energy: if you can't pay, you can't put the card on the stack.
  const handCosts = (card.additionalCosts ?? []).filter(
    c => c.type === 'trashFromHand' || c.type === 'putHandCardOnDeckTop'
  );
  if (handCosts.length) {
    const needed = handCosts.reduce((n, c) => n + (c.count ?? 1), 0);
    // The card being played leaves the hand, so it can't pay its own cost.
    const available = player.hand.length - (context.fromTrash ? 0 : 1);
    if (available < needed) {
      return `${card.name} needs ${needed} more card${needed !== 1 ? 's' : ''} in hand to pay its additional cost.`;
    }
  }

  return null; // legal
}

function checkPointResponsePermission(state, playerId, context) {
  // With the Sky (28) on stack — opponent may play point cards
  if (opponentPointResponseAllowed(state)) return true;

  // Blinding Flash (51) active for this player — may play point vs actions
  if (state.players[playerId].pointResponseToActions) {
    // Check the top of stack is an action card
    if (state.zones.stack.length > 0) {
      const topCard = getCard(state.zones.stack[0].cardId);
      if (topCard.type === 'action') return true;
    }
  }

  // Forever Borrow (36) — only in response to point cards (handled by responseOnly restriction)
  return false;
}
