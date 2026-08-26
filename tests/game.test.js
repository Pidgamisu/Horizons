import { readFileSync } from 'node:fs';
import { describe, test, expect } from './helpers.js';
import {
  createGameState, createHorizonEntry, initDeck, drawCards, pointsOf,
  computeActualCost, sendToDusk,
} from '../src/engine/state.js';
import {
  startGame, playCard, passPriority, voidCard, endTurn, riseTopOfHorizon,
  checkSunset, isLivePriorityWindow,
} from '../src/engine/game.js';
import { validatePlay } from '../src/engine/validation.js';
import { resolveChoice } from '../src/engine/choices.js';
import { executeOnPlayEffects } from '../src/effects/executor.js';
import { advancePendingChoices } from '../src/server.js';
import { ALL_CARD_IDS, getCard } from '../src/data/cardDb.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Card ids are ordered: 000–049 are points, 050–104 are actions. These are
// deliberately plain cards — no static effects that would change play legality.
const POINT = '002';    // Momentum       — gain 4 energy
const POINT_B = '004';  // Inquire        — draw a card
const ACTION = '050';   // Bounce Back    — return a point on the horizon
const ACTION_B = '051'; // Regret         — put a card on top of the deck
const LOCK_POINT = '000'; // Pretty Privilege — opponents cannot play cards

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
  test('holds 105 cards: 55 actions and 50 points', () => {
    expect(ALL_CARD_IDS).toHaveLength(105);
    const points = ALL_CARD_IDS.filter(id => getCard(id).type === 'point');
    const actions = ALL_CARD_IDS.filter(id => getCard(id).type === 'action');
    expect(points).toHaveLength(50);
    expect(actions).toHaveLength(55);
  });

  test('ids 000-049 are points and 050-104 are actions', () => {
    expect(getCard('000').type).toBe('point');
    expect(getCard('049').type).toBe('point');
    expect(getCard('050').type).toBe('action');
    expect(getCard('104').type).toBe('action');
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
  test('deals five cards each and leaves 95 in the deck', () => {
    const { state } = freshGame();
    expect(state.players.p1.hand).toHaveLength(5);
    expect(state.players.p2.hand).toHaveLength(5);
    expect(state.zones.deck).toHaveLength(95);
    expect(countAllCards(state)).toBe(105);
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

  test('the old trash and void zones are gone — the dusk replaces both', () => {
    const { state } = freshGame();
    expect(Object.keys(state.zones).sort()).toEqual(['deck', 'dusk', 'horizon']);
  });
});

// ─── Voiding ──────────────────────────────────────────────────────────────────

describe('Voiding', () => {
  test('puts the card in the dusk and gives 3 energy', () => {
    const { state } = freshGame();
    const card = state.players.p1.hand[0];
    const events = voidCard(state, 'p1', card);

    expect(eventTypes(events)).toContain('CARD_VOIDED');
    expect(state.players.p1.energy).toBe(3);
    expect(state.zones.dusk).toContain(card);
    expect(state.players.p1.hand).not.toContain(card);
  });

  test('stacks: voiding three cards gives 9 energy', () => {
    const { state } = freshGame();
    for (const card of [...state.players.p1.hand].slice(0, 3)) voidCard(state, 'p1', card);
    expect(state.players.p1.energy).toBe(9);
    expect(state.zones.dusk).toHaveLength(3);
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
    expect(validatePlay(state, 'p2', POINT)).toMatch(/cannot play a point card in response/);
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

  test('both players passing makes the top card rise', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', POINT);
    setEnergy(state, 'p1', 20);
    playCard(state, 'p1', POINT);

    passPriority(state, 'p2');   // opponent declines to respond
    passPriority(state, 'p1');

    expect(state.players.p1.zenith).toContain(POINT);
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
    voidCard(state, 'p1', card);
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
    state.zones.dusk = ['000', '001', '002'];
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
    state.zones.dusk = ['000', '001'];
    state.reshufflesRemaining = 0;

    const drawn = drawCards(state, 'p1', 2);

    expect(drawn).toHaveLength(0);
    expect(state.zones.dusk).toHaveLength(2);
  });

  test('a zenith is never reshuffled back into the deck', () => {
    const { state } = freshGame();
    state.zones.deck = [];
    state.zones.dusk = ['000'];
    state.players.p1.zenith = ['001', '002'];
    state.reshufflesRemaining = 1;

    drawCards(state, 'p1', 1);

    expect(state.players.p1.zenith).toEqual(['001', '002']);
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
    state.players.p1.zenith = ['000', '001', '002'];
    state.players.p2.zenith = ['003'];
    checkSunset(state);
    expect(state.winner).toBe('p1');
  });

  test('an equal number of points is a draw', () => {
    const { state } = freshGame();
    spentDeck(state);
    state.players.p1.zenith = ['000'];
    state.players.p2.zenith = ['001'];
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
    state.zones.deck = ['000'];
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

      // Void two cards for energy, then play the cheapest affordable point.
      for (const id of [...state.players[me].hand].slice(0, 2)) voidCard(state, me, id);
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
    expect(countAllCards(state)).toBe(105);
    expect(['p1', 'p2', 'draw']).toContain(state.winner);
  });

  test('every card in a zenith is a point card', () => {
    const { state } = freshGame();
    let guard = 0;
    while (state.phase === 'active' && guard++ < 3000) {
      const me = state.turn;
      if (state.activePlayer !== me) { passPriority(state, state.activePlayer); continue; }
      for (const id of [...state.players[me].hand].slice(0, 2)) voidCard(state, me, id);
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
    state.zones.dusk = ['002', '050'];
    rise(state, '001');
    expect(state.pendingChoice.type).toBe('putPointFromDuskIntoZenith');
    resolveChoice(state, 'p1', { cardId: '002' });
    expect(state.players.p1.zenith).toContain('002');
    expect(state.zones.dusk).not.toContain('002');
  });

  test('Abstract Embrace (001) is skipped when the dusk holds no point', () => {
    const { state } = freshGame();
    state.zones.dusk = ['050', '051'];
    const events = rise(state, '001');
    expect(eventTypes(events)).toContain('NO_VALID_TARGETS');
    expect(state.pendingChoice).toBeNull();
  });

  test('Change of Luck (068) banks a point from the horizon without it rising', () => {
    const { state } = freshGame();
    state.zones.horizon.unshift(createHorizonEntry('002', 'p2'));
    rise(state, '068');
    expect(state.pendingChoice.type).toBe('putPointFromHorizonIntoZenith');
    resolveChoice(state, 'p1', { horizonIndex: 0 });
    expect(state.players.p1.zenith).toContain('002');
    expect(state.players.p2.zenith).not.toContain('002');
    expect(state.zones.horizon).toHaveLength(0);
  });

  test('Trickle Down Economics (027) takes the opponent leftover energy', () => {
    const { state } = freshGame();
    state.players.p1.energy = 2;
    state.players.p2.energy = 7;
    const entry = createHorizonEntry('027', 'p1');
    state.zones.horizon.unshift(entry);
    executeOnPlayEffects(state, entry);
    expect(state.players.p2.energy).toBe(0);
    expect(state.players.p1.energy).toBe(9);
  });

  test('Anxiety (073) dusks the top of the horizon with no choice', () => {
    const { state } = freshGame();
    state.zones.horizon.unshift(createHorizonEntry('002', 'p2'));
    rise(state, '073');
    expect(state.zones.dusk).toContain('002');
    expect(state.pendingChoice).toBeNull();
  });

  test('Settle (100) puts the whole horizon on the bottom of the deck', () => {
    const { state } = freshGame();
    const deckBefore = state.zones.deck.length;
    state.zones.horizon.unshift(createHorizonEntry('002', 'p2'));
    state.zones.horizon.unshift(createHorizonEntry('004', 'p1'));
    rise(state, '100');
    expect(state.zones.horizon).toHaveLength(0);
    expect(state.zones.deck).toHaveLength(deckBefore + 2);
  });

  test('Answer Fate (047) reshuffles the dusk even though 2p normally gets none', () => {
    const { state } = freshGame();
    state.zones.deck = [];
    state.zones.dusk = ['002', '004', '050'];
    state.reshufflesRemaining = 0;
    rise(state, '047');
    expect(state.pendingChoice.type).toBe('optional');
    resolveChoice(state, 'p1', { accept: true });
    expect(state.zones.dusk).toHaveLength(0);
    expect(state.zones.deck).toHaveLength(3);
  });

  test('Cerebral Snuff (091) dusks a random card from the opponent hand', () => {
    const { state } = freshGame();
    const before = state.players.p2.hand.length;
    rise(state, '091');
    expect(state.players.p2.hand).toHaveLength(before - 1);
    // The risen action lands in the dusk too, so that is two cards.
    expect(state.zones.dusk).toHaveLength(2);
    expect(state.zones.dusk).toContain('091');
  });

  test('Delve (003) costs 2 less once both a point and an action reached the dusk', () => {
    const { state } = freshGame();
    expect(computeActualCost(state, '003', 'p1')).toBe(6);
    sendToDusk(state, '002');
    expect(computeActualCost(state, '003', 'p1')).toBe(6);
    sendToDusk(state, '050');
    expect(computeActualCost(state, '003', 'p1')).toBe(4);
  });

  test('Light Guidance (065) costs 1 less per point in either zenith', () => {
    const { state } = freshGame();
    expect(computeActualCost(state, '065', 'p1')).toBe(5);
    state.players.p1.zenith = ['002', '004'];
    state.players.p2.zenith = ['006'];
    expect(computeActualCost(state, '065', 'p1')).toBe(2);
  });

  test('Strafe (006) cannot be played on your own turn even with a legal target', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '006');
    setEnergy(state, 'p1', 20);
    // An opponent action on top would normally satisfy its response-only clause.
    state.zones.horizon.unshift(createHorizonEntry(ACTION, 'p2'));
    expect(validatePlay(state, 'p1', '006')).toMatch(/cannot be played during your turn/);
  });

  test('Strafe (006) can be played in response on the opponent turn', () => {
    const { state } = freshGame();
    giveCard(state, 'p2', '006');
    setEnergy(state, 'p2', 20);
    state.zones.horizon.unshift(createHorizonEntry(ACTION, 'p1'));
    expect(validatePlay(state, 'p2', '006')).toBeNull();
  });

  test('Paranoia (023) locks its own controller, not the opponent', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '023');
    giveCard(state, 'p1', ACTION);
    giveCard(state, 'p2', ACTION_B);
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);
    playCard(state, 'p1', '023');
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
      state.zones.dusk.push('002', '050');
      state.zones.horizon.push(createHorizonEntry('005', 'p2', { respondedToCardType: 'point' }));
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
  test('Forever Borrow (036) takes the action it responded to, which then returns to its owner', () => {
    const { state } = freshGame();
    // p2 has an action on the horizon; p1 responds with Forever Borrow.
    state.zones.horizon.unshift(createHorizonEntry(ACTION, 'p2'));
    const borrow = createHorizonEntry('036', 'p1', { respondedToCardIndex: 0, respondedToCardType: 'action' });
    state.zones.horizon.unshift(borrow);

    executeOnPlayEffects(state, borrow);

    const stolen = state.zones.horizon[1];
    expect(stolen.controlledBy).toBe('p1');       // control changed hands
    expect(stolen.playedBy).toBe('p2');           // ownership did not

    riseTopOfHorizon(state);                      // Forever Borrow itself rises
    riseTopOfHorizon(state);                      // now the borrowed action rises

    // It goes back to its original owner's hand instead of the dusk.
    expect(state.players.p2.hand).toContain(ACTION);
    expect(state.zones.dusk).not.toContain(ACTION);
  });

  test('Paradox (101) returns two cards controlled by different players', () => {
    const { state } = freshGame();
    state.zones.horizon.unshift(createHorizonEntry('002', 'p2'));
    state.zones.horizon.unshift(createHorizonEntry('004', 'p1'));
    state.zones.horizon.unshift(createHorizonEntry('101', 'p1'));

    riseTopOfHorizon(state);
    advancePendingChoices(state);
    expect(state.pendingChoice.type).toBe('returnTwoDifferentControllers');

    const { error } = resolveChoice(state, 'p1', { horizonIndexes: [0, 1] });
    expect(error).toBeNull();
    expect(state.players.p1.hand).toContain('004');
    expect(state.players.p2.hand).toContain('002');
    expect(state.zones.horizon).toHaveLength(0);
  });

  test('Paradox (101) refuses two cards controlled by the same player', () => {
    const { state } = freshGame();
    state.zones.horizon.unshift(createHorizonEntry('002', 'p2'));
    state.zones.horizon.unshift(createHorizonEntry('004', 'p2'));
    state.zones.horizon.unshift(createHorizonEntry('006', 'p1'));   // makes two controllers present
    state.zones.horizon.unshift(createHorizonEntry('101', 'p1'));

    riseTopOfHorizon(state);
    advancePendingChoices(state);
    // Indexes 1 and 2 are both p2-controlled.
    const { error } = resolveChoice(state, 'p1', { horizonIndexes: [1, 2] });
    expect(error).toMatch(/different players/);
  });

  test('Paradox (101) does nothing when one player controls the whole horizon', () => {
    const { state } = freshGame();
    state.zones.horizon.unshift(createHorizonEntry('002', 'p2'));
    state.zones.horizon.unshift(createHorizonEntry('004', 'p2'));
    state.zones.horizon.unshift(createHorizonEntry('101', 'p1'));

    const events = riseTopOfHorizon(state);
    advancePendingChoices(state);

    expect(eventTypes(events)).toContain('NO_VALID_TARGETS');
    expect(state.pendingChoice).toBeNull();
    expect(state.zones.horizon).toHaveLength(2);   // nothing was returned
  });

  test('Enlightenment (075) only offers horizon cards matching the dusked cost', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['002'];                                  // Momentum, cost 6
    state.zones.horizon.unshift(createHorizonEntry('004', 'p2'));     // Inquire, cost 6 — matches
    state.zones.horizon.unshift(createHorizonEntry('075', 'p1'));

    riseTopOfHorizon(state);
    advancePendingChoices(state);
    expect(state.pendingChoice.type).toBe('duskFromHandThenMatchCost');

    resolveChoice(state, 'p1', { cardId: '002' });
    advancePendingChoices(state);

    expect(state.zones.dusk).toContain('002');
    expect(state.pendingChoice.type).toBe('duskFromHorizon');
    expect(state.pendingChoice.filter.costEquals).toBe(6);
  });

  test('Reach Out to the Dark (057) lets the opponent choose which cards you get', () => {
    const { state } = freshGame();
    state.zones.dusk = ['002', '004', '050'];
    state.zones.horizon.unshift(createHorizonEntry('057', 'p1'));

    riseTopOfHorizon(state);
    advancePendingChoices(state);

    // The OPPONENT is the one prompted, even though the caster benefits.
    expect(state.pendingChoice.player).toBe('p2');
    expect(state.pendingChoice.type).toBe('opponentChoosesFromDusk');

    resolveChoice(state, 'p2', { cardIds: ['002', '050'] });
    expect(state.players.p1.hand).toContain('002');
    expect(state.players.p1.hand).toContain('050');
    expect(state.players.p2.hand).not.toContain('002');
  });
});
