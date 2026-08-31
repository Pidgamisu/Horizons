import { getCard } from '../data/cardDb.js';
import {
  drawCards, duskHand,
  sendToDusk, shuffle, opponent, controllerOf, removeFromHorizon, removeHorizonEntry,
  horizonHasTarget, reshuffleDuskIntoDeck, pointsOf, bothTypesToDuskThisTurn,
  voidedBothTypesThisTurn,
} from '../engine/state.js';

/**
 * Execute all effects of a card when it resolves.
 * entry = the HorizonEntry that just resolved.
 * Returns an array of event objects describing what happened (for broadcast).
 */
export function executeEffects(state, entry) {
  const card = getCard(entry.cardId);
  const controller = controllerOf(entry);
  const events = [];

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
 * Run an arbitrary list of effects for a player — used when a player accepts an
 * optional effect (Synergy 007, Answer Fate 047), where the effects are carried
 * on the choice rather than read off a card.
 */
export function executeEffectList(state, effects, controller, entry = null) {
  const events = [];
  const ctx = {};
  for (const effect of effects ?? []) {
    events.push(...executeEffect(state, effect, controller, entry, ctx));
    if (state.winner) break;
  }
  return events;
}

/**
 * Execute onPlayEffects — triggered when the card hits the horizon, not on resolution.
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

    case 'duskFromHand': {
      const count = effect.count;
      const targets = resolvePlayers(effect.player, controller, opp);
      const playerList = targets === 'both' ? [controller, opp] : [targets];
      // Last Chance (76): defer the trash to the turn boundary (same time as
      // Prepare's deferred draw) instead of trashing on resolution.
      if (effect.timing === 'endOfTurn') {
        for (const p of playerList) {
          state.pendingTriggers.push({ type: 'endOfTurnDusk', player: p, count });
        }
        events.push({ type: 'PENDING_TRASH', player: controller, count });
        break;
      }
      for (const p of playerList) {
        // Clamp to what the player actually holds — "trash N" with fewer than N
        // trashes all of them; with an empty hand it does nothing (no lock).
        const effective = Math.min(count, state.players[p].hand.length);
        if (effective === 0) continue;
        state.pendingTriggers.push({ type: 'duskFromHandChoice', player: p, count: effective, optional: false });
        events.push({ type: 'CHOICE_REQUIRED', player: p, choiceType: 'duskFromHand', count: effective });
      }
      break;
    }

    case 'duskHand': {
      const target = effect.player === 'self' ? controller : opp;
      const count = duskHand(state, target);
      ctx.cardsJustTrashed = (ctx.cardsJustTrashed ?? 0) + count;
      events.push({ type: 'HAND_TRASHED', player: target, count });
      break;
    }

    case 'duskAnyNumberFromHand': {
      // Reset Memory (88): the caster trashes any number of cards from their
      // hand (including none), then draws that many plus a bonus. The trash +
      // draw both happen when the choice resolves (see choices.js), so an empty
      // hand still lets them draw the bonus.
      state.pendingTriggers.push({
        type: 'duskAnyNumberFromHandChoice',
        player: controller,
        drawPlus: effect.thenDrawPlus ?? 0,
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'duskAnyNumberFromHand' });
      break;
    }

    case 'duskFromHorizon': {
      const filter = resolveHorizonFilter(state, effect.filter);
      // No legal target on the (remaining) horizon → skip instead of prompting an
      // impossible choice that would hardlock the game.
      if (!horizonHasTarget(state, filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'duskFromHorizon', filter });
        break;
      }
      state.pendingTriggers.push({
        type: 'duskFromHorizonChoice',
        player: controller,
        filter,
        thenGrant: effect.thenGrant ?? null,
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'duskFromHorizon', filter: effect.filter });
      break;
    }

    case 'duskAllFromHorizon': {
      const trashed = [];
      while (state.zones.horizon.length > 0) {
        const e = removeFromHorizon(state, 0);
        sendToDusk(state, e.cardId, true);
        trashed.push(e.cardId);
      }
      ctx.cardsJustTrashed = (ctx.cardsJustTrashed ?? 0) + trashed.length;
      events.push({ type: 'HORIZON_CLEARED', cards: trashed });
      break;
    }

    case 'duskTopOfDeck': {
      for (let i = 0; i < (effect.count ?? 1); i++) {
        if (state.zones.deck.length === 0) break;
        const card = state.zones.deck.shift();
        sendToDusk(state, card);
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

    case 'putFromDuskToHand': {
      // Clamp to what's in the trash; skip if there's nothing to take.
      const effective = Math.min(effect.count ?? 1, state.zones.dusk.length);
      if (effective === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'putFromDuskToHand' });
        break;
      }
      state.pendingTriggers.push({ type: 'putFromDuskToHandChoice', player: controller, count: effective });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'putFromDuskToHand', count: effective });
      break;
    }

    case 'returnToControllerHand': {
      if (!horizonHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'returnToControllerHand', filter: effect.filter });
        break;
      }
      state.pendingTriggers.push({ type: 'returnHorizonCardToHandChoice', player: controller, filter: effect.filter });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'returnToControllerHand', filter: effect.filter });
      break;
    }

    case 'moveFromHorizonToHand': {
      // Steal Intensity (86) — puts a point card on horizon into your own hand
      if (!horizonHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'moveFromHorizonToHand', filter: effect.filter });
        break;
      }
      state.pendingTriggers.push({ type: 'stealFromHorizonChoice', player: controller, filter: effect.filter });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'stealFromHorizon', filter: effect.filter });
      break;
    }

    case 'moveFromHorizonToDeckTop': {
      // Regret (41) — controller picks a card on the horizon to put on top of the deck
      if (!horizonHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'moveFromHorizonToDeckTop', filter: effect.filter });
        break;
      }
      state.pendingTriggers.push({ type: 'moveFromHorizonToDeckTop', player: controller, filter: effect.filter });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'moveFromHorizonToDeckTop', filter: effect.filter });
      break;
    }

    case 'chooseCardToDuskFromRevealedHand': {
      // Inquisition (16), Cerebral Snuff (81): reveal the opponent's hand, then
      // the caster picks a card from it (filtered) to trash.
      const target = opp;
      const filter = effect.filter ?? 'any';
      const candidates = state.players[target].hand.filter(
        id => filter === 'any' || getCard(id).type === filter
      );
      if (candidates.length === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'chooseCardToDuskFromRevealedHand', filter });
        break;
      }
      state.pendingTriggers.push({
        type: 'chooseCardToDuskFromRevealedHand',
        player: controller,
        targetPlayer: target,
        filter,
        revealedHand: [...state.players[target].hand],
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'chooseCardToDuskFromRevealedHand', filter });
      break;
    }

    case 'controllerMovesCardFromHorizon': {
      // Journey (57): caster picks an action on the horizon; step 2 lets THAT
      // card's controller choose to put it on the top or bottom of the deck.
      if (!horizonHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'controllerMovesCardFromHorizon', filter: effect.filter });
        break;
      }
      state.pendingTriggers.push({
        type: 'controllerMovesCardFromHorizonTarget',
        player: controller,
        filter: effect.filter,
        destinations: effect.destinations ?? ['deckTop', 'deckBottom'],
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'controllerMovesCardFromHorizonTarget', filter: effect.filter });
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

    case 'duskUnlessControllerPays': {
      // Drown in Fog (59), Chains (74), Poke (87), Overconfidence (71).
      // Step 1: the caster picks which horizon card to target. Step 2 (set up when
      // this resolves) lets THAT card's controller pay the ransom or lose it.
      if (!horizonHasTarget(state, effect.filter)) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'duskUnlessControllerPays', filter: effect.filter });
        break;
      }
      // Bid (058) sets its ransom from what the caster paid on the way in. The
      // entry is gone from the horizon by now, so resolve it here while we
      // still hold a reference to it.
      const ransom = effect.ransom?.amount === 'paidAmount'
        ? { ...effect.ransom, amount: entry?.paidAmount ?? 0 }
        : effect.ransom;
      state.pendingTriggers.push({
        type: 'duskUnlessControllerPaysTarget',
        player: controller,
        filter: effect.filter,
        ransom,
        caster: controller,
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'duskUnlessControllerPaysTarget', filter: effect.filter });
      break;
    }

    case 'duskSelf': {
      const removed = entry ? removeHorizonEntry(state, entry) : null;
      if (removed) {
        sendToDusk(state, removed.cardId, true);
        events.push({ type: 'CARD_TO_DUSK_FROM_HORIZON', cardId: removed.cardId });
      }
      break;
    }

    case 'moveSelf': {
      // The card has already left the horizon by the time this runs, and may
      // already be sitting in the dusk — Agoraphobia (040) says to put it at the
      // bottom of the deck "instead of anywhere else", so reclaim it first.
      const di = state.zones.dusk.lastIndexOf(entry?.cardId);
      if (di !== -1 && entry) state.zones.dusk.splice(di, 1);
      if (effect.to === 'deckBottom') {
        state.zones.deck.push(entry.cardId);
        events.push({ type: 'CARD_TO_DECK_BOTTOM', card: entry.cardId });
      } else if (effect.to === 'deckTop') {
        state.zones.deck.unshift(entry.cardId);
        events.push({ type: 'CARD_TO_DECK_TOP', card: entry.cardId });
      } else if (effect.to === 'opponentHand') {
        state.players[opp].hand.push(entry.cardId);
        events.push({ type: 'CARD_TO_OPPONENT_HAND', card: entry.cardId, player: opp });
      }
      break;
    }

    case 'swapHorizonPositions': {
      // Forever Borrow (36): swap this card's position with the responded-to card
      const selfIdx = state.zones.horizon.findIndex(e => e === entry);
      const targetIdx = entry.respondedToCardIndex;
      if (selfIdx !== -1 && targetIdx !== null && targetIdx !== -1) {
        const temp = state.zones.horizon[selfIdx];
        state.zones.horizon[selfIdx] = state.zones.horizon[targetIdx];
        state.zones.horizon[targetIdx] = temp;
        events.push({ type: 'HORIZON_POSITIONS_SWAPPED', indexA: selfIdx, indexB: targetIdx });
      }
      break;
    }

    case 'gainControl': {
      if (!horizonHasTarget(state, effect.filter)) {
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
      // Lock the caster's opponent specifically (not "whoever isn't on turn"),
      // so Stifle Speech never stops the caster's own plays.
      state.turnFlags.lockedPlayer = opp;
      events.push({ type: 'OPPONENT_LOCKED_FROM_PLAYING', player: opp });
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

    case 'allowPlayFromDusk': {
      state.turnFlags.playFromDusk = true;
      events.push({ type: 'PLAY_FROM_TRASH_UNLOCKED', player: controller });
      break;
    }

    case 'redirectDuskToDeckBottom': {
      state.turnFlags.redirectDuskToDeckBottom = true;
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

    // ── Zenith movement ───────────────────────────────────────────────────────

    case 'putPointFromDuskIntoZenith': {
      // Abstract Embrace (001) — bank a point card straight out of the dusk.
      const points = state.zones.dusk.filter(id => getCard(id).type === 'point');
      if (points.length === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'putPointFromDuskIntoZenith' });
        break;
      }
      state.pendingTriggers.push({
        type: 'putPointFromDuskIntoZenithChoice',
        player: controller,
        candidates: points,
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'putPointFromDuskIntoZenith' });
      break;
    }

    case 'putPointFromHorizonIntoZenith': {
      // Change of Luck (068) — a point on the horizon never rises; it is banked
      // directly into your zenith instead.
      if (!horizonHasTarget(state, 'point')) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'putPointFromHorizonIntoZenith' });
        break;
      }
      state.pendingTriggers.push({
        type: 'putPointFromHorizonIntoZenithChoice',
        player: controller,
        filter: 'point',
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'putPointFromHorizonIntoZenith' });
      break;
    }

    // ── Horizon sweeps ────────────────────────────────────────────────────────

    case 'duskTopOfHorizon': {
      // Anxiety (073) — no choice: whatever is on top goes to the dusk.
      if (state.zones.horizon.length === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'duskTopOfHorizon' });
        break;
      }
      const top = removeFromHorizon(state, 0);
      sendToDusk(state, top.cardId, true);
      events.push({ type: 'CARD_TO_DUSK_FROM_HORIZON', cardId: top.cardId });
      break;
    }

    case 'allHorizonToDeckBottom': {
      // Settle (100) — everything waiting on the horizon goes under the deck.
      const moved = [];
      while (state.zones.horizon.length > 0) {
        const e = removeFromHorizon(state, 0);
        state.zones.deck.push(e.cardId);
        moved.push(e.cardId);
      }
      events.push({ type: 'HORIZON_TO_DECK_BOTTOM', cards: moved });
      break;
    }

    case 'moveOnHorizonToTop': {
      // Honest Sentiment (104) — reorder the horizon so a chosen card rises next.
      if (state.zones.horizon.length < 2) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'moveOnHorizonToTop' });
        break;
      }
      state.pendingTriggers.push({
        type: 'moveOnHorizonToTopChoice',
        player: controller,
        filter: effect.filter ?? 'any',
      });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'moveOnHorizonToTop' });
      break;
    }

    // ── Deck / dusk shuffling ─────────────────────────────────────────────────

    case 'shuffleDuskIntoDeck': {
      // Answer Fate (047) — a card-granted reshuffle. Card text beats the
      // 2-player "no reshuffles" default, so this can genuinely push Sunset out.
      const count = state.zones.dusk.length;
      reshuffleDuskIntoDeck(state);
      events.push({ type: 'DUSK_SHUFFLED_INTO_DECK', count });
      break;
    }

    case 'putFromDuskToDeckTop': {
      // Foreshadow (066) — pick a card out of the dusk to draw next.
      const effective = Math.min(effect.count ?? 1, state.zones.dusk.length);
      if (effective === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'putFromDuskToDeckTop' });
        break;
      }
      state.pendingTriggers.push({ type: 'putFromDuskToDeckTopChoice', player: controller, count: effective });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'putFromDuskToDeckTop', count: effective });
      break;
    }

    case 'shuffleHandsIntoDeckAndDraw': {
      // Reset Memory (098) — both hands go back into the deck, then both redraw.
      const n = effect.count ?? 5;
      const returned = [...state.players.p1.hand, ...state.players.p2.hand];
      state.players.p1.hand = [];
      state.players.p2.hand = [];
      state.zones.deck = shuffle([...state.zones.deck, ...returned]);
      const d1 = drawCards(state, 'p1', n);
      const d2 = drawCards(state, 'p2', n);
      events.push({ type: 'HANDS_RESET', returned: returned.length, p1: d1.length, p2: d2.length });
      break;
    }

    case 'revealTopNSplitByType': {
      // Gamble (103) — reveal the top N; points to your hand, the rest to the dusk.
      const n = effect.count ?? 4;
      const revealed = state.zones.deck.splice(0, n);
      const taken = [], discarded = [];
      for (const id of revealed) {
        if (getCard(id).type === 'point') {
          state.players[controller].hand.push(id);
          taken.push(id);
        } else {
          sendToDusk(state, id);
          discarded.push(id);
        }
      }
      events.push({ type: 'CARDS_REVEALED', cards: revealed });
      events.push({ type: 'REVEAL_SPLIT', player: controller, toHand: taken, toDusk: discarded });
      break;
    }

    // ── Energy and hands ──────────────────────────────────────────────────────

    case 'drainOpponentEnergy': {
      // Trickle Down Economics (027) — take whatever the opponent is holding.
      const drained = state.players[opp].energy;
      state.players[opp].energy = 0;
      state.players[controller].energy += drained;
      events.push({ type: 'ENERGY_DRAINED', from: opp, to: controller, amount: drained });
      break;
    }

    case 'randomFromHandToDusk': {
      // Cerebral Snuff (091) — random, so no choice is offered to anyone.
      const target = effect.player === 'self' ? controller : opp;
      const hand = state.players[target].hand;
      const n = Math.min(effect.count ?? 1, hand.length);
      const lost = [];
      for (let i = 0; i < n; i++) {
        const idx = Math.floor(Math.random() * hand.length);
        const [id] = hand.splice(idx, 1);
        sendToDusk(state, id);
        lost.push(id);
      }
      events.push({ type: 'RANDOM_CARDS_TO_DUSK', player: target, cards: lost });
      break;
    }

    case 'conditionalDraw': {
      // Angst (020), Beget Advantage (034) — draw only if the condition holds.
      const met = evaluateCardCondition(state, effect.condition, controller);
      if (!met) {
        events.push({ type: 'CONDITION_NOT_MET', condition: effect.condition });
        break;
      }
      const target = resolvePlayers(effect.player, controller, opp);
      const drawn = drawCards(state, target === 'both' ? controller : target, effect.count);
      events.push({ type: 'CARDS_DRAWN', player: target, cards: drawn });
      break;
    }

    case 'gainControlOfRespondedCard': {
      // Forever Borrow (036) — no choice: it takes the very card it responded to.
      // This runs as an on-play effect, so self is index 0 and the responded-to
      // card sits directly beneath it.
      const target = state.zones.horizon[1];
      if (!target || getCard(target.cardId).type !== 'action') {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'gainControlOfRespondedCard' });
        break;
      }
      target.controlledBy = controller;
      if (effect.onRise === 'returnToInitialControllerHand') {
        target.returnToHandOnRise = target.playedBy;
      }
      events.push({ type: 'CONTROL_GAINED', cardId: target.cardId, newController: controller });
      break;
    }

    case 'opponentChoosesFromDusk': {
      // Reach Out to the Dark (057) — they pick, you receive.
      const count = Math.min(effect.count ?? 1, state.zones.dusk.length);
      if (count === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'opponentChoosesFromDusk' });
        break;
      }
      state.pendingTriggers.push({
        type: 'opponentChoosesFromDuskChoice',
        player: opp,                // the opponent makes the choice
        count,
        recipient: controller,      // the caster receives the cards
      });
      events.push({ type: 'CHOICE_REQUIRED', player: opp, choiceType: 'opponentChoosesFromDusk', count });
      break;
    }

    case 'duskFromHandThenMatchCostOnHorizon': {
      // Enlightenment (075) — dusk a card, then optionally dusk a horizon card
      // that shares its cost. The second step is queued once the first resolves,
      // because the matching cost isn't known until then.
      if (state.players[controller].hand.length === 0) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'duskFromHandThenMatchCostOnHorizon' });
        break;
      }
      state.pendingTriggers.push({ type: 'duskFromHandThenMatchCostChoice', player: controller });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'duskFromHandThenMatchCost' });
      break;
    }

    case 'returnTwoDifferentControllers': {
      // Paradox (101) — needs one card from each player on the horizon.
      const controllers = new Set(state.zones.horizon.map(e => controllerOf(e)));
      if (state.zones.horizon.length < 2 || controllers.size < 2) {
        events.push({ type: 'NO_VALID_TARGETS', effect: 'returnTwoDifferentControllers' });
        break;
      }
      state.pendingTriggers.push({ type: 'returnTwoDifferentControllersChoice', player: controller });
      events.push({ type: 'CHOICE_REQUIRED', player: controller, choiceType: 'returnTwoDifferentControllers' });
      break;
    }

    // Complex effects that need player interaction — all queued as pending choices
    case 'revealUntilType':
    case 'chooseNumber':
    case 'duskFromHandChoice':
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

function resolvePlayers(spec, controller, opp) {
  if (spec === 'self') return controller;
  if (spec === 'opponent') return opp;
  if (spec === 'both') return 'both';
  return controller;
}

function resolveAmount(state, amount, ctx) {
  if (typeof amount === 'number') return amount;
  if (amount === 'cardsJustTrashed') return ctx.cardsJustTrashed ?? 0;
  if (amount === 'highestCostOnHorizon') {
    if (state.zones.horizon.length === 0) return 0;
    return Math.max(...state.zones.horizon.map(e => getCard(e.cardId).energyCost));
  }
  if (amount === 'distinctEnergyCostsInTrash') {
    return new Set(state.zones.dusk.map(id => getCard(id).energyCost)).size;
  }
  if (typeof amount === 'string' && amount.startsWith('countInDusk:')) {
    const filter = amount.split(':')[1];
    return filter === 'any'
      ? state.zones.dusk.length
      : state.zones.dusk.filter(id => getCard(id).type === filter).length;
  }
  if (typeof amount === 'string' && amount.startsWith('countOnHorizon:')) {
    return state.zones.horizon.length;
  }
  if (amount === 'distinctEnergyCostsOnHorizon') {   // Dividends (083)
    return new Set(state.zones.horizon.map(e => getCard(e.cardId).energyCost)).size;
  }
  if (amount === 'threePerCardOnHorizon') {           // Share the Loot (085)
    return state.zones.horizon.length * 3;
  }
  if (amount === 'trackedCost') {                     // Burn Out (088), Strobe Brightness (102)
    return ctx.trackedCost ?? 0;
  }
  return 0;
}

/**
 * Turn a filter that depends on the board into one that doesn't. Only
 * costLessThanDuskSize needs it today (Agonizing Memory, 098): the matcher is
 * given an entry and a filter and never sees the state.
 */
function resolveHorizonFilter(state, filter) {
  if (filter && typeof filter === 'object' && filter.costLessThanDuskSize) {
    return { costLessThan: state.zones.dusk.length };
  }
  return filter;
}

/** Conditions a card checks as it rises (as opposed to when it is played). */
function evaluateCardCondition(state, condition, playerId) {
  switch (condition) {
    case 'bothTypesToDuskThisTurn': return bothTypesToDuskThisTurn(state);
    case 'voidedBothTypesThisTurn': return voidedBothTypesThisTurn(state, playerId);
    case 'selfAtFourPoints':        return pointsOf(state, playerId) >= 4;
    case 'opponentAtFourPoints':    return pointsOf(state, opponent(playerId)) >= 4;
    default: return false;
  }
}




// ─── Departure triggers ───────────────────────────────────────────────────────

/**
 * Fire the triggers that watch for a card leaving the horizon, or reaching the
 * dusk from somewhere other than the horizon.
 *
 * Departures are queued rather than fired at the removal site, because removal
 * happens deep inside state.js which cannot reach the effect executor. This
 * drains that queue once the surrounding operation has finished, so the board is
 * in a settled state before any trigger runs.
 *
 * Loops, since a trigger can itself remove another card from the horizon.
 */
export function flushHorizonTriggers(state) {
  const events = [];
  let guard = 0;

  while (
    (state.pendingHorizonDepartures?.length || state.pendingDuskEntries?.length) &&
    ++guard < 32
  ) {
    const departures = state.pendingHorizonDepartures ?? [];
    const duskEntries = state.pendingDuskEntries ?? [];
    state.pendingHorizonDepartures = [];
    state.pendingDuskEntries = [];

    for (const { entry, rose } of departures) {
      const card = getCard(entry.cardId);
      const controller = controllerOf(entry);

      for (const se of card.staticEffects ?? []) {
        if (se.type !== 'trigger') continue;
        const fires =
          se.on === 'leavesHorizon' ||
          (se.on === 'leavesHorizonWithoutRising' && !rose);
        if (!fires) continue;
        events.push(...runDepartureEffect(state, se.effect, controller, entry, rose));
      }

      // Understand Despair (064): registered for the turn, watching every card
      // its owner controls rather than one specific card.
      for (const trigger of state.pendingTriggers) {
        if (trigger.type !== 'registerTurnTrigger') continue;
        if (trigger.on !== 'selfCardLeavesHorizonWithoutRising') continue;
        if (rose || controller !== trigger.owner) continue;
        events.push(...runDepartureEffect(state, trigger.effect, trigger.owner, entry, rose));
      }
    }

    for (const { cardId, fromHorizon } of duskEntries) {
      if (fromHorizon) continue;
      const card = getCard(cardId);
      for (const se of card.staticEffects ?? []) {
        if (se.type === 'trigger' && se.on === 'putIntoDuskFromNonHorizon') {
          // No horizon entry exists — the card never got there — so the effect
          // runs for the turn player.
          events.push(...runDepartureEffect(state, se.effect, state.turn, null, false));
        }
      }
    }
  }

  return events;
}

function runDepartureEffect(state, effect, controller, entry, rose) {
  if (!effect) return [];
  // Pride (046) does one thing if it rose and another if it didn't.
  const resolved = effect.type === 'branchOnRose'
    ? (rose ? effect.ifRose : effect.ifNot)
    : effect;
  if (!resolved) return [];
  return executeEffectList(state, [resolved], controller, entry);
}
