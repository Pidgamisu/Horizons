import { ALL_CARD_IDS } from '../data/cardDb.js';

// ─── Choice Triggers ─────────────────────────────────────────────────────────
// The subset of pendingTriggers that the server surfaces to a player as a
// CHOICE_REQUIRED prompt (as opposed to background triggers like
// registerTurnTrigger / endOfTurnDusk that resolve on their own). Single source
// of truth shared by server.advancePendingChoices and the resolution engine.
export const CHOICE_TRIGGER_TYPES = new Set([
  'duskFromHandChoice', 'duskAnyNumberFromHandChoice', 'duskFromHorizonChoice', 'returnHorizonCardToHandChoice',
  'stealFromHorizonChoice', 'gainControlChoice', 'putFromDuskToHandChoice',
  'optionalEffectChoice', 'additionalCost', 'putHandCardOnDeckTop',
  'revealUntilType', 'opponentChoosesOne', 'controllerMovesCardFromHorizonTarget',
  'lookAtTopN', 'chooseNumber', 'chooseCardToDuskFromRevealedHand',
  'moveFromHorizonToDeckTop', 'duskUnlessControllerPaysTarget',
  'putPointFromDuskIntoZenithChoice', 'putPointFromHorizonIntoZenithChoice',
  'moveOnHorizonToTopChoice', 'putFromDuskToDeckTopChoice',
  'opponentChoosesFromDuskChoice', 'duskFromHandThenMatchCostChoice',
  'returnTwoDifferentControllersChoice',
]);

/** Does a pending trigger require a player choice (vs. resolving on its own)? */
export function isChoiceTrigger(trigger) {
  return CHOICE_TRIGGER_TYPES.has(trigger.type);
}

// ─── State Factory ───────────────────────────────────────────────────────────

export function createGameState() {
  return {
    phase: 'waiting',          // 'waiting' | 'active' | 'ended'
    turn: 'p1',                // whose turn it is
    activePlayer: 'p1',        // who currently holds priority
    priorityPassCount: 0,      // 0/1/2 — when 2, resolve top of horizon
    turnNumber: 0,
    cardsPlayedThisTurn: [],   // [{ cardId, playedBy }] in order
    cardsDrawnThisTurn: { p1: 0, p2: 0 },
    cardsToDuskThisTurn: [],   // CardId[] — everything that entered the dusk this turn (Delve 003, Angst 020)

    players: {
      p1: createPlayerState(),
      p2: createPlayerState(),
    },

    zones: {
      deck:  [],   // CardId[], index 0 = top
      horizon: [],   // HorizonEntry[], index 0 = top (last played)
      dusk:  [],   // CardId[] — the single shared face-up pile: risen actions AND voided cards
    },

    // Sunset: the deck is finite. Each reshuffle refills the deck from the dusk;
    // when the deck runs dry with none left, the game ends (see checkSunset).
    // Rulebook: reshuffles = (players − 2), so a 2-player game gets zero and the
    // deck depletes exactly once. Answer Fate (048) can grant an extra one.
    reshufflesRemaining: 0,

    // Active per-turn effect flags (cleared each turn)
    turnFlags: createTurnFlags(),

    // Pending end-of-turn triggers
    pendingTriggers: [],

    // The choice a player is currently being asked to make, if any.
    pendingChoice: null,

    winner: null,
  };
}

export function createPlayerState() {
  return {
    hand:              [],
    zenith:            [],        // CardId[] — face-up pile of risen points; 1 point each
    energy:            0,
    timerSeconds:      25 * 60,   // 25 minutes
    isHoldingPriority: false,

    // Per-turn play restriction flags
    lockedFromPlaying:       false,
    pointResponseToActions:  false,   // Blinding Flash (51)
  };
}

export function createTurnFlags() {
  return {
    playFromDusk:            false,  // Consult the Past (38), Brought Back (72)
    redirectDuskToDeckBottom:false,  // Brought Back (72)
    allCardsCostLess:         0,      // Possess Love (83) — stacks as delta
    lockedPlayer:             null,   // Stifle Speech (52) — playerId locked from playing this turn
    protectNextSelfAction: null, // Injustice (67) — playerId whose next action this turn is protected from action responses
    shareTheLootActive:       false,  // Share the Loot (75)
  };
}

// ─── Horizon Entry Factory ──────────────────────────────────────────────────────

export function createHorizonEntry(cardId, playedBy, meta = {}) {
  return {
    cardId,
    playedBy,
    controlledBy: null,        // overrides playedBy for controller effects (Change of Luck, Reverse)
    respondedToCardIndex: meta.respondedToCardIndex ?? null,
    respondedToCardType:  meta.respondedToCardType  ?? null,
    responsesLocked: meta.responsesLocked ?? false, // Injustice (67) — opponents can't action-respond to this entry
  };
}

export function controllerOf(entry) {
  return entry.controlledBy ?? entry.playedBy;
}

