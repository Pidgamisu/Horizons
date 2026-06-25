import { createGameState, drawCards, opponent, initDeck } from '../src/engine/state.js';
import { startGame, playCard, passPriority, voidCard, endTurn } from '../src/engine/game.js';

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
  // Put a specific card in a player's hand (remove from deck if present)
  const di = state.zones.deck.indexOf(cardId);
  if (di !== -1) state.zones.deck.splice(di, 1);
  state.players[playerId].hand.push(cardId);
}

function setEnergy(state, playerId, amount) {
  state.players[playerId].energy = amount;
}

// ─── Initialisation ───────────────────────────────────────────────────────────

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
    giveCard(state, 'p1', '53'); // Sort
    giveCard(state, 'p1', '65'); // Enlightenment cost 0
    giveCard(state, 'p1', '66'); // By Any Means cost 0
    giveCard(state, 'p2', '56'); // Debilitate cost 0
    setEnergy(state, 'p1', 9);

    playCard(state, 'p1', '37'); // card 1, Trip on stack
    passPriority(state, 'p2');   // p1 gets priority
    playCard(state, 'p1', '53'); // card 2
    passPriority(state, 'p2');
    playCard(state, 'p1', '65'); // card 3
    passPriority(state, 'p2');
    // Playing the 4th card should trigger Trip to trash itself
    const events = playCard(state, 'p1', '66'); // card 4
    expect(eventTypes(events)).toContain('CARD_TRASHED_BY_TRIGGER');
    // Trip (37) should no longer be on the stack
    expect(state.zones.stack.map(e => e.cardId)).not.toContain('37');
  });
});
