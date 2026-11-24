import { readFileSync } from 'node:fs';
import { describe, test, expect } from './helpers.js';
import {
  createGameState, createHorizonEntry, initDeck, drawCards, pointsOf,
  computeActualCost, duskFromHorizon, pendingEnergyPayment,
} from '../src/engine/state.js';
import {
  startGame, playCard, passPriority, energizeCard, endTurn, riseTopOfHorizon,
  checkSunset, isLivePriorityWindow,
} from '../src/engine/game.js';
import { validatePlay } from '../src/engine/validation.js';
import { resolveChoice } from '../src/engine/choices.js';
import { executeOnPlayEffects, flushHorizonTriggers } from '../src/effects/executor.js';
import { advancePendingChoices, buildChoicePrompt } from '../src/server.js';
import { ALL_CARD_IDS, getCard } from '../src/data/cardDb.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Card ids are ordered: 000–049 are points, 050–104 are actions. These are
// deliberately plain cards — no static effects that would change play legality.
const POINT = '02';    // Momentum       — gain 4 energy
const POINT_B = '04';  // Inquire        — draw a card
const ACTION = '45';   // Bounce Back    — return a point on the horizon
const ACTION_B = '46'; // Regret         — put a card on top of the deck
const LOCK_POINT = '00'; // Pretty Privilege — opponents cannot play cards

function freshGame() {
  const state = createGameState();
  initDeck(state);
  const events = startGame(state);
  return { state, events };
}

function eventTypes(events) {
  return events.map(e => e.type);
}

/** Put a specific card in a player's hand, taking it out of the deck. */
function giveCard(state, playerId, cardId) {
  const di = state.zones.deck.indexOf(cardId);
  if (di !== -1) state.zones.deck.splice(di, 1);
  if (!state.players[playerId].hand.includes(cardId)) {
    state.players[playerId].hand.push(cardId);
  }
}

function setEnergy(state, playerId, amount) {
  state.players[playerId].energy = amount;
}

/** Total cards across every zone — nothing should ever be created or lost. */
function countAllCards(state) {
  return state.zones.deck.length
    + state.zones.dusk.length
    + state.zones.horizon.length
    + state.players.p1.hand.length + state.players.p2.hand.length
    + state.players.p1.zenith.length + state.players.p2.zenith.length;
}

// ─── Client prompt coverage ───────────────────────────────────────────────────

