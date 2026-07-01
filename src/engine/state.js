import { ALL_CARD_IDS } from '../data/cardDb.js';

// ─── Choice Triggers ─────────────────────────────────────────────────────────
// The subset of pendingTriggers that the server surfaces to a player as a
// CHOICE_REQUIRED prompt (as opposed to background triggers like
// registerTurnTrigger / endOfTurnTrash that resolve on their own). Single source
// of truth shared by server.advancePendingChoices and the resolution engine.
export const CHOICE_TRIGGER_TYPES = new Set([
  'trashFromHandChoice', 'trashFromStackChoice', 'returnStackCardToHandChoice',
  'stealFromStackChoice', 'gainControlChoice', 'putFromTrashToHandChoice',
  'optionalEffectChoice', 'additionalCost', 'putHandCardOnDeckTop',
  'revealUntilType', 'opponentChoosesOne', 'controllerMovesCardFromStackTarget',
  'lookAtTopN', 'chooseNumber', 'chooseCardToTrashFromRevealedHand',
  'moveFromStackToDeckTop', 'trashUnlessControllerPaysTarget',
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
    priorityPassCount: 0,      // 0/1/2 — when 2, resolve top of stack
    turnNumber: 0,
    cardsPlayedThisTurn: [],   // [{ cardId, playedBy }] in order
    cardsDrawnThisTurn: { p1: 0, p2: 0 },

    players: {
      p1: createPlayerState(),
      p2: createPlayerState(),
    },

    zones: {
      deck:  [],   // CardId[], index 0 = top
      stack: [],   // StackEntry[], index 0 = top (last played)
      trash: [],   // CardId[]
      void:  [],   // CardId[]
    },

    // Active per-turn effect flags (cleared each turn)
    turnFlags: createTurnFlags(),

    // Pending end-of-turn triggers
    pendingTriggers: [],

    // Cards mid-resolution whose trip to the trash is deferred until their
    // effect (including any player choices it spawned) has fully resolved.
    pendingResolutionTrash: [],

    winner: null,
  };
}

export function createPlayerState() {
  return {
    hand:              [],
    points:            0,
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
    playFromTrash:            false,  // Consult the Past (38), Brought Back (72)
    redirectTrashToDeckBottom:false,  // Brought Back (72)
    allCardsCostLess:         0,      // Possess Love (83) — stacks as delta
    lockedPlayer:             null,   // Stifle Speech (52) — playerId locked from playing this turn
    protectNextSelfAction: null, // Injustice (67) — playerId whose next action this turn is protected from action responses
    shareTheLootActive:       false,  // Share the Loot (75)
  };
}

// ─── Stack Entry Factory ──────────────────────────────────────────────────────

