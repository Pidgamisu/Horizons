import { readFileSync } from 'node:fs';
import { describe, test, expect } from './helpers.js';
import {
  createGameState, createHorizonEntry, initDeck, drawCards, opponent, pointsOf,
} from '../src/engine/state.js';
import {
  startGame, playCard, passPriority, voidCard, endTurn, riseTopOfHorizon,
  checkSunset, isLivePriorityWindow,
} from '../src/engine/game.js';
import { validatePlay } from '../src/engine/validation.js';
import { ALL_CARD_IDS, getCard } from '../src/data/cardDb.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Card ids are ordered: 000–049 are points, 050–104 are actions.
const POINT = '000';
const POINT_B = '001';
const ACTION = '050';
const ACTION_B = '051';

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