describe('Client prompt coverage', () => {
  // Guard against the "choice resolves in the engine but the client has no prompt
  // / never receives the hidden data" class of bug. Every choice type that can
  // surface must have a ChoicePrompt branch.
  test('every surfaceable choice type has a ChoicePrompt branch', () => {
    const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
    const server = read('server.js');
    const state = read('engine/state.js');
    const choices = read('engine/choices.js');
    const prompt = read('ui/ChoicePrompt.jsx');

    const setBlock = state.match(/CHOICE_TRIGGER_TYPES = new Set\(\[([\s\S]*?)\]\)/);
    expect(setBlock).not.toBe(null);
    const triggers = [...setBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const mapBlock = server.match(/const typeMap = \{([\s\S]*?)\};/);
    expect(mapBlock).not.toBe(null);
    const typeMap = {};
    for (const m of mapBlock[1].matchAll(/(\w+):\s*'([^']+)'/g)) typeMap[m[1]] = m[2];

    const surfaced = new Set(triggers.map((t) => typeMap[t] ?? t));
    for (const m of choices.matchAll(/pendingChoice\s*=\s*\{\s*type:\s*'([^']+)'/g)) surfaced.add(m[1]);

    const handled = new Set([...prompt.matchAll(/type === '([^']+)'/g)].map((m) => m[1]));

    const missing = [...surfaced].filter((t) => !handled.has(t)).sort();
    expect(missing).toEqual([]);
  });
});

// ─── The card set ─────────────────────────────────────────────────────────────

describe('The deck', () => {
  test('holds 90 cards: 45 actions and 45 points', () => {
    expect(ALL_CARD_IDS).toHaveLength(90);
    const points = ALL_CARD_IDS.filter(id => getCard(id).type === 'point');
    const actions = ALL_CARD_IDS.filter(id => getCard(id).type === 'action');
    expect(points).toHaveLength(45);
    expect(actions).toHaveLength(45);
  });

  test('ids 00-44 are points and 45-89 are actions', () => {
    expect(getCard('00').type).toBe('point');
    expect(getCard('44').type).toBe('point');
    expect(getCard('45').type).toBe('action');
    expect(getCard('89').type).toBe('action');
  });

  test('every card has a name, a cost and rules text', () => {
    for (const id of ALL_CARD_IDS) {
      const card = getCard(id);
      expect(typeof card.name === 'string' && card.name.length > 0).toBe(true);
      expect(Number.isInteger(card.energyCost)).toBe(true);
      expect(typeof card.effectText === 'string' && card.effectText.length > 0).toBe(true);
    }
  });
});

// ─── Initialisation ───────────────────────────────────────────────────────────

describe('Game initialisation', () => {
  test('deals five cards each and leaves 80 in the deck', () => {
    const { state } = freshGame();
    expect(state.players.p1.hand).toHaveLength(5);
    expect(state.players.p2.hand).toHaveLength(5);
    expect(state.zones.deck).toHaveLength(80);
    expect(countAllCards(state)).toBe(90);
  });

  test('starts with empty zeniths and an empty dusk', () => {
    const { state } = freshGame();
    expect(state.players.p1.zenith).toHaveLength(0);
    expect(state.players.p2.zenith).toHaveLength(0);
    expect(state.zones.dusk).toHaveLength(0);
    expect(pointsOf(state, 'p1')).toBe(0);
  });

  test('a two-player game gets no reshuffles, so the deck depletes exactly once', () => {
    const { state } = freshGame();
    expect(state.reshufflesRemaining).toBe(0);
  });

  test('the old trash and energize zones are gone — the dusk replaces both', () => {
    const { state } = freshGame();
    expect(Object.keys(state.zones).sort()).toEqual(['deck', 'dusk', 'horizon']);
  });
});

// ─── Energizing ──────────────────────────────────────────────────────────────────

describe('Energizing', () => {
  test('puts the card in the dusk and gives 3 energy', () => {
    const { state } = freshGame();
    const card = state.players.p1.hand[0];
    const events = energizeCard(state, 'p1', card);

    expect(eventTypes(events)).toContain('CARD_ENERGIZED');
    expect(state.players.p1.energy).toBe(3);
    expect(state.zones.dusk).toContain(card);
    expect(state.players.p1.hand).not.toContain(card);
  });

  test('stacks: energizing three cards gives 9 energy', () => {
    const { state } = freshGame();
    for (const card of [...state.players.p1.hand].slice(0, 3)) energizeCard(state, 'p1', card);
    expect(state.players.p1.energy).toBe(9);
    expect(state.zones.dusk).toHaveLength(3);
  });
});

// ─── Energizing to fund an owed payment ──────────────────────────────────────────
//
// A ransom is paid by the targeted card's CONTROLLER, who is usually not the
// player holding priority and whose energy was wiped at the last end of turn.
// Without this, "unless its controller pays 1 energy" resolves as unconditional
// removal rather than as the choice the card describes.

describe('Energizing to fund an owed payment', () => {
  /** Drive Poke (097) to the point where `debtor` is being asked for a ransom. */
  function ransomPending({ pokeCaster }) {
    const { state } = freshGame();
    giveCard(state, 'p1', ACTION);        // p1 puts an action on the horizon
    giveCard(state, pokeCaster, '84');
    setEnergy(state, 'p1', 9);
    setEnergy(state, 'p2', 9);
    playCard(state, 'p1', ACTION);

    let target = ACTION;
    if (pokeCaster === 'p1') {
      // p1 needs an opponent-controlled action to point Poke at.
      giveCard(state, 'p2', ACTION_B);
      playCard(state, 'p2', ACTION_B);
      target = ACTION_B;
    }
    playCard(state, pokeCaster, '84');

    // The caster's opponent passes, which is all it takes: Poke rises and its
    // text runs. The caster never passes their own card.
    passPriority(state, opponentOf(pokeCaster));
    advancePendingChoices(state);

    // Step 1: the caster picks which action on the horizon to ransom.
    const idx = state.zones.horizon.findIndex(e => e.cardId === target);
    resolveChoice(state, pokeCaster, { horizonIndex: idx });
    return { state, target };
  }

  const opponentOf = p => (p === 'p1' ? 'p2' : 'p1');

  test('a broke debtor energizes to pay the ransom and keeps the card', () => {
    const { state, target } = ransomPending({ pokeCaster: 'p2' });
    expect(state.pendingChoice.type).toBe('duskUnlessControllerPays');
    expect(state.pendingChoice.player).toBe('p1');

    setEnergy(state, 'p1', 0);
    expect(pendingEnergyPayment(state, 'p1')).toBe(true);

    const events = energizeCard(state, 'p1', state.players.p1.hand[0]);
    expect(eventTypes(events)).toContain('CARD_ENERGIZED');
    expect(state.players.p1.energy).toBe(3);

    const { error } = resolveChoice(state, 'p1', { pay: true });
    expect(error).toBe(null);
    expect(state.players.p1.energy).toBe(2);
    expect(state.zones.horizon.some(e => e.cardId === target)).toBe(true);
  });

  test('the debtor may energize even while the opponent holds priority', () => {
    const { state, target } = ransomPending({ pokeCaster: 'p1' });
    expect(state.pendingChoice.player).toBe('p2');
    // The whole point: p2 owes the ransom at a moment that is not their priority.
    expect(state.activePlayer).not.toBe('p2');

    setEnergy(state, 'p2', 0);
    expect(eventTypes(energizeCard(state, 'p2', state.players.p2.hand[0]))).toContain('CARD_ENERGIZED');

    const { error } = resolveChoice(state, 'p2', { pay: true });
    expect(error).toBe(null);
    expect(state.zones.horizon.some(e => e.cardId === target)).toBe(true);
  });

  test('declining still sends the card to the dusk', () => {
    const { state, target } = ransomPending({ pokeCaster: 'p2' });
    setEnergy(state, 'p1', 0);
    resolveChoice(state, 'p1', { pay: false });
    expect(state.zones.horizon.some(e => e.cardId === target)).toBe(false);
    expect(state.zones.dusk).toContain(target);
  });

  test('energizing without priority is still refused when nothing is owed', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', ACTION);
    setEnergy(state, 'p1', 9);
    playCard(state, 'p1', ACTION);        // priority passes to p2
    expect(state.activePlayer).toBe('p2');
    expect(pendingEnergyPayment(state, 'p1')).toBe(false);

    const events = energizeCard(state, 'p1', state.players.p1.hand[0]);
    expect(events[0].type).toBe('ERROR');
    expect(events[0].code).toBe('NOT_YOUR_PRIORITY');
  });

  test('only energy ransoms open the hand — a dusk ransom does not', () => {
    const { state } = freshGame();
    state.pendingChoice = {
      type: 'duskUnlessControllerPays', player: 'p1',
      ransom: { type: 'giveFromDuskToCaster', count: 3 },
    };
    expect(pendingEnergyPayment(state, 'p1')).toBe(false);
    // ...and never for the player who is not being asked.
    state.pendingChoice.ransom = { type: 'payEnergy', amount: 1 };
    expect(pendingEnergyPayment(state, 'p1')).toBe(true);
    expect(pendingEnergyPayment(state, 'p2')).toBe(false);
  });

  test("Auction/Bid's pay-any-amount also opens the hand", () => {
    const { state } = freshGame();
    state.pendingChoice = {
      type: 'additionalCost', player: 'p2', cost: { type: 'payAnyAmount' }, cardId: '40',
    };
    expect(pendingEnergyPayment(state, 'p2')).toBe(true);
    state.pendingChoice.cost = { type: 'duskFromHand', count: 1 };
    expect(pendingEnergyPayment(state, 'p2')).toBe(false);
  });
});

// ─── Play timing ──────────────────────────────────────────────────────────────

describe('Play timing', () => {
  test('a point can be played on your turn while the horizon is empty', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    setEnergy(state, 'p1', 10);
    expect(validatePlay(state, 'p1', POINT)).toBeNull();
  });

  test('a point cannot be played while a card is on the horizon', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    giveCard(state, 'p1', POINT_B);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', POINT);
    expect(validatePlay(state, 'p1', POINT_B)).toMatch(/horizon is empty/);
  });

  test('a point cannot be played on your opponent\'s turn', () => {
    const { state } = freshGame();
    giveCard(state, 'p2', POINT);
    setEnergy(state, 'p2', 10);
    expect(validatePlay(state, 'p2', POINT)).toMatch(/only play points on your own turn/);
  });

  test('an action can be played in response to an opponent\'s card', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    giveCard(state, 'p2', ACTION);
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);
    playCard(state, 'p1', POINT);           // p1's point is now on top
    expect(state.activePlayer).toBe('p2');
    expect(validatePlay(state, 'p2', ACTION)).toBeNull();
  });

  test('you cannot respond to your own card', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    giveCard(state, 'p1', ACTION);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', POINT);
    expect(validatePlay(state, 'p1', ACTION)).toMatch(/cannot respond to your own card/);
  });

  test('an action cannot be played on the opponent\'s turn with an empty horizon', () => {
    const { state } = freshGame();
    giveCard(state, 'p2', ACTION);
    setEnergy(state, 'p2', 20);
    expect(validatePlay(state, 'p2', ACTION)).toMatch(/only play action cards/);
  });

  test('Pretty Privilege locks opponents out but not its own controller', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', LOCK_POINT);
    giveCard(state, 'p1', ACTION);
    giveCard(state, 'p2', ACTION_B);
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);
    playCard(state, 'p1', LOCK_POINT);

    expect(validatePlay(state, 'p2', ACTION_B)).toMatch(/cannot be played/);
    // The controller is unaffected by their own lock.
    expect(validatePlay(state, 'p1', ACTION)).not.toMatch(/Cards cannot be played/);
  });

  test('you cannot play a card you cannot pay for', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    setEnergy(state, 'p1', 0);
    expect(validatePlay(state, 'p1', POINT)).toMatch(/Not enough energy/);
  });
});

// ─── Rising ───────────────────────────────────────────────────────────────────

describe('Rising', () => {
  test('a risen point goes into its controller\'s zenith and scores a point', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', POINT);

    const events = riseTopOfHorizon(state);

    expect(eventTypes(events)).toContain('CARD_TO_ZENITH');
    expect(state.players.p1.zenith).toContain(POINT);
    expect(state.zones.dusk).not.toContain(POINT);
    expect(pointsOf(state, 'p1')).toBe(1);
    expect(state.zones.horizon).toHaveLength(0);
  });

  test('a risen action goes into the dusk, not a zenith', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', ACTION);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', ACTION);

    const events = riseTopOfHorizon(state);

    expect(eventTypes(events)).toContain('CARD_TO_DUSK');
    expect(state.zones.dusk).toContain(ACTION);
    expect(state.players.p1.zenith).toHaveLength(0);
  });

  test('a point rises into the zenith of whoever controls it, not whoever owns it', () => {
    const { state } = freshGame();
    const entry = createHorizonEntry(POINT, 'p1');
    entry.controlledBy = 'p2';
    state.zones.horizon.unshift(entry);

    riseTopOfHorizon(state);

    expect(state.players.p2.zenith).toContain(POINT);
    expect(state.players.p1.zenith).toHaveLength(0);
  });

  test('the horizon is last-in-first-out: the card played last rises first', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    giveCard(state, 'p2', ACTION);
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);
    playCard(state, 'p1', POINT);
    playCard(state, 'p2', ACTION);       // played second, so on top

    expect(state.zones.horizon[0].cardId).toBe(ACTION);
    riseTopOfHorizon(state);
    expect(state.zones.dusk).toContain(ACTION);
    expect(state.zones.horizon[0].cardId).toBe(POINT);   // the point is still waiting
  });

  test('a card leaves the horizon before its text runs', () => {
    // Rulebook p4: put it into the dusk / your zenith, THEN do the card's text —
    // so a rising card can never be a target of its own effect.
    const { state } = freshGame();
    giveCard(state, 'p1', ACTION);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', ACTION);

    const events = riseTopOfHorizon(state);
    const order = eventTypes(events);
    expect(order.indexOf('CARD_TO_DUSK')).toBeGreaterThan(order.indexOf('CARD_RISING') - 1);
    expect(state.zones.horizon).toHaveLength(0);
  });

  test('the opponent passing alone makes the top card rise', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', POINT);

    // Rulebook p4: "If the opponent passes, that card rises." One pass, not two
    // — the controller never passes their own card.
    passPriority(state, 'p2');

    expect(state.players.p1.zenith).toContain(POINT);
    expect(state.zones.horizon).toHaveLength(0);
  });

  test('the controller never gets priority over their own card', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', POINT);

    expect(state.activePlayer).toBe('p2');
    const events = passPriority(state, 'p1');
    expect(eventTypes(events)).toContain('ERROR');
    expect(state.zones.horizon).toHaveLength(1);
  });

  test('after a rise, priority goes to the new top card\'s opponent, not the turn player', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    giveCard(state, 'p2', ACTION);
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);

    playCard(state, 'p1', POINT);     // p1's point, bottom of the horizon
    playCard(state, 'p2', ACTION);    // p2 responds — now the top

    passPriority(state, 'p1');        // p1 declines to respond; the action rises

    // The point below is p1's, so it is p2 who may respond to it — even though
    // it is p1's turn.
    expect(state.zones.horizon).toHaveLength(1);
    expect(state.turn).toBe('p1');
    expect(state.activePlayer).toBe('p2');
  });

  test('passing with an empty horizon ends your turn', () => {
    const { state } = freshGame();
    expect(state.turn).toBe('p1');

    const events = passPriority(state, 'p1');

    expect(eventTypes(events)).toContain('TURN_ENDED');
    expect(state.turn).toBe('p2');
  });
});

