import { readFileSync } from 'node:fs';
import { describe, test, expect } from './helpers.js';
import { createGameState, drawCards, opponent, initDeck, canPlayFromTrash } from '../src/engine/state.js';
import { startGame, playCard, passPriority, voidCard, endTurn, isLivePriorityWindow } from '../src/engine/game.js';
import { resolveChoice } from '../src/engine/choices.js';
import { validatePlay } from '../src/engine/validation.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function freshGame() {
  const state = createGameState();
  initDeck(state);
  const events = startGame(state);
  return { state, events };
}

function eventTypes(events) {
  return events.map(e => e.type);
}

function giveCard(state, playerId, cardId) {
  // Put a specific card in a player's hand (remove from deck if present).
  const di = state.zones.deck.indexOf(cardId);
  if (di !== -1) state.zones.deck.splice(di, 1);
  // Avoid duplicates: the random opening hand may already hold this card.
  if (!state.players[playerId].hand.includes(cardId)) {
    state.players[playerId].hand.push(cardId);
  }
}

function setEnergy(state, playerId, amount) {
  state.players[playerId].energy = amount;
}

// ─── Initialisation ───────────────────────────────────────────────────────────

// ─── Client choice-prompt coverage ──────────────────────────────────────────────

describe('Client prompt coverage', () => {
  // Guard against the "choice resolves in the engine but the client has no prompt
  // / never receives the hidden data" class of bug (Search, the free-play cards).
  // Every choice type that can surface must have a ChoicePrompt branch.
  test('every surfaceable choice type has a ChoicePrompt branch', () => {
    const read = (p) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
    const server = read('server.js');
    const choices = read('engine/choices.js');
    const prompt = read('ui/ChoicePrompt.jsx');

    // Trigger types the server surfaces, mapped to their client choice type.
    const setBlock = server.match(/choiceTypes = new Set\(\[([\s\S]*?)\]\)/);
    expect(setBlock).not.toBe(null);
    const triggers = [...setBlock[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const mapBlock = server.match(/const typeMap = \{([\s\S]*?)\};/);
    expect(mapBlock).not.toBe(null);
    const typeMap = {};
    for (const m of mapBlock[1].matchAll(/(\w+):\s*'([^']+)'/g)) typeMap[m[1]] = m[2];

    const surfaced = new Set(triggers.map((t) => typeMap[t] ?? t));
    // Choices set directly as state.pendingChoice (chained / follow-up choices).
    for (const m of choices.matchAll(/pendingChoice\s*=\s*\{\s*type:\s*'([^']+)'/g)) surfaced.add(m[1]);

    // Choice types the client prompt renders.
    const handled = new Set([...prompt.matchAll(/type === '([^']+)'/g)].map((m) => m[1]));

    const missing = [...surfaced].filter((t) => !handled.has(t)).sort();
    expect(missing).toEqual([]);
  });
});

describe('Game initialisation', () => {
  test('starts in active phase', () => {
    const { state } = freshGame();
    expect(state.phase).toBe('active');
  });

  test('both players draw 5 opening hand cards', () => {
    const { state } = freshGame();
    expect(state.players.p1.hand).toHaveLength(5);
    expect(state.players.p2.hand).toHaveLength(5);
  });

  test('deck has 80 cards after opening hands', () => {
    const { state } = freshGame();
    expect(state.zones.deck).toHaveLength(80);
  });

  test('p1 holds priority at start', () => {
    const { state } = freshGame();
    expect(state.activePlayer).toBe('p1');
    expect(state.turn).toBe('p1');
  });
});

// ─── Voiding ─────────────────────────────────────────────────────────────────

describe('Voiding cards', () => {
  test('voiding a card gives 3 energy and removes it from hand', () => {
    const { state } = freshGame();
    const cardId = state.players.p1.hand[0];
    const events = voidCard(state, 'p1', cardId);
    expect(state.players.p1.energy).toBe(3);
    expect(state.players.p1.hand).not.toContain(cardId);
    expect(state.zones.void).toContain(cardId);
    expect(eventTypes(events)).toContain('CARD_VOIDED');
  });

  test('voiding three cards gives 9 energy', () => {
    const { state } = freshGame();
    voidCard(state, 'p1', state.players.p1.hand[0]);
    voidCard(state, 'p1', state.players.p1.hand[0]);
    voidCard(state, 'p1', state.players.p1.hand[0]);
    expect(state.players.p1.energy).toBe(9);
  });

  test('opponent cannot void when they do not hold priority', () => {
    const { state } = freshGame();
    const cardId = state.players.p2.hand[0];
    const events = voidCard(state, 'p2', cardId);
    expect(eventTypes(events)).toContain('ERROR');
    expect(events[0].code).toBe('NOT_YOUR_PRIORITY');
  });
});

// ─── Playing Cards ────────────────────────────────────────────────────────────

describe('Playing cards', () => {
  test('playing a card puts it on the stack and passes priority', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort: action, cost 0
    const events = playCard(state, 'p1', '53');
    expect(eventTypes(events)).not.toContain('ERROR');
    expect(state.zones.stack).toHaveLength(1);
    expect(state.zones.stack[0].cardId).toBe('53');
    expect(state.activePlayer).toBe('p2');
  });

  test('cannot play a card without enough energy', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '58'); // Change of Luck: action, cost 7
    // p1 has 0 energy
    const events = playCard(state, 'p1', '58');
    expect(eventTypes(events)).toContain('ERROR');
    expect(events[0].code).toBe('INVALID_PLAY');
  });

  test('playing a card costs energy', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '58'); // cost 7
    setEnergy(state, 'p1', 9);
    playCard(state, 'p1', '58');
    expect(state.players.p1.energy).toBe(2);
  });

  test('point card cannot be played when stack is not empty', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort: action cost 0
    giveCard(state, 'p1', '04'); // Snatch: point cost 6
    setEnergy(state, 'p1', 9);
    playCard(state, 'p1', '53');
    // now p2 holds priority — pass back to p1
    passPriority(state, 'p2');
    // p1 tries to play a point card with something on the stack
    const events = playCard(state, 'p1', '04');
    expect(eventTypes(events)).toContain('ERROR');
  });

  test('cannot play when not holding priority', () => {
    const { state } = freshGame();
    giveCard(state, 'p2', '53');
    const events = playCard(state, 'p2', '53');
    expect(eventTypes(events)).toContain('ERROR');
    expect(events[0].code).toBe('NOT_YOUR_PRIORITY');
  });

  test('p2 can play an action card in response to p1', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort: action cost 0
    giveCard(state, 'p2', '45'); // Dig for Ideas: action cost 1
    setEnergy(state, 'p2', 3);
    playCard(state, 'p1', '53');
    // p2 now holds priority with something on stack — can respond
    const events = playCard(state, 'p2', '45');
    expect(eventTypes(events)).not.toContain('ERROR');
    expect(state.zones.stack).toHaveLength(2);
  });

  test('cannot respond to your own card with another action', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '55'); // Lost at Sea: action
    giveCard(state, 'p1', '65'); // Enlightenment: action
    giveCard(state, 'p2', '45'); // Dig for Ideas: action
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 9);

    playCard(state, 'p1', '55');   // p1's action on the stack, priority → p2

    // the opponent CAN respond to it
    expect(validatePlay(state, 'p2', '45')).toBe(null);

    passPriority(state, 'p2');     // p2 declines, priority returns to p1

    // p1 may NOT respond to its own card
    expect(validatePlay(state, 'p1', '65')).not.toBe(null);
    const events = playCard(state, 'p1', '65');
    expect(eventTypes(events)).toContain('ERROR');
    expect(state.zones.stack).toHaveLength(1);
  });

  test('isLivePriorityWindow: only your main phase or an opponent\'s card on top', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '55'); // Lost at Sea (action)
    setEnergy(state, 'p1', 20);

    // p1's turn, empty stack → p1's main phase is live; p2 (non-turn, empty
    // stack end-of-turn window) is dead regardless of what it holds.
    expect(isLivePriorityWindow(state, 'p1')).toBe(true);
    expect(isLivePriorityWindow(state, 'p2')).toBe(false);

    playCard(state, 'p1', '55'); // p1's card on the stack
    // p2 has an opponent's card to respond to → live; p1 has only its own → dead
    expect(isLivePriorityWindow(state, 'p2')).toBe(true);
    expect(isLivePriorityWindow(state, 'p1')).toBe(false);
  });

  test('cannot respond on the opponent\'s end-of-turn empty-stack window', () => {
    const { state } = freshGame();
    giveCard(state, 'p2', '45'); // Dig for Ideas: action
    setEnergy(state, 'p2', 9);

    // p1's turn, empty stack: p1 passes → priority to p2 (end-of-turn window)
    passPriority(state, 'p1');
    expect(state.activePlayer).toBe('p2');
    expect(state.turn).toBe('p1');
    expect(state.zones.stack).toHaveLength(0);

    // p2 (non-turn player) cannot sneak in an action
    expect(validatePlay(state, 'p2', '45')).not.toBe(null);
    const events = playCard(state, 'p2', '45');
    expect(eventTypes(events)).toContain('ERROR');
  });
});

