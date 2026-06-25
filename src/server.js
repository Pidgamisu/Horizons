import { WebSocketServer, WebSocket } from 'ws';
import { createGameState, initDeck, opponent } from './engine/state.js';
import { startGame, playCard, passPriority, voidCard } from './engine/game.js';
import { resolveChoice } from './engine/choices.js';

// ─── Room Management ──────────────────────────────────────────────────────────

const rooms = new Map(); // roomId -> Room

function createRoom(roomId) {
  return {
    id: roomId,
    players: {},       // { p1: ws, p2: ws }
    playerIds: {},     // { connectionId -> 'p1' | 'p2' }
    state: null,
    started: false,
  };
}

function getRoomId(url) {
  // URL format: ws://host/game/ROOMCODE
  const match = url?.match(/\/game\/([A-Z0-9]{4,8})/i);
  return match ? match[1].toUpperCase() : null;
}

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// ─── Message Helpers ──────────────────────────────────────────────────────────

function send(ws, msg) {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function sendError(ws, code, message) {
  send(ws, { type: 'ERROR', code, message });
}

/**
 * Broadcast different projections of game state to each player.
 * Each player only sees their own hand — opponent's hand is hidden.
 */
function broadcastState(room) {
  const state = room.state;
  for (const [slot, ws] of Object.entries(room.players)) {
    const opp = opponent(slot);
    send(ws, {
      type: 'GAME_STATE',
      state: {
        phase: state.phase,
        turn: state.turn,
        activePlayer: state.activePlayer,
        priorityPassCount: state.priorityPassCount,
        turnNumber: state.turnNumber,
        winner: state.winner,
        players: {
          [slot]: {
            hand: state.players[slot].hand,
            handSize: state.players[slot].hand.length,
            points: state.players[slot].points,
            energy: state.players[slot].energy,
            timerSeconds: state.players[slot].timerSeconds,
            lockedFromPlaying: state.players[slot].lockedFromPlaying,
          },
          [opp]: {
            hand: [],                                      // hidden
            handSize: state.players[opp].hand.length,     // count only
            points: state.players[opp].points,
            energy: state.players[opp].energy,
            timerSeconds: state.players[opp].timerSeconds,
            lockedFromPlaying: state.players[opp].lockedFromPlaying,
          },
        },
        zones: {
          deckSize: state.zones.deck.length,
          stack: state.zones.stack.map(e => ({
            cardId: e.cardId,
            playedBy: e.playedBy,
            controlledBy: e.controlledBy,
          })),
          trash: state.zones.trash,
          voidSize: state.zones.void.length,
        },
        pendingChoice: state.pendingChoice
          ? buildChoicePrompt(state.pendingChoice, slot)
          : null,
        cardsPlayedThisTurn: state.cardsPlayedThisTurn.length,
      },
      you: slot,
    });
  }
}

/**
 * Build a choice prompt for a specific player.
 * If the choice is for the other player, send { waitingFor: 'opponent' }.
 */
function buildChoicePrompt(choice, forPlayer) {
  if (choice.player !== forPlayer) {
    return { waitingFor: 'opponent', type: choice.type };
  }
  return choice; // full choice data for the player who must respond
}

/**
 * Broadcast events to both players (events are public — they describe what happened).
 * Some events contain private data (card draws) — filter those.
 */
function broadcastEvents(room, events) {
  for (const [slot, ws] of Object.entries(room.players)) {
    const filtered = events.map(e => sanitizeEventForPlayer(e, slot, room.state));
    send(ws, { type: 'EVENTS', events: filtered });
  }
}

function sanitizeEventForPlayer(event, forPlayer, state) {
  // Hide drawn card identities from the wrong player
  if (event.type === 'CARDS_DRAWN' && event.player && event.player !== forPlayer) {
    return { ...event, cards: event.cards?.map(() => '??') };
  }
  return event;
}

// ─── Pending Choice Management ────────────────────────────────────────────────

/**
 * Scan pendingTriggers for the next CHOICE_REQUIRED trigger,
 * pull it out, and set it as state.pendingChoice.
 * Returns true if a choice was set, false if no choices pending.
 */
function advancePendingChoices(state) {
  // Filter out non-choice triggers (like registerTurnTrigger)
  const choiceTypes = new Set([
    'trashFromHandChoice', 'trashFromStackChoice', 'returnStackCardToHandChoice',
    'stealFromStackChoice', 'gainControlChoice', 'putFromTrashToHandChoice',
    'optionalEffectChoice', 'additionalCost', 'putHandCardOnDeckTop',
    'revealUntilType', 'opponentChoosesOne', 'controllerMovesCardFromStack',
    'lookAtTopN', 'chooseNumber', 'chooseCardToTrashFromRevealedHand',
    'trashFromHandChoice',
  ]);

  const idx = state.pendingTriggers.findIndex(t => choiceTypes.has(t.type));
  if (idx === -1) return false;

  const trigger = state.pendingTriggers.splice(idx, 1)[0];

  // Map trigger type → choice type
  const typeMap = {
    trashFromHandChoice:           'trashFromHand',
    trashFromStackChoice:          'trashFromStack',
    returnStackCardToHandChoice:   'returnToControllerHand',
    stealFromStackChoice:          'stealFromStack',
    gainControlChoice:             'gainControl',
    putFromTrashToHandChoice:      'putFromTrashToHand',
    optionalEffectChoice:          'optional',
    additionalCost:                'additionalCost',
    lookAtTopN:                    'lookAtTopN',
    chooseNumber:                  'chooseNumber',
    opponentChoosesOne:            'opponentChoosesOne',
    controllerMovesCardFromStack:  'controllerMovesCardFromStack',
    revealUntilType:               'revealUntilType',
    chooseCardToTrashFromRevealedHand: 'chooseCardToTrashFromRevealedHand',
    putHandCardOnDeckTop:          'putHandCardOnDeckTop',
  };

  state.pendingChoice = {
    ...trigger,
    type: typeMap[trigger.type] ?? trigger.type,
  };

  return true;
}

// ─── Message Handler ──────────────────────────────────────────────────────────

function handleMessage(ws, room, playerId, msg) {
  const state = room.state;
  let events = [];

  switch (msg.type) {

    case 'PLAY_CARD': {
      if (state.pendingChoice) {
        sendError(ws, 'CHOICE_PENDING', 'You must respond to the pending choice first.');
        return;
      }
      events = playCard(state, playerId, msg.cardId, msg.context ?? {});
      break;
    }

    case 'VOID_CARD': {
      if (state.pendingChoice) {
        sendError(ws, 'CHOICE_PENDING', 'You must respond to the pending choice first.');
        return;
      }
      events = voidCard(state, playerId, msg.cardId);
      break;
    }

    case 'PASS_PRIORITY': {
      if (state.pendingChoice) {
        sendError(ws, 'CHOICE_PENDING', 'You must respond to the pending choice first.');
        return;
      }
      events = passPriority(state, playerId);
      break;
    }

    case 'CHOOSE': {
      // Player responding to a CHOICE_REQUIRED prompt
      if (!state.pendingChoice) {
        sendError(ws, 'NO_CHOICE_PENDING', 'No choice is currently pending.');
        return;
      }
      if (state.pendingChoice.player !== playerId) {
        sendError(ws, 'NOT_YOUR_CHOICE', 'This choice is not yours to make.');
        return;
      }
      const { events: choiceEvents, error } = resolveChoice(state, playerId, msg.payload);
      if (error) {
        sendError(ws, 'INVALID_CHOICE', error);
        return;
      }
      events = choiceEvents;

      // After a choice resolves, check if more choices are pending
      if (!state.pendingChoice) {
        advancePendingChoices(state);
      }
      break;
    }

    case 'CONCEDE': {
      const opp = opponent(playerId);
      state.winner = opp;
      state.phase = 'ended';
      events = [{ type: 'GAME_OVER', winner: opp, reason: 'concede' }];
      break;
    }

    default:
      sendError(ws, 'UNKNOWN_MESSAGE', `Unknown message type: ${msg.type}`);
      return;
  }

  // If the first event is an ERROR, send only to the acting player and stop
  if (events.length > 0 && events[0].type === 'ERROR') {
    send(ws, events[0]);
    return;
  }

  // After any action, surface the next queued choice if one isn't already
  // pending. This covers every choice-producing trigger (CHOICE_REQUIRED,
  // ADDITIONAL_COST_REQUIRED, …); advancePendingChoices is a no-op when the
  // queue has no choice triggers.
  if (!state.pendingChoice) {
    advancePendingChoices(state);
  }

  // Broadcast events, then full state
  if (events.length > 0) broadcastEvents(room, events);
  broadcastState(room);
}

// ─── Server Setup ─────────────────────────────────────────────────────────────

export function createServer(port = 8080) {
  const wss = new WebSocketServer({ port });
  console.log(`Horizons game server listening on ws://localhost:${port}`);

  wss.on('connection', (ws, req) => {
    const url = req.url;
    let roomId = getRoomId(url);
    let room;
    let playerId;

    // Create or join a room
    if (!roomId || !rooms.has(roomId)) {
      roomId = roomId || generateRoomCode();
      room = createRoom(roomId);
      rooms.set(roomId, room);
    } else {
      room = rooms.get(roomId);
    }

    // Assign player slot
    if (!room.players.p1) {
      playerId = 'p1';
      room.players.p1 = ws;
    } else if (!room.players.p2) {
      playerId = 'p2';
      room.players.p2 = ws;
    } else {
      send(ws, { type: 'ERROR', code: 'ROOM_FULL', message: 'Room is full.' });
      ws.close();
      return;
    }

    room.playerIds[ws._socket?.remoteAddress ?? Math.random()] = playerId;

    send(ws, {
      type: 'JOINED',
      roomId,
      you: playerId,
      shareUrl: `ws://localhost:${port}/game/${roomId}`,
    });

    console.log(`${playerId} joined room ${roomId}`);

    // Start game when both players are connected
    if (room.players.p1 && room.players.p2 && !room.started) {
      room.started = true;
      room.state = createGameState();
      initDeck(room.state);
      room.state.pendingChoice = null;

      const events = startGame(room.state);
      broadcastEvents(room, events);
      broadcastState(room);
      console.log(`Game started in room ${roomId}`);
    }

    // Message handler
    ws.on('message', (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        sendError(ws, 'INVALID_JSON', 'Message must be valid JSON.');
        return;
      }
      handleMessage(ws, room, playerId, msg);
    });

    // Disconnect handler
    ws.on('close', () => {
      console.log(`${playerId} disconnected from room ${roomId}`);
      // Notify opponent
      const oppSlot = opponent(playerId);
      if (room.players[oppSlot]) {
        send(room.players[oppSlot], { type: 'OPPONENT_DISCONNECTED' });
      }
      delete room.players[playerId];
      // Clean up empty rooms after a delay
      setTimeout(() => {
        if (!room.players.p1 && !room.players.p2) {
          rooms.delete(roomId);
          console.log(`Room ${roomId} closed.`);
        }
      }, 30_000);
    });
  });

  return wss;
}