// ─── Priority ─────────────────────────────────────────────────────────────────

describe('Priority', () => {
  test('you hold a live window on your own turn with an empty horizon', () => {
    const { state } = freshGame();
    expect(isLivePriorityWindow(state, 'p1')).toBe(true);
    expect(isLivePriorityWindow(state, 'p2')).toBe(false);
  });

  test('you hold a live window when an opponent\'s card is on top of the horizon', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', POINT);
    expect(isLivePriorityWindow(state, 'p2')).toBe(true);
    expect(isLivePriorityWindow(state, 'p1')).toBe(false);
  });
});

// ─── End of turn ──────────────────────────────────────────────────────────────

describe('End of turn', () => {
  test('wipes leftover energy for both players', () => {
    const { state } = freshGame();
    setEnergy(state, 'p1', 7);
    setEnergy(state, 'p2', 4);
    endTurn(state);
    expect(state.players.p1.energy).toBe(0);
    expect(state.players.p2.energy).toBe(0);
  });

  test('refills the turn player back up to five cards', () => {
    const { state } = freshGame();
    state.players.p1.hand = [state.players.p1.hand[0]];
    endTurn(state);
    expect(state.players.p1.hand).toHaveLength(5);
  });

  test('there is no maximum hand size — a big hand is not trimmed', () => {
    const { state } = freshGame();
    drawCards(state, 'p1', 3);
    expect(state.players.p1.hand).toHaveLength(8);
    endTurn(state);
    expect(state.players.p1.hand).toHaveLength(8);
  });

  test('passes the turn to the other player', () => {
    const { state } = freshGame();
    endTurn(state);
    expect(state.turn).toBe('p2');
    expect(state.turnNumber).toBe(2);
  });

  test('the dusk persists across turns — it is one pile all game', () => {
    const { state } = freshGame();
    const card = state.players.p1.hand[0];
    energizeCard(state, 'p1', card);
    endTurn(state);
    expect(state.zones.dusk).toContain(card);
  });

  test('cannot end the turn while the horizon still has cards', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', POINT);
    const events = endTurn(state);
    expect(events[0].code).toBe('HORIZON_NOT_EMPTY');
  });
});

// ─── Reshuffles ───────────────────────────────────────────────────────────────

describe('Reshuffles', () => {
  test('with a reshuffle available, an empty deck is refilled from the dusk', () => {
    const { state } = freshGame();
    state.zones.deck = [];
    state.zones.dusk = ['00', '01', '02'];
    state.reshufflesRemaining = 1;

    const drawn = drawCards(state, 'p1', 2);

    expect(drawn).toHaveLength(2);
    expect(state.reshufflesRemaining).toBe(0);
    expect(state.zones.dusk).toHaveLength(0);
    expect(state.zones.deck).toHaveLength(1);
  });

  test('with no reshuffles left, drawing from an empty deck simply stops', () => {
    const { state } = freshGame();
    state.zones.deck = [];
    state.zones.dusk = ['00', '01'];
    state.reshufflesRemaining = 0;

    const drawn = drawCards(state, 'p1', 2);

    expect(drawn).toHaveLength(0);
    expect(state.zones.dusk).toHaveLength(2);
  });

  test('a zenith is never reshuffled back into the deck', () => {
    const { state } = freshGame();
    state.zones.deck = [];
    state.zones.dusk = ['00'];
    state.players.p1.zenith = ['01', '02'];
    state.reshufflesRemaining = 1;

    drawCards(state, 'p1', 1);

    expect(state.players.p1.zenith).toEqual(['01', '02']);
  });
});

// ─── Sunset ───────────────────────────────────────────────────────────────────

describe('Sunset', () => {
  function spentDeck(state) {
    state.zones.deck = [];
    state.reshufflesRemaining = 0;
  }

  test('ends the game once the deck is spent', () => {
    const { state } = freshGame();
    spentDeck(state);
    const events = checkSunset(state);
    expect(eventTypes(events)).toContain('SUNSET');
    expect(eventTypes(events)).toContain('GAME_OVER');
    expect(state.phase).toBe('ended');
  });

  test('the player with more points in their zenith wins', () => {
    const { state } = freshGame();
    spentDeck(state);
    state.players.p1.zenith = ['00', '01', '02'];
    state.players.p2.zenith = ['03'];
    checkSunset(state);
    expect(state.winner).toBe('p1');
  });

  test('an equal number of points is a draw', () => {
    const { state } = freshGame();
    spentDeck(state);
    state.players.p1.zenith = ['00'];
    state.players.p2.zenith = ['01'];
    checkSunset(state);
    expect(state.winner).toBe('draw');
  });

  test('cards left on the horizon go to the dusk and never rise', () => {
    const { state } = freshGame();
    spentDeck(state);
    state.zones.horizon = [createHorizonEntry(POINT, 'p1'), createHorizonEntry(ACTION_B, 'p2')];

    checkSunset(state);

    expect(state.zones.horizon).toHaveLength(0);
    expect(state.zones.dusk).toContain(POINT);
    expect(state.zones.dusk).toContain(ACTION_B);
    // The stranded point did NOT rise, so it never reached a zenith.
    expect(state.players.p1.zenith).not.toContain(POINT);
  });

  test('the current card still finishes rising before the sun sets', () => {
    const { state } = freshGame();
    spentDeck(state);
    state.zones.horizon = [createHorizonEntry(POINT, 'p1')];

    const events = riseTopOfHorizon(state);

    expect(state.players.p1.zenith).toContain(POINT);   // banked before scoring
    expect(eventTypes(events)).toContain('SUNSET');
    expect(state.winner).toBe('p1');
  });

  test('the end-of-turn refill is what usually triggers Sunset', () => {
    const { state } = freshGame();
    state.zones.deck = ['00'];
    state.reshufflesRemaining = 0;
    state.players.p1.hand = [];

    const events = endTurn(state);

    expect(state.zones.deck).toHaveLength(0);
    expect(eventTypes(events)).toContain('SUNSET');
    expect(state.phase).toBe('ended');
  });

  test('Sunset does not fire twice', () => {
    const { state } = freshGame();
    spentDeck(state);
    checkSunset(state);
    const again = checkSunset(state);
    expect(again).toHaveLength(0);
  });
});

// ─── Whole-game integrity ─────────────────────────────────────────────────────