// ─── Priority & Stack Resolution ──────────────────────────────────────────────

describe('Priority and stack resolution', () => {
  test('both passing resolves top of stack', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort: action, 0 cost, draw 2 trash 2
    playCard(state, 'p1', '53');
    passPriority(state, 'p2');
    const events = passPriority(state, 'p1');
    expect(eventTypes(events)).toContain('CARD_RESOLVING');
    expect(eventTypes(events)).toContain('CARD_TRASHED');
    expect(state.zones.stack).toHaveLength(0);
  });

  test('stack resolves top-down (LIFO)', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort: action cost 0
    giveCard(state, 'p2', '45'); // Dig for Ideas: action cost 1
    setEnergy(state, 'p2', 3);

    playCard(state, 'p1', '53'); // stack: [53]
    playCard(state, 'p2', '45'); // stack: [45, 53]
    passPriority(state, 'p1');
    const events = passPriority(state, 'p2'); // resolves top = 45

    const resolvingEvent = events.find(e => e.type === 'CARD_RESOLVING');
    expect(resolvingEvent.cardId).toBe('45'); // top resolves first
    expect(state.zones.stack).toHaveLength(1); // 53 still pending
    expect(state.zones.stack[0].cardId).toBe('53');
  });

  test('after stack resolution active turn player gets priority', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53');
    playCard(state, 'p1', '53');
    passPriority(state, 'p2');
    passPriority(state, 'p1');
    expect(state.activePlayer).toBe('p1'); // p1's turn, gets priority back
  });

  test('empty stack + both pass = end turn', () => {
    const { state } = freshGame();
    passPriority(state, 'p1');
    const events = passPriority(state, 'p2');
    expect(eventTypes(events)).toContain('TURN_ENDED');
    expect(state.turn).toBe('p2');
  });
});

// ─── End of Turn ──────────────────────────────────────────────────────────────

describe('End of turn', () => {
  test('energy is wiped at end of turn', () => {
    const { state } = freshGame();
    setEnergy(state, 'p1', 6);
    setEnergy(state, 'p2', 3);
    passPriority(state, 'p1');
    passPriority(state, 'p2');
    expect(state.players.p1.energy).toBe(0);
    expect(state.players.p2.energy).toBe(0);
  });

  test('trash moves to void at end of turn', () => {
    const { state } = freshGame();
    state.zones.trash.push('53');
    passPriority(state, 'p1');
    passPriority(state, 'p2');
    expect(state.zones.trash).toHaveLength(0);
    expect(state.zones.void).toContain('53');
  });

  test('current player draws up to 5 at end of turn', () => {
    const { state } = freshGame();
    // p1 voids 3 cards, hand down to 2
    voidCard(state, 'p1', state.players.p1.hand[0]);
    voidCard(state, 'p1', state.players.p1.hand[0]);
    voidCard(state, 'p1', state.players.p1.hand[0]);
    expect(state.players.p1.hand).toHaveLength(2);
    passPriority(state, 'p1');
    passPriority(state, 'p2');
    expect(state.players.p1.hand).toHaveLength(5);
  });

  test('p2 draws up to 5 at end of p1\'s first turn', () => {
    const { state } = freshGame();
    // p2 starts with 5 cards (opening hand drawn at start)
    // p2 should still have 5 after p1's first turn ends
    passPriority(state, 'p1');
    passPriority(state, 'p2');
    expect(state.players.p2.hand).toHaveLength(5);
  });

  test('turn passes to p2 after p1\'s turn', () => {
    const { state } = freshGame();
    passPriority(state, 'p1');
    passPriority(state, 'p2');
    expect(state.turn).toBe('p2');
    expect(state.activePlayer).toBe('p2');
  });
});

