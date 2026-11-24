import { getCard } from '../data/cardDb.js';
import {
  computeActualCost, isHorizonLocked, canPlayFromDusk, controllerOf,
} from './state.js';

/**
 * Returns null if the play is legal, or an error string if not.
 * context = { fromDusk?: bool, respondingToHorizonIndex?: number }
 */
export function validatePlay(state, playerId, cardId, context = {}) {
  const card = getCard(cardId);
  const player = state.players[playerId];
  const isOwnTurn = state.turn === playerId;
  const horizonEmpty = state.zones.horizon.length === 0;

  // ── Source zone check ────────────────────────────────────────────────────
  const inHand = player.hand.includes(cardId);
  const inTrash = state.zones.dusk.includes(cardId);

  if (context.fromDusk) {
    if (!inTrash) return 'Card is not in the trash.';
    if (!canPlayFromDusk(state, playerId)) return 'You cannot play cards from the trash right now.';
  } else {
    if (!inHand) return 'Card is not in your hand.';
  }

  // ── Global lock (Unstoppable 00, Erase Reason 11) ────────────────────────
  if (isHorizonLocked(state, playerId, card.type)) {
    return 'Cards cannot be played while this card is on the horizon.';
  }
  if (player.lockedFromPlaying) return 'You cannot play any more cards this turn.';

  // ── Opponent lock (Stifle Speech 52) ─────────────────────────────────────
  // Only the specific player the caster locked is blocked — not both players.
  if (state.turnFlags.lockedPlayer === playerId) {
    return 'You cannot play any more cards this turn.';
  }

  // ── Turn / horizon timing rules ─────────────────────────────────────────────
  if (card.type === 'point') {
    // Rulebook p3: "You can only play points during your turn while the horizon
    // is empty." Nothing in the v4 set grants an exception — every card that
    // used to (Strafe, Forever Borrow, Birth the Sky, the old Blinding Flash)
    // is gone, so this is now unconditional.
    if (!isOwnTurn) return 'You can only play points on your own turn.';
    if (!horizonEmpty) return 'Point cards can only be played when the horizon is empty.';
  }

  if (card.type === 'action') {
    // Actions: own turn (horizon empty) OR response to an opponent's card.
    // The empty-horizon + opponent's-turn case is the opponent's end-of-turn
    // window — you can't sneak an action in there.
    if (!isOwnTurn && horizonEmpty) {
      return 'You can only play action cards on your turn or in response to an opponent\'s card.';
    }
    // You can't respond to your own card — let it resolve first. Responses are
    // only legal against a card the opponent controls on top of the horizon. This
    // also constrains granted play-from-trash (Consult the Past 38, Brought
    // Back 72): the grant lets you play from the trash, but timing still applies
    // — you may only do so proactively or in response to the opponent's card.
    if (!horizonEmpty && controllerOf(state.zones.horizon[0]) === playerId) {
      return 'You cannot respond to your own card; let it resolve first.';
    }
    // Avert Injustice (68) — can't respond to a protected action.
    const top = state.zones.horizon[0];
    if (top?.responsesLocked && controllerOf(top) !== playerId) {
      return 'That action card is protected from responses.';
    }
    // Blinding Flash (53) — for the rest of the turn nobody may respond to any
    // card its caster controls. Unlike Avert Injustice this is not pinned to one
    // entry, so it is read off the turn flags rather than the horizon.
    const shielded = state.turnFlags.responsesLockedAgainst;
    if (top && shielded && controllerOf(top) === shielded && playerId !== shielded) {
      return 'You cannot respond to your opponent\'s cards this turn.';
    }
  }

  // ── Per-card play restrictions ────────────────────────────────────────────
  for (const restriction of card.playRestrictions ?? []) {
    switch (restriction.type) {
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
  // Treated like energy: if you can't pay, you can't put the card on the horizon.
  const handCosts = (card.additionalCosts ?? []).filter(
    c => c.type === 'duskFromHand' || c.type === 'putHandCardOnDeckTop'
  );
  if (handCosts.length) {
    const needed = handCosts.reduce((n, c) => n + (c.count ?? 1), 0);
    // The card being played leaves the hand, so it can't pay its own cost.
    const available = player.hand.length - (context.fromDusk ? 0 : 1);
    if (available < needed) {
      return `${card.name} needs ${needed} more card${needed !== 1 ? 's' : ''} in hand to pay its additional cost.`;
    }
  }

  // Costs paid out of the dusk (Abyss 048) gate the play the same way.
  const duskCosts = (card.additionalCosts ?? []).filter(c => c.type === "putFromDuskToDeckBottom");
  if (duskCosts.length) {
    const needed = duskCosts.reduce((n, c) => n + (c.count ?? 1), 0);
    if (state.zones.dusk.length < needed) {
      return `${card.name} needs ${needed} cards in the dusk to pay its additional cost.`;
    }
  }

  return null; // legal
}