describe('Whole-game integrity', () => {
  test('a full game reaches Sunset without creating or losing a card', () => {
    const { state } = freshGame();
    let guard = 0;

    while (state.phase === 'active' && guard++ < 3000) {
      const me = state.turn;
      if (state.activePlayer !== me) { passPriority(state, state.activePlayer); continue; }

      // Energize two cards for energy, then play the cheapest affordable point.
      for (const id of [...state.players[me].hand].slice(0, 2)) energizeCard(state, me, id);
      const affordable = state.players[me].hand
        .map(id => getCard(id))
        .filter(c => c.type === 'point' && c.energyCost <= state.players[me].energy)
        .sort((a, b) => a.energyCost - b.energyCost)[0];
      if (affordable) {
        playCard(state, me, affordable.id);
        while (state.phase === 'active' && state.zones.horizon.length > 0) {
          passPriority(state, state.activePlayer);
        }
      }
      if (state.phase !== 'active') break;
      passPriority(state, state.activePlayer);
      if (state.phase === 'active' && state.turn === me) passPriority(state, state.activePlayer);
    }

    expect(state.phase).toBe('ended');
    expect(state.zones.deck).toHaveLength(0);
    expect(state.zones.horizon).toHaveLength(0);
    expect(countAllCards(state)).toBe(90);
    expect(['p1', 'p2', 'draw']).toContain(state.winner);
  });

  test('every card in a zenith is a point card', () => {
    const { state } = freshGame();
    let guard = 0;
    while (state.phase === 'active' && guard++ < 3000) {
      const me = state.turn;
      if (state.activePlayer !== me) { passPriority(state, state.activePlayer); continue; }
      for (const id of [...state.players[me].hand].slice(0, 2)) energizeCard(state, me, id);
      const pt = state.players[me].hand
        .map(id => getCard(id))
        .filter(c => c.type === 'point' && c.energyCost <= state.players[me].energy)[0];
      if (pt) {
        playCard(state, me, pt.id);
        while (state.phase === 'active' && state.zones.horizon.length > 0) {
          passPriority(state, state.activePlayer);
        }
      }
      if (state.phase !== 'active') break;
      passPriority(state, state.activePlayer);
      if (state.phase === 'active' && state.turn === me) passPriority(state, state.activePlayer);
    }

    const zenithCards = [...state.players.p1.zenith, ...state.players.p2.zenith];
    expect(zenithCards.every(id => getCard(id).type === 'point')).toBe(true);
    expect(zenithCards.length).toBeGreaterThan(0);
  });
});

// ─── Card effects ─────────────────────────────────────────────────────────────

describe('Card effects', () => {
  // Drive a card's text by putting it on the horizon and letting it rise.
  function rise(state, cardId, player = 'p1') {
    state.zones.horizon.unshift(createHorizonEntry(cardId, player));
    const events = riseTopOfHorizon(state);
    advancePendingChoices(state);
    return events;
  }

  test('Abstract Embrace (001) banks a point out of the dusk into your zenith', () => {
    const { state } = freshGame();
    state.zones.dusk = ['02', '45'];
    rise(state, '01');
    expect(state.pendingChoice.type).toBe('putPointFromDuskIntoZenith');
    resolveChoice(state, 'p1', { cardId: '02' });
    expect(state.players.p1.zenith).toContain('02');
    expect(state.zones.dusk).not.toContain('02');
  });

  test('Abstract Embrace (001) is skipped when the dusk holds no point', () => {
    const { state } = freshGame();
    state.zones.dusk = ['45', '46'];
    const events = rise(state, '01');
    expect(eventTypes(events)).toContain('NO_VALID_TARGETS');
    expect(state.pendingChoice).toBeNull();
  });

  test('Change of Luck (068) banks a point from the horizon without it rising', () => {
    const { state } = freshGame();
    state.zones.horizon.unshift(createHorizonEntry('02', 'p2'));
    rise(state, '60');
    expect(state.pendingChoice.type).toBe('putPointFromHorizonIntoZenith');
    resolveChoice(state, 'p1', { horizonIndex: 0 });
    expect(state.players.p1.zenith).toContain('02');
    expect(state.players.p2.zenith).not.toContain('02');
    expect(state.zones.horizon).toHaveLength(0);
  });

  test('Trickle Down Economics (027) takes the opponent leftover energy', () => {
    const { state } = freshGame();
    state.players.p1.energy = 2;
    state.players.p2.energy = 7;
    const entry = createHorizonEntry('25', 'p1');
    state.zones.horizon.unshift(entry);
    executeOnPlayEffects(state, entry);
    expect(state.players.p2.energy).toBe(0);
    expect(state.players.p1.energy).toBe(9);
  });

  test('Anxiety (073) dusks the top of the horizon with no choice', () => {
    const { state } = freshGame();
    state.zones.horizon.unshift(createHorizonEntry('02', 'p2'));
    rise(state, '64');
    expect(state.zones.dusk).toContain('02');
    expect(state.pendingChoice).toBeNull();
  });

  test('Beseech For Gains (085) empties you out, then the opponent refills you', () => {
    const { state } = freshGame();
    state.players.p1.energy = 7;
    state.players.p1.hand = ['02', '04', '45'];
    state.zones.dusk = ['46', '47'];   // so the dusk can actually cover five
    rise(state, '74');

    expect(state.players.p1.energy).toBe(0);
    expect(state.players.p1.hand).toHaveLength(0);
    for (const id of ['02', '04', '45']) expect(state.zones.dusk).toContain(id);

    // The opponent picks, the caster receives. Dusking your own hand is what
    // makes five cards available in the first place.
    expect(state.pendingChoice.type).toBe('opponentChoosesFromDusk');
    expect(state.pendingChoice.player).toBe('p2');
    expect(state.pendingChoice.count).toBe(5);
    const picks = state.zones.dusk.slice(0, 5);
    resolveChoice(state, 'p2', { cardIds: picks });
    expect(state.players.p1.hand).toHaveLength(5);
    for (const id of picks) expect(state.players.p1.hand).toContain(id);
  });

  test('Beseech For Gains (085) settles for a short dusk rather than stalling', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['02'];
    state.zones.dusk = [];
    rise(state, '74');
    // 085 itself plus the one dusked hand card is all there is to give back.
    expect(state.pendingChoice.count).toBe(2);
    resolveChoice(state, 'p2', { cardIds: [...state.zones.dusk].slice(0, 2) });
    expect(state.players.p1.hand).toHaveLength(2);
  });

  test('Cerebral Snuff (87) reveals the opponent hand and lets you pick', () => {
    const { state } = freshGame();
    const before = state.players.p2.hand.length;
    rise(state, '87');
    // v4 made this a choice rather than a random discard.
    advancePendingChoices(state);
    expect(state.pendingChoice.type).toBe('chooseCardToDuskFromRevealedHand');
    expect(state.pendingChoice.player).toBe('p1');

    const taken = state.players.p2.hand[0];
    resolveChoice(state, 'p1', { cardId: taken });
    expect(state.players.p2.hand).toHaveLength(before - 1);
    expect(state.zones.dusk).toContain(taken);
  });

  test('Delve (003) costs 2 less once you have energized a point and an action', () => {
    const { state } = freshGame();
    const me = state.activePlayer;
    state.players[me].hand = ['02', '45'];
    expect(computeActualCost(state, '03', me)).toBe(6);
    energizeCard(state, me, '02');
    expect(computeActualCost(state, '03', me)).toBe(6);
    energizeCard(state, me, '45');
    expect(computeActualCost(state, '03', me)).toBe(4);
  });

  test("Light's Guidance (57) costs 1 less per point in YOUR zenith only", () => {
    const { state } = freshGame();
    expect(computeActualCost(state, '57', 'p1')).toBe(5);
    // The opponent's zenith used to count too; the v4 text narrowed it.
    state.players.p2.zenith = ['01', '02', '04'];
    expect(computeActualCost(state, '57', 'p1')).toBe(5);
    state.players.p1.zenith = ['02', '04'];
    expect(computeActualCost(state, '57', 'p1')).toBe(3);
  });

  test('Paranoia (023) locks its own controller, not the opponent', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '21');
    giveCard(state, 'p1', ACTION);
    giveCard(state, 'p2', ACTION_B);
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);
    playCard(state, 'p1', '21');
    expect(validatePlay(state, 'p1', ACTION)).toMatch(/Cards cannot be played/);
    expect(validatePlay(state, 'p2', ACTION_B)).toBeNull();
  });

  test('every card in the set executes without an unhandled effect', () => {
    // Mirrors cards-sweep.mjs: the engine must have a case for every effect the
    // card data uses, or the card silently does nothing in a real game.
    const unhandled = new Set();
    for (const id of ALL_CARD_IDS) {
      const { state } = freshGame();
      state.players.p1.energy = 20;
      state.zones.dusk.push('02', '45');
      state.zones.horizon.push(createHorizonEntry('05', 'p2', { respondedToCardType: 'point' }));
      const entry = createHorizonEntry(id, 'p1', { respondedToCardIndex: 0, respondedToCardType: 'point' });
      state.zones.horizon.unshift(entry);
      let events = [];
      try {
        events = [...executeOnPlayEffects(state, entry), ...riseTopOfHorizon(state)];
      } catch (err) {
        unhandled.add(`${id} threw: ${err.message}`);
      }
      for (const ev of events) {
        if (ev.type === 'UNHANDLED_EFFECT') unhandled.add(`${id}:${ev.effectType}`);
      }
    }
    // Every card in the set must be executable — no unhandled effects at all.
    expect([...unhandled].sort()).toEqual([]);
  });
});