// ─── Void Reshuffle ───────────────────────────────────────────────────────────

describe('Deck exhaustion', () => {
  test('void is shuffled into deck when deck runs out', () => {
    const { state } = freshGame();
    // Drain the deck
    state.zones.void.push(...state.zones.deck);
    state.zones.deck = [];
    state.zones.void.push('53');
    // Drawing should reshuffle void into deck
    drawCards(state, 'p1', 1);
    expect(state.players.p1.hand.length).toBeGreaterThan(5);
    expect(state.zones.void).toHaveLength(0);
  });
});

// ─── Points & Win Condition ───────────────────────────────────────────────────

describe('Points and win condition', () => {
  test('playing a point card and resolving it grants 1 point', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '04'); // Snatch: point cost 6, draw a card
    setEnergy(state, 'p1', 9);
    playCard(state, 'p1', '04');
    passPriority(state, 'p2');
    passPriority(state, 'p1');
    expect(state.players.p1.points).toBe(1);
  });

  test('reaching 5 points ends the game immediately', () => {
    const { state } = freshGame();
    state.players.p1.points = 4;
    giveCard(state, 'p1', '04'); // Snatch: point
    setEnergy(state, 'p1', 9);
    playCard(state, 'p1', '04');
    passPriority(state, 'p2');
    const events = passPriority(state, 'p1');
    expect(state.winner).toBe('p1');
    expect(state.phase).toBe('ended');
    expect(eventTypes(events)).toContain('GAME_OVER');
  });

  test('Sprint (01) gives 2 points total when it resolves', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '01'); // Sprint: point cost 7, gain additional point
    setEnergy(state, 'p1', 9);
    playCard(state, 'p1', '01');
    passPriority(state, 'p2');
    passPriority(state, 'p1');
    expect(state.players.p1.points).toBe(2);
  });
});

// ─── Cost Modifiers ───────────────────────────────────────────────────────────

describe('Cost modifiers', () => {
  test('Delve (03): costs 1 less per card in trash', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '03'); // Delve: point cost 6
    state.zones.trash.push('53', '45', '48'); // 3 cards in trash
    setEnergy(state, 'p1', 4); // needs exactly 3 after discount
    const events = playCard(state, 'p1', '03');
    expect(eventTypes(events)).not.toContain('ERROR');
    expect(state.players.p1.energy).toBe(1); // 4 - 3 = 1
  });

  test('Overwhelm (17): costs 1 less per card on stack, response only', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort: action cost 0
    giveCard(state, 'p2', '17'); // Overwhelm: point cost 7, 1 less per stack card
    setEnergy(state, 'p2', 9);
    playCard(state, 'p1', '53'); // stack has 1 card
    // cost = 7 - 1 = 6
    const events = playCard(state, 'p2', '17');
    expect(eventTypes(events)).not.toContain('ERROR');
    expect(state.players.p2.energy).toBe(3); // 9 - 6 = 3
  });

  test('Quad (26): only playable with exactly 4 energy', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '26'); // Quad: point cost 4, exactly 4 energy required
    setEnergy(state, 'p1', 5);
    const events = playCard(state, 'p1', '26');
    expect(eventTypes(events)).toContain('ERROR');
  });

  test('Quad (26): playable with exactly 4 energy', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '26');
    setEnergy(state, 'p1', 4);
    const events = playCard(state, 'p1', '26');
    expect(eventTypes(events)).not.toContain('ERROR');
  });
});

// ─── Static Effects ───────────────────────────────────────────────────────────

describe('Static effects', () => {
  test('Unstoppable (00): no cards can be played while on stack', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '00'); // Unstoppable: point cost 7
    giveCard(state, 'p2', '45'); // Dig for Ideas: action cost 1
    setEnergy(state, 'p1', 9);
    setEnergy(state, 'p2', 3);
    playCard(state, 'p1', '00');
    const events = playCard(state, 'p2', '45');
    expect(eventTypes(events)).toContain('ERROR');
    expect(events[0].message).toMatch(/cannot be played/i);
  });

  test('Paranoia (23): controller cannot play cards while on stack', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '23'); // Paranoia: point cost 4, controller locked
    giveCard(state, 'p1', '53'); // Sort: action cost 0
    giveCard(state, 'p2', '45'); // Dig for Ideas
    setEnergy(state, 'p1', 9);
    setEnergy(state, 'p2', 3);
    playCard(state, 'p1', '23'); // Paranoia on stack, p2 gets priority
    // p2 CAN play immediately (Paranoia only locks its controller, p1)
    const p2events = playCard(state, 'p2', '45');
    expect(eventTypes(p2events)).not.toContain('ERROR');
    // Resolve stack fully, then p1 tries to play while Paranoia still on stack
    // (reset to test p1 lock: put Paranoia back on stack manually)
    // Instead test p1 lock by checking after p2 plays and p1 gets priority
    passPriority(state, 'p1'); // p2 gets priority
    passPriority(state, 'p2'); // resolves p2's card (45), p1 gets priority
    // Paranoia still on stack — p1 tries Sort
    const lockEvents = playCard(state, 'p1', '53');
    expect(eventTypes(lockEvents)).toContain('ERROR');
  });

  test('Erase Reason (11): must be first card, locks self from playing', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '11'); // Erase Reason: point cost 0, first card only
    giveCard(state, 'p1', '53');
    setEnergy(state, 'p1', 0);
    playCard(state, 'p1', '11');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // resolves
    // p1 now locked from playing for rest of turn
    expect(state.players.p1.lockedFromPlaying).toBe(true);
  });

  test('Stifle Speech (52): opponent cannot play after it resolves', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '52'); // Stifle Speech: action cost 1
    giveCard(state, 'p2', '45'); // Dig for Ideas
    setEnergy(state, 'p1', 3);
    setEnergy(state, 'p2', 3);
    playCard(state, 'p1', '52');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // resolves — opponent locked
    passPriority(state, 'p1'); // p1 passes, p2 gets priority
    const events = playCard(state, 'p2', '45');
    expect(eventTypes(events)).toContain('ERROR');
  });
});

