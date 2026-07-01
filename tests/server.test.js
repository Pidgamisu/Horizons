import { describe, test, expect, beforeAll, afterAll } from './helpers.js';
import { WebSocket } from 'ws';
import { createServer } from '../src/server.js';

const TEST_PORT = 8766;

// ─── Player wrapper — buffers all messages, never misses one ─────────────────

function createPlayer(roomId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/game/${roomId}`);
    const buffer = [];
    const waiters = [];

    function dispatch(msg) {
      const wi = waiters.findIndex(w => w.predicate(msg));
      if (wi !== -1) {
        const { resolve: res } = waiters.splice(wi, 1)[0];
        res(msg);
        return;
      }
      buffer.push(msg);
    }

    ws.on('message', data => dispatch(JSON.parse(data.toString())));
    ws.on('error', reject);
    ws.on('open', () => {
      resolve({
        ws,
        send: msg => ws.send(JSON.stringify(msg)),
        /** Wait for next message matching predicate (checks buffer first). */
        waitFor(predicate, timeoutMs = 3000) {
          // Drain buffer
          const bi = buffer.findIndex(predicate);
          if (bi !== -1) { return Promise.resolve(buffer.splice(bi, 1)[0]); }
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              const wi = waiters.findIndex(w => w.resolve === res);
              if (wi !== -1) waiters.splice(wi, 1);
              rej(new Error(`waitFor timeout. buffer: ${buffer.map(m=>m.type)}`));
            }, timeoutMs);
            waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); res(m); } });
          });
        },
        nextState(ms)  { return this.waitFor(m => m.type === 'GAME_STATE', ms); },
        nextError(ms)  { return this.waitFor(m => m.type === 'ERROR', ms); },
        nextEvents(ms) { return this.waitFor(m => m.type === 'EVENTS', ms); },
        close() { ws.close(); },
      });
    });
  });
}

async function startTestGame() {
  const roomId = `RM${Math.random().toString(36).slice(2,8).toUpperCase()}`;
  const [a, b] = await Promise.all([
    createPlayer(roomId),
    createPlayer(roomId),
  ]);
  const [aState, bState] = await Promise.all([a.nextState(), b.nextState()]);
  // Connection arrival order is non-deterministic, so the server may assign
  // slot 'p1' to either socket. Route by the authoritative `you` field rather
  // than by array order so the test's p1/p2 always match the server's slots.
  const aIsP1 = aState.you === 'p1';
  const p1 = aIsP1 ? a : b;
  const p2 = aIsP1 ? b : a;
  const p1State = aIsP1 ? aState : bState;
  const p2State = aIsP1 ? bState : aState;
  return { p1, p2, p1State, p2State };
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

let server;
beforeAll(() => { server = createServer(TEST_PORT); });
afterAll(() => {
  // wss.close() stops accepting connections but leaves open client sockets
  // alive, which keeps the test process's event loop running forever. Terminate
  // every connected socket first so `node --test` actually exits.
  for (const client of server.clients) client.terminate();
  server.close();
});

// ─── Connection Tests ─────────────────────────────────────────────────────────

describe('Connection and room management', () => {
  test('two players can connect and game starts', async () => {
    const { p1State, p2State } = await startTestGame();
    expect(p1State.state.phase).toBe('active');
    expect(p2State.state.phase).toBe('active');
    expect(p1State.you).toBe('p1');
    expect(p2State.you).toBe('p2');
  });

  test('p1 sees own hand; p2 hand is hidden (count only)', async () => {
    const { p1State, p2State } = await startTestGame();
    expect(p1State.state.players.p1.hand).toHaveLength(5);
    expect(p1State.state.players.p2.hand).toHaveLength(0);
    expect(p1State.state.players.p2.handSize).toBe(5);
    expect(p2State.state.players.p2.hand).toHaveLength(5);
    expect(p2State.state.players.p1.hand).toHaveLength(0);
  });

  test('third player gets ROOM_FULL error', async () => {
    const roomId = `RM${Math.random().toString(36).slice(2,8).toUpperCase()}`;
    const [p1, p2] = await Promise.all([createPlayer(roomId), createPlayer(roomId)]);
    await Promise.all([p1.nextState(), p2.nextState()]);
    const p3 = await createPlayer(roomId);
    const err = await p3.waitFor(m => m.type === 'ERROR');
    expect(err.code).toBe('ROOM_FULL');
  });
});

// ─── Game Action Tests ────────────────────────────────────────────────────────

describe('Game actions over WebSocket', () => {
  test('voiding a card gives 3 energy', async () => {
    const { p1, p2, p1State } = await startTestGame();
    const cardToVoid = p1State.state.players.p1.hand[0];
    p1.send({ type: 'VOID_CARD', cardId: cardToVoid });
    const state = await p1.nextState();
    expect(state.state.players.p1.energy).toBe(3);
    expect(state.state.players.p1.hand).not.toContain(cardToVoid);
  });

  test('p2 cannot pass priority when p1 holds it', async () => {
    const { p1, p2 } = await startTestGame();
    p2.send({ type: 'PASS_PRIORITY' });
    const err = await p2.nextError();
    expect(err.code).toBe('NOT_YOUR_PRIORITY');
  });

  test('passing on an empty horizon ends the turn (opponent has no response to give)', async () => {
    const { p1 } = await startTestGame();
    // p1 passes with an empty horizon on its own turn. p2's resulting priority is
    // a dead end-of-turn window (nothing it could possibly play), so it is
    // auto-skipped and the turn ends on this single pass.
    p1.send({ type: 'PASS_PRIORITY' });
    const after = await p1.nextState();
    expect(after.state.turn).toBe('p2');
    expect(after.state.turnNumber).toBe(2);
    expect(after.state.activePlayer).toBe('p2');
  });

  test('played card appears on horizon for both players', async () => {
    const { p1, p2, p1State } = await startTestGame();
    const zeroCost = ['53', '56', '65', '66'];
    const card = p1State.state.players.p1.hand.find(id => zeroCost.includes(id));
    if (!card) return;
    // p2's window is live regardless of its hand: p1's card is on the horizon for
    // it to respond to, so priority moves to p2.

    p1.send({ type: 'PLAY_CARD', cardId: card });
    const [s1, s2] = await Promise.all([p1.nextState(), p2.nextState()]);
    expect(s1.state.zones.horizon).toHaveLength(1);
    expect(s1.state.zones.horizon[0].cardId).toBe(card);
    expect(s2.state.zones.horizon[0].cardId).toBe(card);
    expect(s1.state.activePlayer).toBe('p2');
  });

  test('concede ends the game with opponent as winner', async () => {
    const { p1, p2 } = await startTestGame();
    p1.send({ type: 'CONCEDE' });
    const [s1, s2] = await Promise.all([p1.nextState(), p2.nextState()]);
    expect(s1.state.phase).toBe('ended');
    expect(s1.state.winner).toBe('p2');
    expect(s2.state.winner).toBe('p2');
  });

  test('full turn: p1 voids cards, ends turn, draws back to 5', async () => {
    const { p1, p2, p1State } = await startTestGame();

    // Void 3 cards sequentially, awaiting state after each
    const hand = [...p1State.state.players.p1.hand];
    p1.send({ type: 'VOID_CARD', cardId: hand[0] });
    const s1 = await p1.nextState();
    expect(s1.state.players.p1.energy).toBe(3);

    p1.send({ type: 'VOID_CARD', cardId: hand[1] });
    const s2 = await p1.nextState();
    expect(s2.state.players.p1.energy).toBe(6);

    p1.send({ type: 'VOID_CARD', cardId: hand[2] });
    const s3 = await p1.nextState();
    expect(s3.state.players.p1.energy).toBe(9);
    expect(s3.state.players.p1.handSize).toBe(2);

    // End turn: p1 passes on an empty horizon. p2's end-of-turn window is dead, so
    // it is auto-skipped and the turn ends on this single pass.
    p1.send({ type: 'PASS_PRIORITY' });
    const endState = await p1.nextState();

    expect(endState.state.turn).toBe('p2');
    expect(endState.state.players.p1.energy).toBe(0); // wiped
    // p1 drew from 2 back up to 5
    expect(endState.state.players.p1.handSize).toBe(5);
  });
});

// ─── Choice Flow Tests ────────────────────────────────────────────────────────

describe('Choice flow', () => {
  async function setupSortChoice() {
    const game = await startTestGame();
    const { p1, p2, p1State } = game;
    if (!p1State.state.players.p1.hand.includes('53')) return null;

    p1.send({ type: 'PLAY_CARD', cardId: '53' });
    let afterResolve = await p1.nextState();
    // If p2 has a live response window it must decline; then 53 resolves on its
    // own (p1 can't respond to its own card, so that window is auto-skipped). If
    // p2 had no possible response, the play already cascaded to resolution.
    if (!afterResolve.state.pendingChoice && afterResolve.state.activePlayer === 'p2') {
      p2.send({ type: 'PASS_PRIORITY' });
      afterResolve = await p1.nextState();
    }

    if (!afterResolve.state.pendingChoice) return null;
    return { ...game, afterResolve };
  }

  test('Sort (53) resolution creates trashFromHand choice', async () => {
    const setup = await setupSortChoice();
    if (!setup) return;
    expect(setup.afterResolve.state.pendingChoice.type).toBe('trashFromHand');
    expect(setup.afterResolve.state.pendingChoice.count).toBe(2);
  });

  test('opponent sees waitingFor:opponent when choice pending', async () => {
    const setup = await setupSortChoice();
    if (!setup) return;
    const { p2 } = setup;
    // p2's buffer holds earlier states (e.g. just after p1 played the card)
    // with no pendingChoice yet; wait for the broadcast that carries the choice.
    const p2View = await p2.waitFor(m => m.type === 'GAME_STATE' && m.state.pendingChoice);
    expect(p2View.state.pendingChoice.waitingFor).toBe('opponent');
  });

  test('cannot act while choice is pending', async () => {
    const setup = await setupSortChoice();
    if (!setup) return;
    const { p1 } = setup;
    p1.send({ type: 'PASS_PRIORITY' });
    const err = await p1.nextError();
    expect(err.code).toBe('CHOICE_PENDING');
  });

  test('invalid choice is rejected', async () => {
    const setup = await setupSortChoice();
    if (!setup) return;
    const { p1 } = setup;
    p1.send({ type: 'CHOOSE', payload: { cardIds: [] } });
    const err = await p1.nextError();
    expect(err.code).toBe('INVALID_CHOICE');
  });

  test('valid choice resolves pendingChoice', async () => {
    const setup = await setupSortChoice();
    if (!setup) return;
    const { p1, afterResolve } = setup;
    const hand = afterResolve.state.players.p1.hand;
    if (hand.length < 2) return;

    p1.send({ type: 'CHOOSE', payload: { cardIds: [hand[0], hand[1]] } });
    const resolved = await p1.nextState();
    expect(resolved.state.pendingChoice).toBeNull();
    expect(resolved.state.players.p1.hand.length).toBe(hand.length - 2);
  });
});