// ─── Multi-step cards ─────────────────────────────────────────────────────────

describe('Multi-step cards', () => {
  test('Enlightenment (66) ransoms a horizon card for the dusked cost', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['02'];                                 // Momentum, cost 6
    state.zones.horizon.unshift(createHorizonEntry('04', 'p2'));    // the ransom target
    state.zones.horizon.unshift(createHorizonEntry('66', 'p1'));

    riseTopOfHorizon(state);
    advancePendingChoices(state);
    expect(state.pendingChoice.type).toBe('duskFromHandThenMatchCost');

    resolveChoice(state, 'p1', { cardId: '02' });
    advancePendingChoices(state);
    expect(state.zones.dusk).toContain('02');

    // Step 2: the caster targets, then that card's controller pays or loses it.
    expect(state.pendingChoice.type).toBe('duskUnlessControllerPaysTarget');
    const idx = state.zones.horizon.findIndex(e => e.cardId === '04');
    resolveChoice(state, 'p1', { horizonIndex: idx });
    expect(state.pendingChoice.type).toBe('duskUnlessControllerPays');
    expect(state.pendingChoice.player).toBe('p2');
    expect(state.pendingChoice.ransomCost).toBe(6);   // Momentum's cost
  });

  test('Reach Out to the Dark (057) lets the opponent choose which cards you get', () => {
    const { state } = freshGame();
    state.zones.dusk = ['02', '04', '45'];
    state.zones.horizon.unshift(createHorizonEntry('50', 'p1'));

    riseTopOfHorizon(state);
    advancePendingChoices(state);

    // The OPPONENT is the one prompted, even though the caster benefits.
    expect(state.pendingChoice.player).toBe('p2');
    expect(state.pendingChoice.type).toBe('opponentChoosesFromDusk');

    resolveChoice(state, 'p2', { cardIds: ['02', '45'] });
    expect(state.players.p1.hand).toContain('02');
    expect(state.players.p1.hand).toContain('45');
    expect(state.players.p2.hand).not.toContain('02');
  });
});

// ─── Choice prompts only offer legal targets ──────────────────────────────────

describe('Choice prompts', () => {
  // A prompt must never show a card the engine would reject. The legal indexes
  // are computed server-side with the engine's own matcher.
  function promptFor(state, choice) {
    return buildChoicePrompt(state, { player: 'p1', ...choice }, 'p1');
  }

  test('an action-only effect does not offer points', () => {
    const { state } = freshGame();
    state.zones.horizon = [
      createHorizonEntry('02', 'p2'),   // point
      createHorizonEntry('45', 'p2'),   // action
      createHorizonEntry('04', 'p2'),   // point
    ];
    const prompt = promptFor(state, { type: 'duskFromHorizon', filter: 'action' });
    expect(prompt.legalHorizonIndexes).toEqual([1]);
  });

  test('a point-only effect does not offer actions', () => {
    const { state } = freshGame();
    state.zones.horizon = [
      createHorizonEntry('45', 'p2'),   // action
      createHorizonEntry('02', 'p2'),   // point
    ];
    const prompt = promptFor(state, { type: 'duskFromHorizon', filter: 'point' });
    expect(prompt.legalHorizonIndexes).toEqual([1]);
  });

  test('an "any" effect offers every card on the horizon', () => {
    const { state } = freshGame();
    state.zones.horizon = [createHorizonEntry('45', 'p2'), createHorizonEntry('02', 'p2')];
    const prompt = promptFor(state, { type: 'duskFromHorizon', filter: 'any' });
    expect(prompt.legalHorizonIndexes).toEqual([0, 1]);
  });

  test('Change of Luck (068) only offers points', () => {
    const { state } = freshGame();
    state.zones.horizon = [createHorizonEntry('45', 'p2'), createHorizonEntry('02', 'p2')];
    const prompt = promptFor(state, { type: 'putPointFromHorizonIntoZenith', filter: 'point' });
    expect(prompt.legalHorizonIndexes).toEqual([1]);
  });

  test('Deny Hostility (079) only offers actions played in response to a point', () => {
    const { state } = freshGame();
    state.zones.horizon = [
      createHorizonEntry('45', 'p2', { respondedToCardType: 'action' }),  // wrong response
      createHorizonEntry('46', 'p2', { respondedToCardType: 'point' }),   // this one
      createHorizonEntry('02', 'p2'),                                     // a point
    ];
    const prompt = promptFor(state, {
      type: 'duskFromHorizon', filter: 'actionPlayedInResponseToPoint',
    });
    expect(prompt.legalHorizonIndexes).toEqual([1]);
  });

  test('Enlightenment (075) only offers cards matching the dusked cost', () => {
    const { state } = freshGame();
    // 002 Momentum costs 6, 004 Inquire costs 6, 050 Bounce Back costs 1.
    state.zones.horizon = [
      createHorizonEntry('45', 'p2'),
      createHorizonEntry('02', 'p2'),
      createHorizonEntry('04', 'p2'),
    ];
    const prompt = promptFor(state, { type: 'duskFromHorizon', filter: { costEquals: 6 } });
    expect(prompt.legalHorizonIndexes).toEqual([1, 2]);
  });

  test('a non-horizon choice is passed through untouched', () => {
    const { state } = freshGame();
    state.zones.horizon = [createHorizonEntry('02', 'p2')];
    const prompt = promptFor(state, { type: 'duskFromHand', count: 1 });
    expect(prompt.legalHorizonIndexes).toBe(undefined);
  });

  test('the opponent only learns that a choice is pending, not its contents', () => {
    const { state } = freshGame();
    state.zones.horizon = [createHorizonEntry('02', 'p2')];
    const prompt = buildChoicePrompt(state, { player: 'p1', type: 'duskFromHorizon', filter: 'any' }, 'p2');
    expect(prompt.waitingFor).toBe('opponent');
    expect(prompt.legalHorizonIndexes).toBe(undefined);
  });
});

// ─── Prompts never show raw identifiers ───────────────────────────────────────