// ─── Special Card Interactions ────────────────────────────────────────────────

describe('Special card interactions', () => {
  test('Strafe (06): can only be played in response to actions', () => {
    const { state } = freshGame();
    giveCard(state, 'p2', '06'); // Strafe: point cost 5, response to actions only
    setEnergy(state, 'p2', 9);
    // Try to play when stack is empty (own turn) — should fail
    // But it's p1's turn, so p2 can only respond
    // First, get p2 priority by p1 playing an action
    giveCard(state, 'p1', '53');
    playCard(state, 'p1', '53');
    // Now p2 has priority with an action on the stack — valid
    const events = playCard(state, 'p2', '06');
    expect(eventTypes(events)).not.toContain('ERROR');
  });

  test('Insanity (18): hand is trashed when card hits stack', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '18'); // Insanity: point cost 3
    setEnergy(state, 'p1', 9);
    const handSizeBefore = state.players.p1.hand.length;
    playCard(state, 'p1', '18');
    // Hand (excluding Insanity itself which moved to stack) should be empty
    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.zones.trash.length).toBe(handSizeBefore - 1); // minus Insanity itself
  });

  test('Sneak (08): additional cost puts a card on top of deck', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '08'); // Sneak: point cost 2, put hand card on deck top
    setEnergy(state, 'p1', 9);
    const events = playCard(state, 'p1', '08');
    // Should require an additional cost choice
    expect(eventTypes(events)).toContain('ADDITIONAL_COST_REQUIRED');
  });

  test('Sow (29): each player gains energy when anyone plays a card', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '29'); // Sow: point cost 5
    giveCard(state, 'p2', '53'); // Sort: action cost 0
    setEnergy(state, 'p1', 9);
    playCard(state, 'p1', '29'); // Sow on stack, priority to p2
    const energyBefore_p1 = state.players.p1.energy;
    const energyBefore_p2 = state.players.p2.energy;
    const events = playCard(state, 'p2', '53');
    // Both should gain 1 energy from Sow's trigger
    expect(state.players.p1.energy).toBe(energyBefore_p1 + 1);
    expect(state.players.p2.energy).toBe(energyBefore_p2 + 1);
  });

  test('Trip (37): trashes itself when 4th card is played', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '37'); // Trip: point cost 4
    giveCard(state, 'p2', '53'); // Sort
    giveCard(state, 'p1', '65'); // Enlightenment cost 0
    giveCard(state, 'p2', '56'); // Debilitate cost 0
    setEnergy(state, 'p1', 9);
    setEnergy(state, 'p2', 9);

    // Players alternate responses (each onto the OPPONENT's card) so Trip stays
    // on the stack while four cards get played this turn.
    playCard(state, 'p1', '37'); // card 1, Trip (point) on stack, priority → p2
    playCard(state, 'p2', '53'); // card 2, responds to Trip
    playCard(state, 'p1', '65'); // card 3, responds to Sort
    // Playing the 4th card should trigger Trip to trash itself
    const events = playCard(state, 'p2', '56'); // card 4, responds to Enlightenment
    expect(eventTypes(events)).toContain('CARD_TRASHED_BY_TRIGGER');
    // Trip (37) should no longer be on the stack
    expect(state.zones.stack.map(e => e.cardId)).not.toContain('37');
  });
});

// ─── Stack-targeting choices ────────────────────────────────────────────────────

describe('Stack-targeting choices', () => {
  // Regression: stack-choice triggers must tag the chooser via `player`, not
  // `chooser`. With the wrong field the choice has no `player`, so the server
  // shows "waiting for opponent" to both players and no one can select a card.
  test('trashFromStack tags the choosing player on the trigger', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort: action cost 0
    giveCard(state, 'p2', '44'); // Stop: action, trashFromStack any
    setEnergy(state, 'p2', 9);

    playCard(state, 'p1', '53'); // stack: [53], p2 has priority
    playCard(state, 'p2', '44'); // p2 responds: stack [44, 53]
    passPriority(state, 'p1');
    passPriority(state, 'p2');   // Stop resolves → trashFromStack choice for p2

    const trigger = state.pendingTriggers.find(t => t.type === 'trashFromStackChoice');
    expect(trigger).not.toBe(undefined);
    expect(trigger.player).toBe('p2');
  });
});

// ─── Additional costs ───────────────────────────────────────────────────────────

describe('Additional costs', () => {
  // Mirrors how the server surfaces a queued trigger as the pending choice.
  function surfaceChoice(state, triggerType) {
    const t = state.pendingTriggers.find(x => x.type === triggerType);
    if (!t) return null;
    state.pendingChoice = { ...t, type: 'additionalCost' };
    state.pendingTriggers = state.pendingTriggers.filter(x => x !== t);
    return state.pendingChoice;
  }

  test('Sneak (08): additional cost is required and resolves a card onto the deck', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '08'); // Sneak: point, additionalCost putHandCardOnDeckTop
    giveCard(state, 'p1', '53'); // spare card to pay the cost
    setEnergy(state, 'p1', 9);

    const events = playCard(state, 'p1', '08');
    expect(eventTypes(events)).toContain('ADDITIONAL_COST_REQUIRED');

    // The trigger must tag the paying player so the server can route it.
    const choice = surfaceChoice(state, 'additionalCost');
    expect(choice).not.toBe(null);
    expect(choice.player).toBe('p1');
    expect(choice.cost.type).toBe('putHandCardOnDeckTop');

    const { error } = resolveChoice(state, 'p1', { cardId: '53' });
    expect(error).toBe(null);
    expect(state.players.p1.hand).not.toContain('53');
    expect(state.zones.deck[0]).toBe('53');
    expect(state.pendingChoice).toBe(null);
  });
});

// ─── Deferred (start-of-next-turn) draws ────────────────────────────────────────

