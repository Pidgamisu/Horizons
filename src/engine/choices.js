import { getCard } from '../data/cardDb.js';
import {
  drawCards, duskCardFromHand, sendToDusk, duskFromHorizon,
  removeFromHorizon, opponent, controllerOf, horizonEntryMatchesFilter,
} from '../engine/state.js';
import { executeEffectList, flushHorizonTriggers } from '../effects/executor.js';

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

    case 'duskFromHand': {
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
        duskCardFromHand(state, playerId, id);
        events.push({ type: 'CARD_TO_DUSK_FROM_HAND', player: playerId, cardId: id });
      }
      break;
    }

    case 'duskAnyNumberFromHand': {
      // Reset Memory (88): payload cardIds is any subset of the hand (possibly
      // empty). Trash them, then draw that many plus the bonus (choice.drawPlus).
      const { cardIds } = payload;
      if (!Array.isArray(cardIds)) { error = 'Invalid selection.'; break; }
      const unique = [...new Set(cardIds)];
      for (const id of unique) {
        if (!state.players[playerId].hand.includes(id)) {
          error = `Card ${id} is not in your hand.`; break;
        }
      }
      if (error) break;
      for (const id of unique) {
        duskCardFromHand(state, playerId, id);
        events.push({ type: 'CARD_TO_DUSK_FROM_HAND', player: playerId, cardId: id });
      }
      const drawCount = unique.length + (choice.drawPlus ?? 0);
      if (drawCount > 0) {
        const drawn = drawCards(state, playerId, drawCount);
        events.push({ type: 'CARDS_DRAWN', player: playerId, cards: drawn });
      }
      break;
    }

    case 'duskFromHorizon': {
      // payload: { horizonIndex: number }
      const { horizonIndex } = payload;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      if (!horizonEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      const trashed = duskFromHorizon(state, horizonIndex);
      events.push({ type: 'CARD_TO_DUSK_FROM_HORIZON', cardId: trashed.cardId });

      // Execute thenGrant if present (Metamorphosis 61, Reinstate 84, etc.)
      if (choice.thenGrant) {
        // Clear the current (just-resolved) choice first so we can detect a NEW
        // one that thenGrant may set (may-play-for-0) and keep it.
        state.pendingChoice = null;
        const grantEvents = executeThenGrant(state, choice.thenGrant, controllerOf(trashed), choice.originalController);
        events.push(...grantEvents);
        if (state.pendingChoice) return { events, error: null };
      }
      break;
    }

    case 'trashAllFromHorizon': {
      // No player input needed — auto-resolve
      const trashed = [];
      while (state.zones.horizon.length > 0) {
        const e = removeFromHorizon(state, 0);
        sendToDusk(state, e.cardId);
        trashed.push(e.cardId);
      }
      events.push({ type: 'HORIZON_CLEARED', cards: trashed, count: trashed.length });
      break;
    }

    case 'returnToControllerHand': {
      // payload: { horizonIndex: number }
      const { horizonIndex } = payload;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      if (!horizonEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      const removed = removeFromHorizon(state, horizonIndex);
      const returnTo = controllerOf(removed);
      state.players[returnTo].hand.push(removed.cardId);
      events.push({ type: 'CARD_RETURNED_TO_HAND', cardId: removed.cardId, player: returnTo });
      break;
    }

    case 'moveFromHorizonToDeckTop': {
      // payload: { horizonIndex: number }  — Regret (41)
      const { horizonIndex } = payload;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      if (!horizonEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      const removed = removeFromHorizon(state, horizonIndex);
      state.zones.deck.unshift(removed.cardId);
      events.push({ type: 'CARD_TO_DECK', cardId: removed.cardId, destination: 'deckTop' });
      break;
    }

    case 'stealFromHorizon': {
      // payload: { horizonIndex: number }  — Steal Intensity (86)
      const { horizonIndex } = payload;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      if (!horizonEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      const removed = removeFromHorizon(state, horizonIndex);
      state.players[playerId].hand.push(removed.cardId);
      events.push({ type: 'CARD_STOLEN_TO_HAND', cardId: removed.cardId, player: playerId });
      break;
    }

    case 'putFromDuskToHand': {
      // payload: { cardIds: string[] }
      const { cardIds } = payload;
      if (!Array.isArray(cardIds) || cardIds.length !== choice.count) {
        error = `Must choose exactly ${choice.count} card(s).`; break;
      }
      for (const id of cardIds) {
        if (!state.zones.dusk.includes(id)) { error = `Card ${id} is not in the trash.`; break; }
      }
      if (error) break;
      for (const id of cardIds) {
        state.zones.dusk.splice(state.zones.dusk.indexOf(id), 1);
        state.players[playerId].hand.push(id);
        events.push({ type: 'CARD_FROM_TRASH_TO_HAND', cardId: id, player: playerId });
      }
      break;
    }

    case 'putFromDuskToDeckBottom': {
      // payload: { cardIds: string[] }  — Overconfidence (71) ransom
      const { cardIds } = payload;
      if (!Array.isArray(cardIds) || cardIds.length !== (choice.count ?? 1)) {
        error = `Must choose exactly ${choice.count ?? 1} card(s).`; break;
      }
      for (const id of cardIds) {
        if (!state.zones.dusk.includes(id)) { error = `Card ${id} is not in the trash.`; break; }
      }
      if (error) break;
      for (const id of cardIds) {
        state.zones.dusk.splice(state.zones.dusk.indexOf(id), 1);
        state.zones.deck.push(id); // bottom of deck
        events.push({ type: 'CARD_FROM_TRASH_TO_DECK_BOTTOM', cardId: id, player: playerId });
      }
      break;
    }

    case 'putPointFromDuskIntoZenith': {
      // payload: { cardId: string } — Abstract Embrace (001)
      const { cardId } = payload;
      if (!state.zones.dusk.includes(cardId)) { error = 'That card is not in the dusk.'; break; }
      if (getCard(cardId).type !== 'point') { error = 'Must choose a point card.'; break; }
      state.zones.dusk.splice(state.zones.dusk.indexOf(cardId), 1);
      state.players[playerId].zenith.push(cardId);
      events.push({ type: 'CARD_TO_ZENITH', cardId, player: playerId });
      break;
    }

    case 'putPointFromHorizonIntoZenith': {
      // payload: { horizonIndex: number } — Change of Luck (068). The point never
      // rises; it is banked straight into the chooser's zenith.
      const { horizonIndex } = payload;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      if (getCard(entry.cardId).type !== 'point') { error = 'Must choose a point card.'; break; }
      removeFromHorizon(state, horizonIndex);
      state.players[playerId].zenith.push(entry.cardId);
      events.push({ type: 'CARD_TO_ZENITH', cardId: entry.cardId, player: playerId });
      break;
    }

    case 'moveOnHorizonToTop': {
      // payload: { horizonIndex: number } — Honest Sentiment (104)
      const { horizonIndex } = payload;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      removeFromHorizon(state, horizonIndex);
      state.zones.horizon.unshift(entry);
      events.push({ type: 'HORIZON_CARD_MOVED_TO_TOP', cardId: entry.cardId, player: playerId });
      break;
    }

    case 'putFromDuskToDeckTop': {
      // payload: { cardIds: string[] } — Foreshadow (066)
      const { cardIds } = payload;
      if (!Array.isArray(cardIds) || cardIds.length !== (choice.count ?? 1)) {
        error = `Must choose exactly ${choice.count ?? 1} card(s).`; break;
      }
      for (const id of cardIds) {
        if (!state.zones.dusk.includes(id)) { error = `Card ${id} is not in the dusk.`; break; }
      }
      if (error) break;
      for (const id of cardIds) {
        state.zones.dusk.splice(state.zones.dusk.indexOf(id), 1);
        state.zones.deck.unshift(id);
        events.push({ type: 'CARD_FROM_DUSK_TO_DECK_TOP', cardId: id, player: playerId });
      }
      break;
    }

    case 'opponentChoosesFromDusk': {
      // payload: { cardIds: string[] } — Reach Out to the Dark (057). The chooser
      // is the opponent; the cards go to the caster's hand.
      const { cardIds } = payload;
      if (!Array.isArray(cardIds) || cardIds.length !== choice.count) {
        error = `Must choose exactly ${choice.count} card(s).`; break;
      }
      for (const id of cardIds) {
        if (!state.zones.dusk.includes(id)) { error = `Card ${id} is not in the dusk.`; break; }
      }
      if (error) break;
      for (const id of cardIds) {
        state.zones.dusk.splice(state.zones.dusk.indexOf(id), 1);
        state.players[choice.recipient].hand.push(id);
        events.push({ type: 'CARD_FROM_DUSK_TO_HAND', cardId: id, player: choice.recipient });
      }
      break;
    }

    case 'duskFromHandThenMatchCost': {
      // payload: { cardId: string } — Enlightenment (075) step 1. Dusking the
      // hand card sets the cost that step 2 is allowed to target.
      const { cardId } = payload;
      if (!state.players[playerId].hand.includes(cardId)) {
        error = 'Card is not in your hand.'; break;
      }
      const cost = getCard(cardId).energyCost;
      duskCardFromHand(state, playerId, cardId);
      events.push({ type: 'CARD_FROM_HAND_TO_DUSK', cardId, player: playerId });

      const matchFilter = { costEquals: cost };
      if (state.zones.horizon.some(e => horizonEntryMatchesFilter(e, matchFilter))) {
        state.pendingTriggers.push({
          type: 'duskFromHorizonChoice',
          player: playerId,
          filter: matchFilter,
          optional: true,
        });
        events.push({ type: 'CHOICE_REQUIRED', player: playerId, choiceType: 'duskFromHorizon', filter: matchFilter });
      } else {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'duskFromHorizon', filter: matchFilter });
      }
      break;
    }

    case 'returnTwoDifferentControllers': {
      // payload: { horizonIndexes: [number, number] } — Paradox (101)
      const { horizonIndexes } = payload;
      if (!Array.isArray(horizonIndexes) || horizonIndexes.length !== 2) {
        error = 'Must choose exactly 2 cards.'; break;
      }
      const [a, b] = horizonIndexes;
      const entryA = state.zones.horizon[a];
      const entryB = state.zones.horizon[b];
      if (!entryA || !entryB || a === b) { error = 'Invalid horizon selection.'; break; }
      if (controllerOf(entryA) === controllerOf(entryB)) {
        error = 'The two cards must be controlled by different players.'; break;
      }
      // Remove the higher index first so the lower one does not shift.
      for (const idx of [a, b].sort((x, y) => y - x)) {
        const entry = state.zones.horizon[idx];
        removeFromHorizon(state, idx);
        state.players[controllerOf(entry)].hand.push(entry.cardId);
        events.push({ type: 'CARD_RETURNED_TO_HAND', cardId: entry.cardId, player: controllerOf(entry) });
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
      // payload: { horizonIndex: number }  — Change of Luck (58), Reverse (42)
      const { horizonIndex } = payload;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      if (!horizonEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      entry.controlledBy = playerId;
      events.push({ type: 'CONTROL_GAINED', cardId: entry.cardId, newController: playerId });

      // Reverse (052): when it rises it goes back to whoever originally played
      // it, instead of to the dusk.
      const onResolve = typeof choice.onResolve === 'string' ? choice.onResolve : choice.onResolve?.type;
      if (onResolve === 'returnToInitialControllerHand') {
        entry.returnToHandOnRise = entry.playedBy;
        events.push({ type: 'RETURN_ON_RISE_SET', cardId: entry.cardId, player: entry.playedBy });
      }
      break;
    }

    case 'duskUnlessControllerPaysTarget': {
      // payload: { horizonIndex } — the caster chooses which horizon card to target.
      const { horizonIndex } = payload;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      if (!horizonEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      const ransom = choice.ransom;
      const owner = controllerOf(entry);
      // Step 2: that card's controller decides to pay the ransom or let it trash.
      state.pendingChoice = {
        type: 'duskUnlessControllerPays',
        player: owner,
        targetIndex: horizonIndex,
        targetCardId: entry.cardId,
        ransom,
        ransomCost: ransom?.type === 'payEnergy' ? resolveRansomCost(state, ransom) : null,
      };
      events.push({ type: 'TRASH_UNLESS_TARGETED', cardId: entry.cardId, controller: owner });
      return { events, error: null }; // suspend for the controller's decision
    }

    case 'duskUnlessControllerPays': {
      // payload: { pay: boolean }
      // The targeted card's controller (choice.player) decides. The target was
      // chosen by the engine and stored as choice.targetIndex.
      const { pay } = payload;
      const horizonIndex = choice.targetIndex;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      const ransom = choice.ransom;

      if (!pay) {
        const trashed = duskFromHorizon(state, horizonIndex);
        events.push({ type: 'CARD_TO_DUSK_FROM_HORIZON', cardId: trashed.cardId, reason: 'ransom_declined' });
        break;
      }

      if (ransom?.type === 'payEnergy') {
        const cost = resolveRansomCost(state, ransom);
        if (state.players[playerId].energy < cost) {
          error = `Not enough energy to pay ransom. Need ${cost}, have ${state.players[playerId].energy}.`; break;
        }
        state.players[playerId].energy -= cost;
        events.push({ type: 'RANSOM_PAID', player: playerId, amount: cost });
      } else if (ransom?.type === 'putFromDuskToDeckBottom') {
        if (state.zones.dusk.length === 0) { error = 'No card in the trash to pay the ransom.'; break; }
        // Follow-up: the controller picks which trash card to put on the deck bottom.
        state.pendingChoice = {
          type: 'putFromDuskToDeckBottom',
          player: playerId,
          count: ransom.count ?? 1,
        };
        events.push({ type: 'RANSOM_PAID', player: playerId, ransom: 'putFromDuskToDeckBottom' });
        return { events, error: null }; // stay suspended for the follow-up choice
      } else if (ransom?.type === 'giveFromDuskToCaster') {
        // Debate (081): this ransom is paid to the caster, not to the table.
        if (state.zones.dusk.length === 0) { error = 'No cards in the dusk to pay the ransom.'; break; }
        state.pendingChoice = {
          type: 'opponentChoosesFromDusk',
          player: playerId,
          count: Math.min(ransom.count ?? 1, state.zones.dusk.length),
          recipient: choice.caster ?? opponent(playerId),
        };
        events.push({ type: 'RANSOM_PAID', player: playerId, ransom: 'giveFromDuskToCaster' });
        return { events, error: null };
      } else {
        error = `Unhandled ransom type: ${ransom?.type}`; break;
      }
      break;
    }

    case 'optional': {
      // payload: { accept: boolean }
      if (payload.accept) {
        // Run what they accepted. Sub-effects that need a choice of their own
        // queue normally and surface on the next advancePendingChoices pass.
        events.push({ type: 'OPTIONAL_ACCEPTED' });
        events.push(...executeEffectList(state, choice.effects, playerId));
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
      // payload: { duskCardId: string }  — Search (47): look at top 2, trash one
      const { duskCardId } = payload;
      const top = state.zones.deck.slice(0, choice.count);
      if (!top.includes(duskCardId)) { error = 'Must choose one of the revealed cards.'; break; }

      // Remove trashed card from deck top
      const idx = state.zones.deck.indexOf(duskCardId);
      state.zones.deck.splice(idx, 1);
      sendToDusk(state, duskCardId);
      events.push({ type: 'DECK_TOP_TRASHED', cardId: duskCardId });

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
      // playerId is the opponent making the choice: they keep the chosen card;
      // the rest go to the caster (originalPlayer).
      state.players[playerId].hand.push(cardId);
      events.push({ type: 'CARD_TO_HAND', cardId, player: playerId });

      const rest = choice.revealedCards.filter(id => id !== cardId);
      const originalPlayer = choice.originalPlayer;
      for (const id of rest) {
        state.players[originalPlayer].hand.push(id);
      }
      events.push({ type: 'CARDS_TO_HAND', cards: rest, player: originalPlayer });
      break;
    }

    case 'controllerMovesCardFromHorizonTarget': {
      // payload: { horizonIndex } — Journey (57): caster picks which action to move.
      const { horizonIndex } = payload;
      const entry = state.zones.horizon[horizonIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      if (!horizonEntryMatchesFilter(entry, choice.filter)) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      // Step 2: that card's controller chooses the destination.
      state.pendingChoice = {
        type: 'controllerMovesCardFromHorizon',
        player: controllerOf(entry),
        targetIndex: horizonIndex,
        targetCardId: entry.cardId,
        destinations: choice.destinations ?? ['deckTop', 'deckBottom'],
      };
      events.push({ type: 'HORIZON_MOVE_TARGETED', cardId: entry.cardId, controller: controllerOf(entry) });
      return { events, error: null }; // suspend for the controller's decision
    }

    case 'controllerMovesCardFromHorizon': {
      // payload: { destination: 'deckTop' | 'deckBottom' }  — Journey (57)
      const { destination } = payload;
      if (!(choice.destinations ?? ['deckTop', 'deckBottom']).includes(destination)) {
        error = 'Must choose a valid destination.'; break;
      }
      const entry = state.zones.horizon[choice.targetIndex];
      if (!entry) { error = 'Invalid horizon index.'; break; }
      const removed = removeFromHorizon(state, choice.targetIndex);
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
        // Play the card for 0 energy — put it on horizon
        state.players[playerId].hand.push(cardId); // temp add to hand
        events.push({ type: 'FREE_PLAY_CONFIRMED', cardId, player: playerId });
        // Caller (server) will handle the actual playCard call
      } else {
        state.zones.deck.unshift(choice.cardId); // return to top of deck
        events.push({ type: 'FREE_PLAY_DECLINED', cardId: choice.cardId });
      }
      break;
    }

    case 'mayPlayFromHand': {
      // payload: { play: boolean, cardId?: string }  — Metamorphosis (61)
      if (!payload.play) { events.push({ type: 'FREE_PLAY_DECLINED' }); break; }
      const { cardId } = payload;
      if (!state.players[playerId].hand.includes(cardId)) { error = 'Card not in hand.'; break; }
      if (choice.filter && choice.filter !== 'any' && getCard(cardId).type !== choice.filter) {
        error = `Must play a ${choice.filter} card.`; break;
      }
      // Card stays in hand; the server plays it for free.
      events.push({ type: 'FREE_PLAY_CONFIRMED', cardId, player: playerId });
      break;
    }

    case 'mayPlayTopOfDeck': {
      // payload: { play: boolean }  — Reinstate (84)
      if (!payload.play) { events.push({ type: 'FREE_PLAY_DECLINED' }); break; }
      const top = choice.cardId;
      const idx = state.zones.deck.indexOf(top);
      if (idx === -1) { error = 'Top card is no longer available.'; break; }
      state.zones.deck.splice(idx, 1);
      state.players[playerId].hand.push(top); // server plays it from hand for free
      events.push({ type: 'FREE_PLAY_CONFIRMED', cardId: top, player: playerId });
      break;
    }

    case 'chooseCardToDuskFromRevealedHand': {
      // payload: { cardId }  — Inquisition (16), Cerebral Snuff (81)
      const { cardId } = payload;
      const targetPlayer = choice.targetPlayer;
      if (!state.players[targetPlayer].hand.includes(cardId)) {
        error = 'Card not in that player\'s hand.'; break;
      }
      if (choice.filter && choice.filter !== 'any' && getCard(cardId).type !== choice.filter) {
        error = `Must choose a ${choice.filter} card.`; break;
      }
      duskCardFromHand(state, targetPlayer, cardId);
      events.push({ type: 'CARD_TO_DUSK_FROM_HAND', player: targetPlayer, cardId });
      break;
    }

    case 'additionalCost': {
      // Dispatch to specific additional cost type
      const { cost } = choice;
      switch (cost.type) {
        case 'duskFromHand': {
          const { cardIds } = payload;
          if (!cardIds?.length) { error = 'Must trash a card.'; break; }
          for (const id of cardIds) {
            if (!state.players[playerId].hand.includes(id)) {
              error = `Card ${id} not in hand.`; break;
            }
          }
          if (error) break;
          for (const id of cardIds) {
            duskCardFromHand(state, playerId, id);
            events.push({ type: 'CARD_TO_DUSK_FROM_HAND', player: playerId, cardId: id });
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
        case 'payAnyAmount': {
          // Auction (045), Bid (058) — the amount paid is remembered on the
          // horizon entry, because the card's own text refers back to it.
          const amount = Math.floor(payload.amount ?? 0);
          if (!Number.isFinite(amount) || amount < 0) { error = 'Invalid amount.'; break; }
          if (state.players[playerId].energy < amount) {
            error = `Not enough energy. You have ${state.players[playerId].energy}.`; break;
          }
          state.players[playerId].energy -= amount;
          const paidEntry = state.zones.horizon.find(e => e.cardId === choice.cardId);
          if (paidEntry) paidEntry.paidAmount = amount;
          events.push({ type: 'ENERGY_SPENT', player: playerId, amount, reason: 'additionalCost' });
          break;
        }
        case 'putFromDuskToDeckBottom': {
          // Abyss (048)
          const { cardIds } = payload;
          const need = cost.count ?? 1;
          if (!Array.isArray(cardIds) || cardIds.length !== need) {
            error = `Must choose exactly ${need} card(s) from the dusk.`; break;
          }
          for (const id of cardIds) {
            if (!state.zones.dusk.includes(id)) { error = `Card ${id} is not in the dusk.`; break; }
          }
          if (error) break;
          for (const id of cardIds) {
            state.zones.dusk.splice(state.zones.dusk.indexOf(id), 1);
            state.zones.deck.push(id);
            events.push({ type: 'CARD_FROM_DUSK_TO_DECK_BOTTOM', cardId: id, player: playerId });
          }
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
    // Targeted removals are the other way a card leaves the horizon, so any
    // "when this leaves the horizon" trigger fires once the choice has applied.
    events.push(...flushHorizonTriggers(state));
  }

  return { events, error };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function resolveRansomCost(state, ransom) {
  if (typeof ransom.amount === 'number') return ransom.amount;
  if (ransom.amount === 'countInDusk:any') return state.zones.dusk.length;
  if (ransom.amount === 'countOnHorizon:any') return state.zones.horizon.length;
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
    case 'mayPlayFromHand': {
      // Only offer the choice if the player holds a matching card.
      const playable = state.players[player].hand.filter(
        id => !grant.filter || grant.filter === 'any' || getCard(id).type === grant.filter
      );
      if (playable.length === 0) break;
      state.pendingChoice = {
        type: 'mayPlayFromHand',
        player,
        filter: grant.filter,
        cost: grant.cost,
      };
      events.push({ type: 'CHOICE_REQUIRED', player, choiceType: 'mayPlayFromHand', filter: grant.filter, cost: grant.cost });
      break;
    }
    case 'mayPlayTopOfDeck': {
      const top = state.zones.deck[0];
      if (!top) break; // empty deck — nothing to play
      state.pendingChoice = {
        type: 'mayPlayTopOfDeck',
        player,
        cost: grant.cost,
        cardId: top, // reveal the top card to the player
      };
      events.push({ type: 'CHOICE_REQUIRED', player, choiceType: 'mayPlayTopOfDeck', cardId: top, cost: grant.cost });
      break;
    }
    case 'draw':
      const drawn = drawCards(state, player, grant.count);
      events.push({ type: 'CARDS_DRAWN', player, cards: drawn });
      break;
  }
  return events;
}