export function opponent(playerId) {
  return playerId === 'p1' ? 'p2' : 'p1';
}

// ─── Deck / Zone Helpers ──────────────────────────────────────────────────────

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function initDeck(state) {
  state.zones.deck = shuffle([...ALL_CARD_IDS]);
}

/**
 * Draw up to n cards for a player. Spends a reshuffle (dusk → deck) if the deck
 * runs dry and one remains; otherwise the draw simply stops — an empty deck is
 * not an error, it's the Sunset condition (checked by the caller in game.js).
 */
export function drawCards(state, playerId, n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    // Check draw lock (Dread 039)
    if (isDrawLocked(state)) break;

    if (state.zones.deck.length === 0) {
      if (state.reshufflesRemaining <= 0) break;   // deck is spent — Sunset
      if (state.zones.dusk.length === 0) break;    // nothing to reshuffle
      reshuffleDuskIntoDeck(state);
      state.reshufflesRemaining--;
    }
    const card = state.zones.deck.shift();
    state.players[playerId].hand.push(card);
    drawn.push(card);
    state.cardsDrawnThisTurn[playerId]++;
  }
  return drawn;
}

/** Shuffle the whole dusk back into the deck. Zeniths are never reshuffled. */
export function reshuffleDuskIntoDeck(state) {
  state.zones.deck = shuffle([...state.zones.deck, ...state.zones.dusk]);
  state.zones.dusk = [];
}

/** A player's score: one point per point card in their zenith. */
export function pointsOf(state, playerId) {
  return state.players[playerId].zenith.length;
}

/** Put a risen point card into its controller's zenith. */
export function sendToZenith(state, playerId, cardId) {
  state.players[playerId].zenith.push(cardId);
}

/**
 * Has the deck run out with no reshuffles left? Sunset ends the game as soon as
 * the current card finishes rising (see game.checkSunset).
 */
export function isDeckSpent(state) {
  return state.zones.deck.length === 0 && state.reshufflesRemaining <= 0;
}

/** Move a card from a player's hand to the dusk (or deck bottom if redirected). */
export function duskCardFromHand(state, playerId, cardId) {
  const hand = state.players[playerId].hand;
  const idx = hand.indexOf(cardId);
  if (idx === -1) throw new Error(`Card ${cardId} not in ${playerId}'s hand`);
  hand.splice(idx, 1);
  sendToDusk(state, cardId);
}

/** Move a card to the dusk, respecting an active deck-bottom redirect. */
export function sendToDusk(state, cardId) {
  if (state.turnFlags.redirectDuskToDeckBottom) {
    state.zones.deck.push(cardId); // bottom of deck
  } else {
    state.zones.dusk.push(cardId);
    state.cardsToDuskThisTurn.push(cardId);
  }
}

/** Did both a point and an action reach the dusk this turn? (Delve 003, Angst 020) */
export function bothTypesToDuskThisTurn(state) {
  const types = new Set(state.cardsToDuskThisTurn.map(id => getCard(id).type));
  return types.has("point") && types.has("action");
}

/** Put a player's whole hand into the dusk. Returns count. */
export function duskHand(state, playerId) {
  const hand = state.players[playerId].hand;
  const count = hand.length;
  [...hand].forEach(id => sendToDusk(state, id));
  state.players[playerId].hand = [];
  return count;
}

/** Remove a card from the horizon by index. Does NOT send it anywhere — the caller picks the destination. */
export function removeFromHorizon(state, horizonIndex) {
  const [entry] = state.zones.horizon.splice(horizonIndex, 1);
  return entry;
}

/** Remove a card from the horizon and put it into the dusk. */
export function duskFromHorizon(state, horizonIndex) {
  const entry = removeFromHorizon(state, horizonIndex);
  sendToDusk(state, entry.cardId);
  return entry;
}

// ─── Static Effect Queries ────────────────────────────────────────────────────
// "Can't beats can" — restrictions are checked here before any action proceeds.

/** Is ALL card playing locked? (Unstoppable 00) */
export function isHorizonLocked(state, forPlayer) {
  return state.zones.horizon.some(entry => {
    const card = getHorizonEntryCard(entry);
    return card.staticEffects?.some(se =>
      se.type === 'lockHorizon' && (
        se.scope === 'allPlayers' ||
        (se.scope === 'controller' && controllerOf(entry) === forPlayer) ||
        (se.scope === 'opponents' && controllerOf(entry) !== forPlayer)
      )
    );
  });
}

/** Is drawing locked? (Dread 39) */
export function isDrawLocked(state) {
  return state.zones.horizon.some(entry => {
    const card = getHorizonEntryCard(entry);
    return card.staticEffects?.some(se => se.type === 'lockDraw');
  });
}