describe('Deferred draws', () => {
  // Regression: Prepare's "draw a card at the start of the next turn" must add
  // a card on top of the 5-card refill, not get absorbed by draw-up-to-5.
  test('Prepare (50) yields a net extra card despite the refill', () => {
    const baseline = (() => {
      const { state } = freshGame();
      // void 3 cards so the hand is below 5 at end of turn (the absorbing case)
      const toVoid = state.players.p1.hand.slice(0, 3);
      for (const c of toVoid) voidCard(state, 'p1', c);
      passPriority(state, 'p1');
      passPriority(state, 'p2');
      return state.players.p1.hand.length;
    })();

    const { state } = freshGame();
    giveCard(state, 'p1', '50'); // Prepare: action, draw 1 at start of next turn
    const toVoid = state.players.p1.hand.filter(c => c !== '50').slice(0, 3);
    for (const c of toVoid) voidCard(state, 'p1', c);
    playCard(state, 'p1', '50');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // Prepare resolves → deferred draw
    passPriority(state, 'p1');
    passPriority(state, 'p2'); // p1 turn ends

    expect(state.players.p1.hand.length).toBe(baseline + 1);
  });
});

// ─── Consult the Past (38): play from trash ─────────────────────────────────────

describe('Consult the Past (38)', () => {
  test('lets its controller play a trashed card in response to the opponent', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '38'); // Consult the Past (point)
    giveCard(state, 'p2', '56'); // Debilitate (action) — p2's response
    state.zones.trash.push('53'); // an action in the trash
    setEnergy(state, 'p1', 9);
    setEnergy(state, 'p2', 9);

    playCard(state, 'p1', '38'); // Consult on the stack, priority → p2
    expect(canPlayFromTrash(state, 'p1')).toBe(true);
    expect(canPlayFromTrash(state, 'p2')).toBe(false);

    playCard(state, 'p2', '56'); // p2 responds; its action is now on top

    // p1 may now play the trashed action in response to the opponent's card
    const ev = playCard(state, 'p1', '53', { fromTrash: true });
    expect(ev.some(e => e.type === 'ERROR')).toBe(false);
    expect(state.zones.trash).not.toContain('53');
    expect(state.zones.stack[0].cardId).toBe('53');
  });

  test('still enforces timing — cannot play from trash onto your own Consult', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '38'); // Consult the Past (point)
    state.zones.trash.push('53'); // an action in the trash
    setEnergy(state, 'p1', 9);

    playCard(state, 'p1', '38'); // Consult on the stack, priority → p2
    passPriority(state, 'p2');   // priority returns to p1, own Consult on top

    // the grant is active, but timing forbids responding to your own card
    expect(canPlayFromTrash(state, 'p1')).toBe(true);
    expect(validatePlay(state, 'p1', '53', { fromTrash: true })).not.toBe(null);
  });
});

// ─── Choice effects with insufficient resources ─────────────────────────────────

describe('Choice effects with insufficient resources', () => {
  test('Mulled Over (12): a player who can\'t trash is skipped, not locked', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['12']; // only Mulled Over
    state.players.p2.hand = [];     // empty
    setEnergy(state, 'p1', 9);

    playCard(state, 'p1', '12');    // point on stack
    passPriority(state, 'p2');
    passPriority(state, 'p1');      // resolves: grant point + each player trashes

    // neither player can trash → no stuck choice
    expect(state.pendingTriggers.find(t => t.type === 'trashFromHandChoice')).toBe(undefined);
    expect(state.players.p1.points).toBe(1);
  });

  test('Mulled Over (12): only players who can trash get the choice', () => {
    const { state } = freshGame();
    state.players.p1.hand = ['12', '53']; // Mulled Over + a spare card
    state.players.p2.hand = [];           // empty
    setEnergy(state, 'p1', 9);

    playCard(state, 'p1', '12');
    passPriority(state, 'p2');
    passPriority(state, 'p1');

    const triggers = state.pendingTriggers.filter(t => t.type === 'trashFromHandChoice');
    expect(triggers.length).toBe(1);
    expect(triggers[0].player).toBe('p1');
  });
});

// ─── Additional cost affordability ──────────────────────────────────────────────

describe('Additional cost affordability', () => {
  test('Vitalize (25): unplayable without a card to pay its additional cost', () => {
    const { state } = freshGame();
    setEnergy(state, 'p1', 9);

    state.players.p1.hand = ['25'];          // only Vitalize — nothing to trash
    expect(validatePlay(state, 'p1', '25')).not.toBe(null);

    state.players.p1.hand = ['25', '53'];    // a spare card to pay with
    expect(validatePlay(state, 'p1', '25')).toBe(null);
  });

  test('Sneak (08): unplayable without a card to put on the deck', () => {
    const { state } = freshGame();
    setEnergy(state, 'p1', 9);

    state.players.p1.hand = ['08'];          // only Sneak
    expect(validatePlay(state, 'p1', '08')).not.toBe(null);

    state.players.p1.hand = ['08', '53'];
    expect(validatePlay(state, 'p1', '08')).toBe(null);
  });
});

// ─── Free play ("may play a card for 0") ────────────────────────────────────────