describe('Prompt wording', () => {
  const promptSrc = readFileSync(new URL('../src/ui/ChoicePrompt.jsx', import.meta.url), 'utf8');

  // Effect types the card data actually offers through an `optional` choice.
  function optionalEffectTypes() {
    const types = new Set();
    for (const id of ALL_CARD_IDS) {
      const walk = (effects) => {
        for (const e of effects ?? []) {
          if (e.type === 'optional') for (const sub of e.effects ?? []) types.add(sub.type);
          if (e.effects) walk(e.effects);
        }
      };
      walk(getCard(id).effects);
      walk(getCard(id).onPlayEffects);
    }
    return [...types];
  }

  test('every effect offered by an optional choice has player-facing wording', () => {
    // Guards the bug where the prompt printed "shuffleDuskIntoDeck" verbatim.
    const described = new Set(
      [...promptSrc.matchAll(/^\s{2}(\w+):\s*\(/gm)].map(m => m[1])
    );
    const missing = optionalEffectTypes().filter(t => !described.has(t)).sort();
    expect(missing).toEqual([]);
  });

  test('every additional cost in the card set has a prompt branch', () => {
    // Without a branch the prompt renders no controls and the player is stuck,
    // unable to pay and unable to decline.
    const costTypes = new Set();
    for (const id of ALL_CARD_IDS) {
      for (const c of getCard(id).additionalCosts ?? []) costTypes.add(c.type);
    }
    const handled = new Set(
      [...promptSrc.matchAll(/costType === '([^']+)'/g)].map(m => m[1])
    );
    const missing = [...costTypes].filter(t => !handled.has(t)).sort();
    expect(missing).toEqual([]);
  });
});

// ─── Cards that watch the dusk ────────────────────────────────────────────────

describe('Cards that watch the dusk', () => {
  test('energizing records the card as having entered the dusk', () => {
    // Energizing is the commonest way anything reaches the dusk, and the main way a
    // POINT gets there at all. It bypassed sendToDusk, so nothing was recorded.
    const { state } = freshGame();
    state.players.p1.hand = ['02', '45'];   // a point and an action
    energizeCard(state, 'p1', '02');
    energizeCard(state, 'p1', '45');
    expect(state.cardsToDuskThisTurn).toEqual(['02', '45']);
  });

  test('Delve (003) costs 2 less once a point and an action have been energized', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['02', '45'];
    expect(computeActualCost(state, '03', 'p1')).toBe(6);
    energizeCard(state, 'p1', '02');
    expect(computeActualCost(state, '03', 'p1')).toBe(6);   // one type only
    energizeCard(state, 'p1', '45');
    expect(computeActualCost(state, '03', 'p1')).toBe(4);
  });

  test('Delve (003) is not discounted by two cards of the same type', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['02', '04'];   // two points
    energizeCard(state, 'p1', '02');
    energizeCard(state, 'p1', '04');
    expect(computeActualCost(state, '03', 'p1')).toBe(6);
  });

  test('a risen action does NOT count — only what you energized does', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['02'];
    energizeCard(state, 'p1', '02');
    state.zones.horizon.unshift(createHorizonEntry('45', 'p1'));
    riseTopOfHorizon(state);
    // The action reached the dusk by rising, not by being energized.
    expect(state.zones.dusk).toContain('45');
    expect(computeActualCost(state, '03', 'p1')).toBe(6);
  });

  test('the record resets at end of turn', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['02', '45'];
    energizeCard(state, 'p1', '02');
    energizeCard(state, 'p1', '45');
    endTurn(state);
    expect(state.cardsToDuskThisTurn).toHaveLength(0);
    expect(computeActualCost(state, '03', 'p1')).toBe(6);
  });
});

// ─── Trigger timings the engine must handle ───────────────────────────────────