export function createStackEntry(cardId, playedBy, meta = {}) {
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

/** Draw up to n cards for a player. Handles void → deck reshuffle. */
export function drawCards(state, playerId, n) {
  const drawn = [];
  for (let i = 0; i < n; i++) {
    // Check draw lock (Dread)
    if (isDrawLocked(state)) break;

    if (state.zones.deck.length === 0) {
      if (state.zones.void.length === 0) break; // nothing left
      // Shuffle void into deck
      state.zones.deck = shuffle([...state.zones.void]);
      state.zones.void = [];
    }
    const card = state.zones.deck.shift();
    state.players[playerId].hand.push(card);
    drawn.push(card);
    state.cardsDrawnThisTurn[playerId]++;
  }
  return drawn;
}

/** Move a card from a player's hand to the trash (or deck bottom if Brought Back active). */
export function trashCardFromHand(state, playerId, cardId) {
  const hand = state.players[playerId].hand;
  const idx = hand.indexOf(cardId);
  if (idx === -1) throw new Error(`Card ${cardId} not in ${playerId}'s hand`);
  hand.splice(idx, 1);
  sendToTrash(state, cardId);
}

/** Move a card to the trash, respecting Brought Back redirect. */
export function sendToTrash(state, cardId) {
  if (state.turnFlags.redirectTrashToDeckBottom) {
    state.zones.deck.push(cardId); // bottom of deck
  } else {
    state.zones.trash.push(cardId);
  }
}

/** Trash all cards in a player's hand. Returns count. */
export function trashHand(state, playerId) {
  const hand = state.players[playerId].hand;
  const count = hand.length;
  [...hand].forEach(id => sendToTrash(state, id));
  state.players[playerId].hand = [];
  return count;
}

/** Remove a card from the stack by index. Does NOT send to trash — caller handles destination. */
export function removeFromStack(state, stackIndex) {
  const [entry] = state.zones.stack.splice(stackIndex, 1);
  return entry;
}

/** Remove a card from the stack and send it to trash. */
export function trashFromStack(state, stackIndex) {
  const entry = removeFromStack(state, stackIndex);
  sendToTrash(state, entry.cardId);
  return entry;
}

// ─── Static Effect Queries ────────────────────────────────────────────────────
// "Can't beats can" — restrictions are checked here before any action proceeds.

/** Is ALL card playing locked? (Unstoppable 00) */
export function isStackLocked(state, forPlayer) {
  return state.zones.stack.some(entry => {
    const card = getStackEntryCard(entry);
    return card.staticEffects?.some(se =>
      se.type === 'lockStack' &&
      (se.scope === 'allPlayers' || (se.scope === 'controller' && controllerOf(entry) === forPlayer))
    );
  });
}

/** Is drawing locked? (Dread 39) */
export function isDrawLocked(state) {
  return state.zones.stack.some(entry => {
    const card = getStackEntryCard(entry);
    return card.staticEffects?.some(se => se.type === 'lockDraw');
  });
}

/** Get the active play cost modifier for a player from stack static effects. */
export function getStackCostModifier(state, forPlayer) {
  let delta = 0;
  for (const entry of state.zones.stack) {
    const card = getStackEntryCard(entry);
    for (const se of card.staticEffects ?? []) {
      if (se.type === 'modifyPlayCost') {
        const isOpponent = controllerOf(entry) !== forPlayer;
        if (se.target === 'opponent' && isOpponent) delta += se.amount;
      }
    }
  }
  return delta;
}

/** Is play-from-trash allowed? (Consult the Past 38, Brought Back 72) */
export function canPlayFromTrash(state, playerId) {
  if (state.turnFlags.playFromTrash) return true;
  return state.zones.stack.some(entry => {
    const card = getStackEntryCard(entry);
    return card.staticEffects?.some(se =>
      se.type === 'allowPlayFromTrash' && controllerOf(entry) === playerId
    );
  });
}

/** Does With the Sky (28) allow opponent point response right now? */
export function opponentPointResponseAllowed(state) {
  return state.zones.stack.some(entry => {
    const card = getStackEntryCard(entry);
    return card.staticEffects?.some(se => se.type === 'allowOpponentPointResponse');
  });
}

// ─── Cost Calculation ─────────────────────────────────────────────────────────

import { getCard } from '../data/cardDb.js';

function getStackEntryCard(entry) {
  return getCard(entry.cardId);
}

/**
 * Does a stack entry satisfy a stack-targeting filter
 * ('any' | 'action' | 'point' | 'actionPlayedInResponseToPoint')?
 * Shared by the executor (to decide whether a choice has any legal target)
 * and resolveChoice (to validate the player's pick).
 */
export function stackEntryMatchesFilter(entry, filter) {
  if (!filter || filter === 'any') return true;
  const card = getCard(entry.cardId);
  if (filter === 'actionPlayedInResponseToPoint') {
    return card.type === 'action' && entry.respondedToCardType === 'point';
  }
  return card.type === filter; // 'action' | 'point'
}

/** Is there at least one legal target on the stack for a given filter? */
export function stackHasTarget(state, filter) {
  return state.zones.stack.some(e => stackEntryMatchesFilter(e, filter));
}

export function computeActualCost(state, cardId, playerId, context = {}) {
  const card = getCard(cardId);
  let cost = card.energyCost;

  // Stack-based modifiers (Efficiency 15, Glacial Pace 19)
  cost += getStackCostModifier(state, playerId);

  // Turn flag modifier (Possess Love 83)
  cost += state.turnFlags.allCardsCostLess;

  // Card-specific cost modifiers
  for (const mod of card.costModifiers ?? []) {
    switch (mod.type) {
      case 'discountPerCard': {
        const zone = mod.zone === 'trash' ? state.zones.trash : state.zones.stack;
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
      return state.players.p1.points >= 4 || state.players.p2.points >= 4;
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