describe('Free play for 0', () => {
  // Mimic the server: when a choice emits FREE_PLAY_CONFIRMED, the card is
  // played onto the stack for free.
  function completeFreePlay(state, events) {
    for (const ev of events) {
      if (ev.type === 'FREE_PLAY_CONFIRMED') playCard(state, ev.player, ev.cardId, { free: true });
    }
  }

  function trashFromStackTo(state, chooser, cardId) {
    const t = state.pendingTriggers.find(x => x.type === 'trashFromStackChoice');
    state.pendingChoice = { ...t, type: 'trashFromStack' };
    state.pendingTriggers = state.pendingTriggers.filter(x => x !== t);
    const idx = state.zones.stack.findIndex(e => e.cardId === cardId);
    return resolveChoice(state, chooser, { stackIndex: idx });
  }

  test('Metamorphosis (61): trashed card\'s controller may play a point from hand for 0', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '04'); // Snatch (point) — p1's card, to be trashed
    giveCard(state, 'p1', '01'); // Sprint (point) — to free-play from hand
    giveCard(state, 'p2', '61'); // Metamorphosis
    setEnergy(state, 'p1', 9); setEnergy(state, 'p2', 9);

    playCard(state, 'p1', '04');  // point on stack
    playCard(state, 'p2', '61');  // Metamorphosis in response
    passPriority(state, 'p1');
    passPriority(state, 'p2');    // Metamorphosis resolves → trash choice for p2

    const r1 = trashFromStackTo(state, 'p2', '04'); // p2 trashes p1's point
    expect(r1.error).toBe(null);
    // thenGrant must surface (not be nulled) for p1, the trashed card's controller
    expect(state.pendingChoice?.type).toBe('mayPlayFromHand');
    expect(state.pendingChoice.player).toBe('p1');

    const energyBefore = state.players.p1.energy;
    const r2 = resolveChoice(state, 'p1', { play: true, cardId: '01' });
    expect(r2.error).toBe(null);
    completeFreePlay(state, r2.events);

    expect(state.zones.stack[0].cardId).toBe('01');         // played onto the stack
    expect(state.players.p1.energy).toBe(energyBefore);     // for free
    expect(state.players.p1.hand).not.toContain('01');
  });

  test('Reinstate (84): trashed action\'s controller may play the top of deck for 0', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort (action) — p1's card, to be trashed
    giveCard(state, 'p2', '84'); // Reinstate
    setEnergy(state, 'p1', 9); setEnergy(state, 'p2', 9);
    state.zones.deck = state.zones.deck.filter(id => id !== '01');
    state.zones.deck.unshift('01'); // Sprint on top of the deck

    playCard(state, 'p1', '53');  // action on stack
    playCard(state, 'p2', '84');  // Reinstate in response
    passPriority(state, 'p1');
    passPriority(state, 'p2');    // Reinstate resolves → trash choice for p2

    const r1 = trashFromStackTo(state, 'p2', '53');
    expect(r1.error).toBe(null);
    expect(state.pendingChoice?.type).toBe('mayPlayTopOfDeck');
    expect(state.pendingChoice.cardId).toBe('01'); // top card revealed

    const r2 = resolveChoice(state, 'p1', { play: true });
    expect(r2.error).toBe(null);
    completeFreePlay(state, r2.events);

    expect(state.zones.stack[0].cardId).toBe('01'); // top card played for free
    expect(state.zones.deck).not.toContain('01');
  });

  test('Predict (54): playing the guessed card puts it on the stack', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '54'); // Predict
    setEnergy(state, 'p1', 9);
    state.zones.deck = state.zones.deck.filter(id => id !== '53');
    state.zones.deck.unshift('53'); // Sort (cost 0) on top

    playCard(state, 'p1', '54');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // resolves → chooseNumber

    const t = state.pendingTriggers.find(x => x.type === 'chooseNumber');
    state.pendingChoice = { ...t, type: 'chooseNumber' };
    state.pendingTriggers = state.pendingTriggers.filter(x => x !== t);
    resolveChoice(state, 'p1', { number: 0 }); // match → confirmFreePlay
    expect(state.pendingChoice?.type).toBe('confirmFreePlay');

    const r = resolveChoice(state, 'p1', { play: true });
    expect(r.error).toBe(null);
    completeFreePlay(state, r.events);
    expect(state.zones.stack[0].cardId).toBe('53'); // played onto the stack
  });
});

// ─── Injustice (67): protect next action only ───────────────────────────────────

describe('Injustice (67)', () => {
  test('protects only the next action played, not all responses', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '67'); // Injustice: action
    giveCard(state, 'p1', '55'); // protected action A (Lost at Sea — clean draw)
    giveCard(state, 'p1', '65'); // later action B (Enlightenment)
    giveCard(state, 'p2', '45'); // p2's responder action (Dig for Ideas)
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 9);

    // Play & resolve Injustice
    playCard(state, 'p1', '67');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // resolves → arms protection for p1
    expect(state.turnFlags.protectNextSelfAction).toBe('p1');

    // p1 plays the protected action A
    playCard(state, 'p1', '55');
    expect(state.zones.stack[0].responsesLocked).toBe(true);
    expect(state.turnFlags.protectNextSelfAction).toBe(null); // consumed

    // p2 cannot play an action in response to A
    expect(validatePlay(state, 'p2', '45')).not.toBe(null);
    // p1 also cannot stack another action onto its own card
    expect(validatePlay(state, 'p1', '65')).not.toBe(null);

    // let A resolve (p2 passes, then p1 passes), clearing the stack
    passPriority(state, 'p2');
    passPriority(state, 'p1');
    expect(state.zones.stack).toHaveLength(0);

    // p1 plays a second action B (not protected)
    playCard(state, 'p1', '65');
    expect(state.zones.stack[0].responsesLocked).toBe(false);

    // now p2 CAN respond with an action (only the next action was protected)
    expect(validatePlay(state, 'p2', '45')).toBe(null);
  });
});

// ─── Kinship (revealTopN + opponentChoosesOne) ──────────────────────────────────

describe('Kinship (46): revealTopN + opponentChoosesOne', () => {
  test('opponent keeps one of four revealed cards, caster gets the rest', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '46'); // Kinship: action
    setEnergy(state, 'p1', 9);
    // Known top four
    state.zones.deck = state.zones.deck.filter(id => !['00', '04', '53', '45'].includes(id));
    state.zones.deck.unshift('00', '04', '53', '45'); // top four
    const p1HandBefore = state.players.p1.hand.length;
    const p2HandBefore = state.players.p2.hand.length;

    playCard(state, 'p1', '46');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // resolves → opponent (p2) chooses

    const trigger = state.pendingTriggers.find(t => t.type === 'opponentChoosesOne');
    expect(trigger).not.toBe(undefined);
    expect(trigger.player).toBe('p2');               // the opponent chooses
    expect(trigger.revealedCards).toEqual(['00', '04', '53', '45']);

    state.pendingChoice = { ...trigger, type: 'opponentChoosesOne' };
    state.pendingTriggers = state.pendingTriggers.filter(t => t !== trigger);
    const { error } = resolveChoice(state, 'p2', { cardId: '53' }); // p2 keeps 53

    expect(error).toBe(null);
    expect(state.players.p2.hand).toContain('53');          // opponent kept the chosen card
    expect(state.players.p2.hand.length).toBe(p2HandBefore + 1);
    // caster (p1) gets the other three revealed cards
    for (const id of ['00', '04', '45']) expect(state.players.p1.hand).toContain(id);
  });
});

// ─── Predict (chooseNumber) ─────────────────────────────────────────────────────