describe('Trigger coverage', () => {
  // A staticEffect trigger whose `on` the engine never checks is silently inert:
  // the card looks encoded but does nothing. cards-sweep.mjs cannot see this,
  // because it only reports unhandled *effects*.
  test('every trigger timing used by the card set is implemented', () => {
    const engineSrc = ['engine/game.js', 'engine/state.js', 'effects/executor.js', 'engine/choices.js']
      .map(p => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8')).join('\n');
    // Both forms appear: `se.on === 'x'` for per-card triggers, `trigger.on !== 'x'`
    // for the registered turn trigger.
    const handled = new Set([...engineSrc.matchAll(/on\s*[!=]==\s*'([^']+)'/g)].map(m => m[1]));

    const used = new Map();
    for (const id of ALL_CARD_IDS) {
      const card = getCard(id);
      for (const se of card.staticEffects ?? []) {
        if (se.type === 'trigger') used.set(se.on, [...(used.get(se.on) ?? []), id]);
      }
      for (const e of [...(card.effects ?? []), ...(card.onPlayEffects ?? [])]) {
        if (e.type === 'registerTrigger') used.set(e.on, [...(used.get(e.on) ?? []), id]);
      }
    }

    // Every timing the card set uses must now be implemented.
    const unhandled = [...used.keys()].filter(on => !handled.has(on)).sort();
    expect(unhandled).toEqual([]);
  });
});

// ─── Departure triggers ───────────────────────────────────────────────────────

describe('Cards that watch a departure', () => {
  const flush = flushHorizonTriggers;

  function armed(cardId, controller = 'p1') {
    const { state } = freshGame();
    state.players.p1.energy = 30;
    state.players.p2.energy = 30;
    state.zones.horizon.unshift(createHorizonEntry(cardId, controller));
    return state;
  }

  test('Plead (010) makes the opponent draw when it leaves the horizon', () => {
    const state = armed('08');
    const before = state.players.p2.hand.length;
    riseTopOfHorizon(state);
    expect(state.players.p2.hand.length).toBe(before + 1);
  });

  test('Contentment (041) fires only when it does NOT rise', () => {
    const removed = armed('36');
    const p1 = removed.players.p1.hand.length;
    const p2 = removed.players.p2.hand.length;
    duskFromHorizon(removed, 0);
    flush(removed);
    expect(removed.players.p1.hand.length).toBe(p1 + 1);
    expect(removed.players.p2.hand.length).toBe(p2 + 1);

    const rose = armed('36');
    const before = rose.players.p1.hand.length;
    riseTopOfHorizon(rose);
    expect(rose.players.p1.hand.length).toBe(before);
  });

  test('Agoraphobia (040) goes to the bottom of the deck instead of the dusk', () => {
    const state = armed('35');
    duskFromHorizon(state, 0);
    flush(state);
    expect(state.zones.dusk).not.toContain('35');
    expect(state.zones.deck[state.zones.deck.length - 1]).toBe('35');
  });

  test('Pride (046) draws if it rose, and dusks a card from hand if it did not', () => {
    const rose = armed('41');
    const before = rose.players.p1.hand.length;
    riseTopOfHorizon(rose);
    expect(rose.players.p1.hand.length).toBe(before + 1);

    const removed = armed('41');
    duskFromHorizon(removed, 0);
    flush(removed);
    expect(removed.pendingTriggers.some(t => t.type === 'duskFromHandChoice')).toBe(true);
  });


  test('Purity (044) goes to the dusk when an OPPONENT responds to it', () => {
    const state = armed('39', 'p1');
    state.players.p2.hand.push(ACTION);
    state.activePlayer = 'p2';
    playCard(state, 'p2', ACTION);
    expect(state.zones.horizon.some(e => e.cardId === '39')).toBe(false);
    expect(state.zones.dusk).toContain('39');
  });

  test('Purity (044) is unaffected by its own controller playing another card', () => {
    const state = armed('39', 'p1');
    state.players.p1.hand.push(ACTION);
    state.activePlayer = 'p1';
    playCard(state, 'p1', ACTION);
    expect(state.zones.horizon.some(e => e.cardId === '39')).toBe(true);
  });

  test('Pay No Mind (047) dusks itself AND draws three when answered', () => {
    const state = armed('42', 'p1');
    state.players.p2.hand.push(ACTION);
    state.activePlayer = 'p2';
    const before = state.players.p1.hand.length;

    playCard(state, 'p2', ACTION);

    expect(state.zones.horizon.some(e => e.cardId === '42')).toBe(false);
    expect(state.zones.dusk).toContain('42');
    // The draw is the half Purity (044) does not have: it needs the trigger to
    // run a list of effects rather than a single one.
    expect(state.players.p1.hand.length).toBe(before + 3);
  });

  test('Pay No Mind (047) only fires when it is the card being answered', () => {
    // "Responds to this" means the card directly beneath the one just played.
    // Buried a layer down, 047 is not what the opponent answered, so it sits.
    const state = armed('42', 'p1');
    state.zones.horizon.unshift(createHorizonEntry(ACTION_B, 'p1'));
    state.players.p2.hand.push(ACTION);
    state.activePlayer = 'p2';
    const before = state.players.p1.hand.length;

    playCard(state, 'p2', ACTION);

    expect(state.zones.horizon.some(e => e.cardId === '42')).toBe(true);
    expect(state.players.p1.hand.length).toBe(before);
  });

  test('Understand Despair (064) draws two whenever your card leaves without rising', () => {
    const state = armed('56');
    riseTopOfHorizon(state);            // registers the turn-long trigger
    const before = state.players.p1.hand.length;
    state.zones.horizon.unshift(createHorizonEntry('02', 'p1'));
    duskFromHorizon(state, 0);
    flush(state);
    expect(state.players.p1.hand.length).toBe(before + 2);
  });
});

// ─── thenGrant riders ─────────────────────────────────────────────────────────
// Four cards put a card into the dusk and then do something to that card's
// controller. The rider was encoded as a bare string while the resolver switched
// on grant.type, so every one of them silently did only the first half — no
// error, no crash, nothing for cards-sweep or the fuzzer to notice. These pin
// the second half down.
describe('thenGrant riders fire', () => {
  function duskWithRider(cardId, targetId) {
    const state = createGameState();
    initDeck(state);
    startGame(state);
    state.zones.horizon = [
      createHorizonEntry(cardId, 'p1'),
      createHorizonEntry(targetId, 'p2'),
    ];
    state.players.p1.energy = 10;
    state.players.p2.energy = 0;
    state.players.p2.hand = ['04', '10'];
    riseTopOfHorizon(state);
    flushHorizonTriggers(state);
    expect(advancePendingChoices(state)).toBe(true);
    const { error } = resolveChoice(state, state.pendingChoice.player, { horizonIndex: 0 });
    expect(error).toBe(null);
    return state;
  }

  test('Unwanted Gift (089) gives the target controller 3 energy', () => {
    expect(duskWithRider('78', '45').players.p2.energy).toBe(3);
  });

  test('Relapse (095) makes the target controller draw two', () => {
    expect(duskWithRider('82', '45').players.p2.hand.length).toBe(4);
  });

  test('Drain Motive (092) locks the target controller out of the turn', () => {
    expect(duskWithRider('80', '04').turnFlags.lockedPlayer).toBe('p2');
  });

  test('Metamorphosis (071) makes the target controller next card free', () => {
    const state = duskWithRider('62', '45');
    expect(state.turnFlags.nextCardFreeFor).toBe('p2');
    expect(computeActualCost(state, '10', 'p2')).toBe(0);
  });

  test('the free-card grant is spent by the card it pays for', () => {
    // Driven on a clean turn: continuing from the rider state would have to
    // fight the priority pass that playing a card triggers.
    const { state } = freshGame();
    const me = state.activePlayer;
    state.players[me].hand = ['04', '10'];
    state.players[me].energy = 10;
    state.turnFlags.nextCardFreeFor = me;

    expect(computeActualCost(state, '04', me)).toBe(0);
    playCard(state, me, '04');
    expect(state.players[me].energy).toBe(10);
    expect(state.turnFlags.nextCardFreeFor).toBe(null);
    // Full price once the grant is gone.
    expect(computeActualCost(state, '10', me)).toBe(getCard('10').energyCost);
  });
});

// ─── Reworked cards ───────────────────────────────────────────────────────────
describe('the reworked cards do what their new text says', () => {
  test('Unused Ambition (009) dumps only its own controller hand, on rise', () => {
    const state = createGameState();
    initDeck(state);
    startGame(state);
    state.players.p1.hand = ['04', '10', '45'];
    state.players.p2.hand = ['02', '46'];
    state.zones.horizon = [createHorizonEntry('07', 'p1')];

    riseTopOfHorizon(state);
    flushHorizonTriggers(state);

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p2.hand).toHaveLength(2);
    expect(state.players.p1.zenith.includes('07')).toBe(true);
  });

  test('Delve (003) discounts only once YOU have energized both types', () => {
    const { state } = freshGame();
    const me = state.activePlayer;
    state.players[me].hand = ['03', '04', '45'];

    expect(computeActualCost(state, '03', me)).toBe(6);
    energizeCard(state, me, '04');                 // a point
    expect(computeActualCost(state, '03', me)).toBe(6);
    energizeCard(state, me, '45');                 // an action
    expect(computeActualCost(state, '03', me)).toBe(4);
  });

  test('Delve ignores cards that reach the dusk without being energized', () => {
    // The old wording counted anything arriving in the dusk from any source.
    // Insanity dumps a hand there, which used to be enough.
    const { state } = freshGame();
    const me = state.activePlayer;
    // Unused Ambition dumps the hand as it rises — both types reach the dusk
    // without either being energized.
    state.zones.horizon = [createHorizonEntry('07', me)];
    state.players[me].hand = ['04', '45'];

    riseTopOfHorizon(state);
    flushHorizonTriggers(state);

    expect(state.zones.dusk.includes('04')).toBe(true);
    expect(state.zones.dusk.includes('45')).toBe(true);
    expect(computeActualCost(state, '03', me)).toBe(6);
  });

  test('Angst (020) draws two after you energize both types', () => {
    const { state } = freshGame();
    const me = state.activePlayer;
    state.players[me].hand = ['04', '45'];
    energizeCard(state, me, '04');
    energizeCard(state, me, '45');
    const before = state.players[me].hand.length;

    state.zones.horizon = [createHorizonEntry('18', me)];
    riseTopOfHorizon(state);
    flushHorizonTriggers(state);

    expect(state.players[me].hand.length - before).toBe(2);
  });

  test('Agonizing Memory (098) only offers cards cheaper than the dusk is deep', () => {
    const state = createGameState();
    initDeck(state);
    startGame(state);
    state.zones.dusk = ['45', '46', '47'];
    state.zones.horizon = [
      createHorizonEntry('85', 'p1'),
      createHorizonEntry('48', 'p2'),   // cost 2
      createHorizonEntry('60', 'p2'),   // cost 7
    ];

    riseTopOfHorizon(state);
    flushHorizonTriggers(state);
    expect(advancePendingChoices(state)).toBe(true);

    const prompt = buildChoicePrompt(state, state.pendingChoice, state.pendingChoice.player);
    // 098 is itself in the dusk by the time its text runs, so the threshold is 4.
    expect(prompt.filter.costLessThan).toBe(4);
    expect(prompt.legalHorizonIndexes.map(i => state.zones.horizon[i].cardId)).toEqual(['48']);
  });
});

// ─── Dawn's reveal ────────────────────────────────────────────────────────────
describe('Dawn (049) pays for its discount by revealing', () => {
  test('does not count itself towards the three points', () => {
    const { state } = freshGame();
    const me = state.activePlayer;
    // Dawn is itself a point and is still in hand while its cost is worked out.
    state.players[me].hand = ['44', '02', '04'];
    expect(computeActualCost(state, '44', me)).toBe(6);
    state.players[me].hand = ['44', '02', '04', '01'];
    expect(computeActualCost(state, '44', me)).toBe(0);
  });

  test('playing it free actually reveals three points, and never itself', () => {
    const { state } = freshGame();
    const me = state.activePlayer;
    state.players[me].hand = ['44', '02', '04', '01', '45'];
    state.players[me].energy = 0;

    const events = playCard(state, me, '44');
    const reveal = events.find(e => e.type === 'POINTS_REVEALED');
    expect(reveal).toBeTruthy();
    expect(reveal.player).toBe(me);
    expect(reveal.cards).toHaveLength(3);
    expect(reveal.cards.includes('44')).toBe(false);
    expect(reveal.cards.every(id => getCard(id).type === 'point')).toBe(true);
  });

  test('paying full price reveals nothing', () => {
    const { state } = freshGame();
    const me = state.activePlayer;
    state.players[me].hand = ['44', '45'];
    state.players[me].energy = 10;
    const events = playCard(state, me, '44');
    expect(events.some(e => e.type === 'POINTS_REVEALED')).toBe(false);
  });
});

// ─── v4 card set ──────────────────────────────────────────────────────────────
// The cards the overhaul either added outright or rebuilt around a mechanic the
// engine did not have before.

describe('the v4 cards', () => {
  function onHorizon(state, cardId, player) {
    const entry = createHorizonEntry(cardId, player);
    state.zones.horizon.unshift(entry);
    return entry;
  }
  function rise(state, cardId, player = 'p1') {
    onHorizon(state, cardId, player);
    const events = riseTopOfHorizon(state);
    advancePendingChoices(state);
    return events;
  }

  test('Offer Perspective (22) draws for the opponent of whoever played the action', () => {
    const { state } = freshGame();
    onHorizon(state, '22', 'p1');            // the watcher, controlled by p1
    giveCard(state, 'p2', '45');
    setEnergy(state, 'p2', 20);
    state.activePlayer = 'p2';               // p2 holds priority to respond
    const before = state.players.p1.hand.length;

    playCard(state, 'p2', '45');             // p2 plays an action

    expect(state.players.p1.hand).toHaveLength(before + 1);
  });

  test('Avoid Conflict (32) dusks itself on the opponent second action, not the first', () => {
    const { state } = freshGame();
    onHorizon(state, '32', 'p1');
    giveCard(state, 'p2', '86');   // Delay the Inevitable — harmless on rise
    giveCard(state, 'p2', '52');   // Prepare — likewise
    setEnergy(state, 'p2', 20);

    state.activePlayer = 'p2';
    playCard(state, 'p2', '86');
    expect(state.zones.horizon.some(e => e.cardId === '32')).toBe(true);

    // Let it rise so Avoid Conflict is back on top and p2 may respond again.
    passPriority(state, 'p1');
    playCard(state, 'p2', '52');
    expect(state.zones.horizon.some(e => e.cardId === '32')).toBe(false);
    expect(state.zones.dusk).toContain('32');
  });

  test('Avoid Conflict (32) does not count the actions of its own controller', () => {
    const { state } = freshGame();
    onHorizon(state, '32', 'p1');
    giveCard(state, 'p1', '45');
    giveCard(state, 'p1', '46');
    setEnergy(state, 'p1', 20);

    playCard(state, 'p1', '45');
    playCard(state, 'p1', '46');

    expect(state.zones.horizon.some(e => e.cardId === '32')).toBe(true);
  });

  test('Past Passion (47) makes the card it fetched free, and only that card', () => {
    const { state } = freshGame();
    state.zones.dusk = ['02', '60'];          // Momentum 6, Change of Luck 7
    rise(state, '47');

    expect(state.pendingChoice.type).toBe('putFromDuskToHand');
    resolveChoice(state, 'p1', { cardIds: ['60'] });

    expect(state.players.p1.hand).toContain('60');
    expect(computeActualCost(state, '60', 'p1')).toBe(0);
    expect(computeActualCost(state, '02', 'p1')).toBe(6);
  });

  test('Unwind Intent (89) draws only when the bounced card was yours', () => {
    const { state } = freshGame();
    onHorizon(state, '02', 'p1');             // p1 own point
    const before = state.players.p1.hand.length;
    rise(state, '89', 'p1');

    const idx = state.zones.horizon.findIndex(e => e.cardId === '02');
    resolveChoice(state, 'p1', { horizonIndex: idx });

    expect(state.players.p1.hand).toContain('02');
    expect(state.players.p1.hand.length).toBe(before + 2);  // the bounce + the draw
  });

  test('Unwind Intent (89) skips the draw on an opponent card', () => {
    const { state } = freshGame();
    onHorizon(state, '02', 'p2');
    const before = state.players.p1.hand.length;
    rise(state, '89', 'p1');

    const idx = state.zones.horizon.findIndex(e => e.cardId === '02');
    resolveChoice(state, 'p1', { horizonIndex: idx });

    expect(state.players.p2.hand).toContain('02');
    expect(state.players.p1.hand).toHaveLength(before);
  });

  test('Blinding Flash (53) stops the opponent responding to your cards all turn', () => {
    const { state } = freshGame();
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);
    giveCard(state, 'p2', '46');

    rise(state, '53', 'p1');                  // the lock outlives the card
    onHorizon(state, '02', 'p1');             // now a p1 card is on top

    expect(validatePlay(state, 'p2', '46')).toMatch(/cannot respond/);
  });

  test('Blinding Flash (53) does not shield the cards of the other player', () => {
    const { state } = freshGame();
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);
    giveCard(state, 'p1', '46');

    rise(state, '53', 'p1');
    onHorizon(state, '02', 'p2');             // a p2 card on top

    expect(validatePlay(state, 'p1', '46')).toBeNull();
  });

  test('Efficiency (13) discounts the opponent actions but not their points', () => {
    const { state } = freshGame();
    onHorizon(state, '13', 'p1');
    expect(computeActualCost(state, '46', 'p2')).toBe(1);   // Regret 3 → 1
    expect(computeActualCost(state, '02', 'p2')).toBe(6);   // Momentum unchanged
  });

  test('Paranoia (21) locks its controller out of actions only', () => {
    const { state } = freshGame();
    onHorizon(state, '21', 'p1');
    giveCard(state, 'p1', '46');
    giveCard(state, 'p2', '45');
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);

    expect(validatePlay(state, 'p1', '46')).toMatch(/cannot be played/);
    expect(validatePlay(state, 'p2', '45')).toBeNull();
  });

  test('Overwhelm (15) discounts per card played this turn, not per card on the horizon', () => {
    const { state } = freshGame();
    const me = state.activePlayer;
    setEnergy(state, me, 20);
    expect(computeActualCost(state, '15', me)).toBe(7);

    giveCard(state, me, '46');
    playCard(state, me, '46');
    expect(computeActualCost(state, '15', me)).toBe(6);
  });

  test('Endure Hatred (19) draws when the opponent action rises, not when it is played', () => {
    const { state } = freshGame();
    onHorizon(state, '19', 'p1');
    giveCard(state, 'p2', '46');
    setEnergy(state, 'p2', 20);
    state.activePlayer = 'p2';

    playCard(state, 'p2', '46');
    const afterPlay = state.players.p1.hand.length;

    riseTopOfHorizon(state);                  // the opponent action rises
    expect(state.players.p1.hand).toHaveLength(afterPlay + 1);
  });

  test('Treasure Anew (26) swaps each hand for the same number of fresh cards', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['04', '10'];
    state.players.p2.hand = ['02', '46', '45'];

    rise(state, '26', 'p1');

    expect(state.players.p1.hand).toHaveLength(2);
    expect(state.players.p2.hand).toHaveLength(3);
    for (const id of ['04', '10', '02', '46', '45']) expect(state.zones.dusk).toContain(id);
  });

  test('Burn Out (77) pays out the cost of the point it dusked', () => {
    const { state } = freshGame();
    onHorizon(state, '02', 'p2');             // Momentum, cost 6
    setEnergy(state, 'p1', 0);
    rise(state, '77', 'p1');

    const idx = state.zones.horizon.findIndex(e => e.cardId === '02');
    resolveChoice(state, 'p1', { horizonIndex: idx });

    expect(state.zones.dusk).toContain('02');
    expect(state.players.p1.energy).toBe(6);
  });

  test('Strobe Brightness (88) holds its energy until the next turn', () => {
    const { state } = freshGame();
    onHorizon(state, '02', 'p2');             // Momentum, cost 6
    setEnergy(state, 'p1', 0);
    rise(state, '88', 'p1');

    const idx = state.zones.horizon.findIndex(e => e.cardId === '02');
    resolveChoice(state, 'p1', { horizonIndex: idx });

    // Nothing yet — the end-of-turn wipe would only take it away again.
    expect(state.players.p1.energy).toBe(0);
    endTurn(state);
    expect(state.players.p1.energy).toBe(6);
  });

  test('Inspect (65) puts the cards it passed over into the dusk', () => {
    const { state } = freshGame();
    rise(state, '65', 'p1');

    expect(state.pendingChoice.type).toBe('revealUntilType');
    const deckBefore = state.zones.deck.length;
    resolveChoice(state, 'p1', { cardType: 'point' });

    const consumed = deckBefore - state.zones.deck.length;
    // One revealed card went to hand, the rest to the dusk, plus Inspect itself.
    expect(state.zones.dusk).toHaveLength(consumed - 1 + 1);
  });
});