/** Get the active play cost modifier for a player from horizon static effects. */
export function getHorizonCostModifier(state, forPlayer) {
  let delta = 0;
  for (const entry of state.zones.horizon) {
    const card = getHorizonEntryCard(entry);
    for (const se of card.staticEffects ?? []) {
      if (se.type === 'modifyPlayCost') {
        const isOpponent = controllerOf(entry) !== forPlayer;
        if (se.target === 'opponent' && isOpponent) delta += se.amount;
      }
    }
  }
  return delta;
}

/** Is play-from-dusk allowed? (Consult The Past 038) */
export function canPlayFromDusk(state, playerId) {
  if (state.turnFlags.playFromDusk) return true;
  return state.zones.horizon.some(entry => {
    const card = getHorizonEntryCard(entry);
    return card.staticEffects?.some(se =>
      se.type === 'allowPlayFromDusk' && controllerOf(entry) === playerId
    );
  });
}

/** Does With the Sky (28) allow opponent point response right now? */
export function opponentPointResponseAllowed(state) {
  return state.zones.horizon.some(entry => {
    const card = getHorizonEntryCard(entry);
    return card.staticEffects?.some(se => se.type === 'allowOpponentPointResponse');
  });
}

// ─── Cost Calculation ─────────────────────────────────────────────────────────

import { getCard } from '../data/cardDb.js';

function getHorizonEntryCard(entry) {
  return getCard(entry.cardId);
}

/**
 * Does a horizon entry satisfy a horizon-targeting filter
 * ('any' | 'action' | 'point' | 'actionPlayedInResponseToPoint')?
 * Shared by the executor (to decide whether a choice has any legal target)
 * and resolveChoice (to validate the player's pick).
 */
export function horizonEntryMatchesFilter(entry, filter) {
  if (!filter || filter === 'any') return true;
  const card = getCard(entry.cardId);
  // Enlightenment (075) targets by matching energy cost rather than by type.
  if (typeof filter === 'object') {
    return filter.costEquals == null || card.energyCost === filter.costEquals;
  }
  if (filter === 'actionPlayedInResponseToPoint') {
    return card.type === 'action' && entry.respondedToCardType === 'point';
  }
  return card.type === filter; // 'action' | 'point'
}

/** Is there at least one legal target on the horizon for a given filter? */
export function horizonHasTarget(state, filter) {
  return state.zones.horizon.some(e => horizonEntryMatchesFilter(e, filter));
}

export function computeActualCost(state, cardId, playerId, context = {}) {
  const card = getCard(cardId);
  let cost = card.energyCost;

  // Horizon-based modifiers (Efficiency 15, Glacial Pace 19)
  cost += getHorizonCostModifier(state, playerId);

  // Turn flag modifier (Possess Love 83)
  cost += state.turnFlags.allCardsCostLess;

  // Card-specific cost modifiers
  for (const mod of card.costModifiers ?? []) {
    switch (mod.type) {
      case 'discountPerCard': {
        if (mod.zone === 'zeniths') {
          cost -= (pointsOf(state, 'p1') + pointsOf(state, 'p2')) * mod.amount;
          break;
        }
        const zone = mod.zone === 'dusk' ? state.zones.dusk : state.zones.horizon;
        const count = mod.filter === 'any'
          ? zone.length
          : zone.filter(id => {
              const c = typeof id === 'string' ? getCard(id) : getCard(id.cardId);
              return c.type === mod.filter;
            }).length;
        cost -= count * mod.amount;
        break;
      }
      case 'discountIfCondition':
        if (evaluateCondition(state, mod.condition, playerId, context)) {
          cost -= mod.amount;
        }
        break;
      case 'freeIfCondition':
        if (evaluateCondition(state, mod.condition, playerId, context)) {
          cost = 0;
        }
        break;
    }
  }

  return Math.max(0, cost);
}

function evaluateCondition(state, condition, playerId, context) {
  switch (condition) {
    case 'anyPlayerAtFourPoints':
      return pointsOf(state, 'p1') >= 4 || pointsOf(state, 'p2') >= 4;
    case 'opponentAtFourPoints':      // Mercy (014)
      return pointsOf(state, opponent(playerId)) >= 4;
    case 'selfAtFourPoints':          // Beget Advantage (034)
      return pointsOf(state, playerId) >= 4;
    case 'bothTypesToDuskThisTurn':   // Delve (003)
      return bothTypesToDuskThisTurn(state);
    case 'revealThreePointsFromHand': // Dawn (049)
      return state.players[playerId].hand.filter(id => getCard(id).type === 'point').length >= 3;
    case 'playedBothTypesThisTurn': {
      const types = new Set(state.cardsPlayedThisTurn.map(p => getCard(p.cardId).type));
      return types.has('point') && types.has('action');
    }
    case 'drewTwoOrMoreThisTurn':
      return state.cardsDrawnThisTurn[playerId] >= 2;
    case 'opponentPlayedThreeOrMoreThisTurn': {
      const opp = opponent(playerId);
      return state.cardsPlayedThisTurn.filter(p => p.playedBy === opp).length >= 3;
    }
    default:
      return false;
  }
}