describe('Predict (54): chooseNumber', () => {
  test('guessing the top card cost offers a free play', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '54'); // Predict: action
    setEnergy(state, 'p1', 9);
    state.zones.deck = state.zones.deck.filter(id => id !== '53');
    state.zones.deck.unshift('53'); // Sort (cost 0) on top

    playCard(state, 'p1', '54');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // resolves → chooseNumber choice

    const trigger = state.pendingTriggers.find(t => t.type === 'chooseNumber');
    expect(trigger).not.toBe(undefined);
    state.pendingChoice = { ...trigger, type: 'chooseNumber' };
    state.pendingTriggers = state.pendingTriggers.filter(t => t !== trigger);
    const { error } = resolveChoice(state, 'p1', { number: 0 }); // Sort costs 0 → match

    expect(error).toBe(null);
    expect(state.pendingChoice?.type).toBe('confirmFreePlay');
    expect(state.pendingChoice.cardId).toBe('53');
  });
});

// ─── Reveal hand + trash (Inquisition / Cerebral Snuff) ─────────────────────────

describe('chooseCardToTrashFromRevealedHand', () => {
  function resolveTo(state) {
    const trigger = state.pendingTriggers.find(t => t.type === 'chooseCardToTrashFromRevealedHand');
    if (trigger) {
      state.pendingChoice = { ...trigger, type: 'chooseCardToTrashFromRevealedHand' };
      state.pendingTriggers = state.pendingTriggers.filter(t => t !== trigger);
    }
    return state.pendingChoice;
  }

  test('Inquisition (16): trashes a chosen action from the opponent\'s hand', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '16'); // Inquisition: point
    // ensure p2 has an action (53 Sort) and a point (04) in hand
    giveCard(state, 'p2', '53');
    giveCard(state, 'p2', '04');
    setEnergy(state, 'p1', 9);

    playCard(state, 'p1', '16');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // resolves → choice for p1

    const choice = resolveTo(state);
    expect(choice).not.toBe(undefined);
    expect(choice.player).toBe('p1');
    expect(choice.targetPlayer).toBe('p2');
    expect(choice.filter).toBe('action');

    // can't trash a point (filter is action)
    const bad = resolveChoice(state, 'p1', { cardId: '04' });
    expect(bad.error).not.toBe(null);

    const good = resolveChoice(state, 'p1', { cardId: '53' });
    expect(good.error).toBe(null);
    expect(state.players.p2.hand).not.toContain('53');
    expect(state.zones.trash).toContain('53');
  });

  test('Cerebral Snuff (81): trashes any chosen card from the opponent\'s hand', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '81'); // Cerebral Snuff: action
    giveCard(state, 'p2', '04'); // a point — should be trashable (no filter)
    setEnergy(state, 'p1', 9);

    playCard(state, 'p1', '81');
    passPriority(state, 'p2');
    passPriority(state, 'p1');

    const choice = resolveTo(state);
    expect(choice.filter).toBe('any');
    const { error } = resolveChoice(state, 'p1', { cardId: '04' });
    expect(error).toBe(null);
    expect(state.zones.trash).toContain('04');
  });
});

// ─── Search (lookAtTopN) ────────────────────────────────────────────────────────

describe('Search (47): lookAtTopN', () => {
  test('looks at the top two, trashes the chosen one, then draws a card', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '47'); // Search: action
    setEnergy(state, 'p1', 9);
    // Known deck top: 00, 04, 53, ...
    state.zones.deck = state.zones.deck.filter(id => !['00', '04', '53'].includes(id));
    state.zones.deck.unshift('00', '04', '53'); // top order: 00, 04, 53

    playCard(state, 'p1', '47');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // resolves → lookAtTopN choice

    const trigger = state.pendingTriggers.find(t => t.type === 'lookAtTopN');
    expect(trigger).not.toBe(undefined);

    state.pendingChoice = { ...trigger, type: 'lookAtTopN' };
    state.pendingTriggers = state.pendingTriggers.filter(t => t !== trigger);
    const { error } = resolveChoice(state, 'p1', { trashCardId: '04' }); // trash one of the top two

    expect(error).toBe(null);
    expect(state.zones.trash).toContain('04');          // the chosen card was trashed
    expect(state.players.p1.hand).toContain('00');      // then drew the new top (the other looked-at card)
    expect(state.zones.deck[0]).toBe('53');             // 53 remains on top
  });
});

// ─── revealUntilType (Inspiration / Inspect) ────────────────────────────────────

describe('revealUntilType', () => {
  test('Inspect (64): reveals until the chosen type, takes it, rest to deck bottom', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '64'); // Inspect: action
    setEnergy(state, 'p1', 9);
    // Arrange a known deck top: two points then an action.
    for (const id of ['64']) { /* already in hand */ }
    state.zones.deck = state.zones.deck.filter(id => !['00', '04', '53'].includes(id));
    state.zones.deck.unshift('53'); // action (the one to find)
    state.zones.deck.unshift('04'); // point
    state.zones.deck.unshift('00'); // point  → deck top order: 00, 04, 53, ...

    playCard(state, 'p1', '64');
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // resolves → revealUntilType choice for p1

    const trigger = state.pendingTriggers.find(t => t.type === 'revealUntilType');
    expect(trigger).not.toBe(undefined);
    expect(state.pendingTriggers.find(t => t.type === 'chooseCardType')).toBe(undefined); // no dangling step

    state.pendingChoice = { ...trigger, type: 'revealUntilType' };
    state.pendingTriggers = state.pendingTriggers.filter(t => t !== trigger);
    const { error } = resolveChoice(state, 'p1', { cardType: 'action' });

    expect(error).toBe(null);
    expect(state.players.p1.hand).toContain('53');        // found action taken to hand
    expect(state.zones.deck.slice(-2)).toEqual(['00', '04']); // the two points went to deck bottom
  });
});

// ─── trashUnlessControllerPays ──────────────────────────────────────────────────

describe('trashUnlessControllerPays', () => {
  // Set up: p1 plays an action, p2 plays the counter in response, both pass so the
  // counter resolves → choice goes to the targeted card's controller (p1).
  function setupCounter(counterId, casterEnergy = 9) {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort: action — p1's card, will be the target
    giveCard(state, 'p2', counterId);
    setEnergy(state, 'p2', casterEnergy);
    setEnergy(state, 'p1', 9);
    playCard(state, 'p1', '53');         // stack: [53] (p1's)
    playCard(state, 'p2', counterId);    // stack: [counter, 53]
    passPriority(state, 'p1');
    passPriority(state, 'p2');           // counter resolves → caster (p2) targets

    // Step 1: caster (p2) chooses the target card (the Sort).
    const t1 = state.pendingTriggers.find(t => t.type === 'trashUnlessControllerPaysTarget');
    if (t1) {
      state.pendingChoice = { ...t1, type: 'trashUnlessControllerPaysTarget' };
      state.pendingTriggers = state.pendingTriggers.filter(t => t !== t1);
      const idx = state.zones.stack.findIndex(e => e.cardId === '53');
      resolveChoice(state, 'p2', { stackIndex: idx }); // → step 2 choice for p1
    }
    return { state, trigger: state.pendingChoice };
  }

  test('Poke (87): choice goes to the targeted card\'s controller', () => {
    const { trigger } = setupCounter('87');
    expect(trigger).not.toBe(undefined);
    expect(trigger.player).toBe('p1');       // p1 controls the targeted Sort
    expect(trigger.targetCardId).toBe('53');
  });

  test('Poke (87): declining trashes the card', () => {
    const { state } = setupCounter('87');
    const { error } = resolveChoice(state, 'p1', { pay: false });
    expect(error).toBe(null);
    expect(state.zones.stack.find(e => e.cardId === '53')).toBe(undefined);
    expect(state.zones.trash).toContain('53');
  });

  test('Poke (87): paying energy saves the card', () => {
    const { state } = setupCounter('87');
    const before = state.players.p1.energy;
    const { error } = resolveChoice(state, 'p1', { pay: true });
    expect(error).toBe(null);
    expect(state.players.p1.energy).toBe(before - 1); // Poke ransom = 1 energy
    expect(state.zones.stack.find(e => e.cardId === '53')).not.toBe(undefined); // survived
  });

  test('Overconfidence (71): paying puts a trash card on the deck bottom', () => {
    const { state } = setupCounter('71');
    state.zones.trash.push('22'); // ensure a trash card to pay with
    const { error } = resolveChoice(state, 'p1', { pay: true });
    expect(error).toBe(null);
    // Pay opens a follow-up choice to pick the trash card
    expect(state.pendingChoice?.type).toBe('putFromTrashToDeckBottom');
    const deckLenBefore = state.zones.deck.length;
    const r2 = resolveChoice(state, 'p1', { cardIds: ['22'] });
    expect(r2.error).toBe(null);
    expect(state.zones.trash).not.toContain('22');
    expect(state.zones.deck[state.zones.deck.length - 1]).toBe('22'); // bottom
    expect(state.zones.deck.length).toBe(deckLenBefore + 1);
    expect(state.zones.stack.find(e => e.cardId === '53')).not.toBe(undefined); // survived
  });
});

// ─── Regret (moveFromStackToDeckTop) ────────────────────────────────────────────

describe('Regret (41): moveFromStackToDeckTop', () => {
  test('puts a chosen stack card on top of the deck', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '53'); // Sort: action — will sit on the stack as the target
    giveCard(state, 'p2', '41'); // Regret: action
    setEnergy(state, 'p2', 9);

    playCard(state, 'p1', '53');  // stack: [53]
    playCard(state, 'p2', '41');  // p2 responds: stack [41, 53]
    passPriority(state, 'p1');
    passPriority(state, 'p2');    // Regret resolves → choice for p2

    const trigger = state.pendingTriggers.find(t => t.type === 'moveFromStackToDeckTop');
    expect(trigger).not.toBe(undefined);
    expect(trigger.player).toBe('p2');

    // surface + resolve: move card 53 (still on the stack) to the top of the deck
    state.pendingChoice = { ...trigger, type: 'moveFromStackToDeckTop' };
    state.pendingTriggers = state.pendingTriggers.filter(t => t !== trigger);
    const idx = state.zones.stack.findIndex(e => e.cardId === '53');
    const { error } = resolveChoice(state, 'p2', { stackIndex: idx });

    expect(error).toBe(null);
    expect(state.zones.deck[0]).toBe('53');
    expect(state.zones.stack.find(e => e.cardId === '53')).toBe(undefined);
  });
});

// ─── Stack-target effects with no legal target ──────────────────────────────────

describe('Stack-target effects without a legal target', () => {
  // Regression: a stack-targeting effect with no legal target must be skipped,
  // not create an impossible choice that hardlocks the game.
  test('Deny Hostility (69) with no valid target is skipped, not stuck', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '69'); // Deny Hostility: trashFromStack actionPlayedInResponseToPoint
    setEnergy(state, 'p1', 3);

    playCard(state, 'p1', '69'); // alone on the stack
    passPriority(state, 'p2');
    const events = passPriority(state, 'p1'); // resolves with nothing else on the stack

    expect(eventTypes(events)).toContain('NO_VALID_TARGETS');
    expect(state.pendingTriggers.find(t => t.type === 'trashFromStackChoice')).toBe(undefined);
  });

  test('Deny Hostility (69) trashes an action played in response to a point', () => {
    const { state } = freshGame();
    giveCard(state, 'p1', '04'); // Snatch: point
    giveCard(state, 'p2', '53'); // Sort: action
    giveCard(state, 'p1', '69'); // Deny Hostility
    setEnergy(state, 'p1', 20);
    setEnergy(state, 'p2', 20);

    playCard(state, 'p1', '04'); // point on stack
    playCard(state, 'p2', '53'); // action in response to the point
    playCard(state, 'p1', '69'); // Deny Hostility in response
    passPriority(state, 'p2');
    passPriority(state, 'p1'); // Deny Hostility resolves → choice for p1

    const trigger = state.pendingTriggers.find(t => t.type === 'trashFromStackChoice');
    expect(trigger).not.toBe(undefined);

    // Mirror the server surfacing the trigger, then resolve it.
    state.pendingChoice = { ...trigger, type: 'trashFromStack' };
    state.pendingTriggers = state.pendingTriggers.filter(t => t !== trigger);
    const idx = state.zones.stack.findIndex(e => e.cardId === '53');
    const { error } = resolveChoice(state, 'p1', { stackIndex: idx });

    expect(error).toBe(null);
    expect(state.zones.trash).toContain('53');
  });
});
