/**
 * TutorialClient — a scripted, on-rails client that teaches the stack + priority
 * exchange without an engine or a second player. It mirrors the public surface
 * of GameClient (same methods + emitted events) so App.jsx and the board/HUD/
 * ActionBar render it exactly like a real game.
 *
 * The lesson: you play a point card, the opponent answers with Stop to trash it,
 * and you counter their Stop with Deny Hostility so your point resolves and
 * scores. Each "beat" is a hand-authored projection (the same shape the server
 * broadcasts) plus coaching metadata. The player can only take the taught action
 * at each step; anything else gets a gentle nudge and the beat doesn't advance.
 */

const POINT = '09' // Ambition       — point card, cost 5
const STOP  = '44' // Stop           — action: trash a card on the stack, cost 3
const DENY  = '69' // Deny Hostility — action: trash an action played in response to a point, cost 1
const FILL1 = '45' // Dig for Ideas  — voided for energy
const FILL2 = '53' // Sort           — voided for energy

// Build a full per-player projection with sensible tutorial defaults; callers
// override just the fields that change between beats. The stack is ordered
// newest-first (index 0 = top), matching the engine (push = unshift, resolve =
// shift) and how BoardManager renders it.
function proj({
  stack = [], p1hand = [], p2handSize = 0, active = 'p1',
  p1points = 0, p1energy = 0, p2energy = 3, trash = [], voidSize = 0, turnNumber = 1,
}) {
  const entry = (e) => ({ cardId: e.cardId, playedBy: e.playedBy, controlledBy: e.playedBy })
  return {
    phase: 'active', turn: 'p1', activePlayer: active,
    priorityPassCount: 0, turnNumber, winner: null,
    players: {
      p1: {
        hand: p1hand, handSize: p1hand.length, points: p1points, energy: p1energy,
        timerSeconds: 1500, lockedFromPlaying: false, canPlayFromTrash: false,
      },
      p2: {
        hand: [], handSize: p2handSize, points: 0, energy: p2energy,
        timerSeconds: 1500, lockedFromPlaying: false,
      },
    },
    zones: { deckSize: 40, stack: stack.map(entry), trash, voidSize },
    pendingChoice: null,
    cardsPlayedThisTurn: stack.length,
  }
}

const ON_STACK_POINT = { cardId: POINT, playedBy: 'p1' }
const ON_STACK_STOP  = { cardId: STOP,  playedBy: 'p2' }
const ON_STACK_DENY  = { cardId: DENY,  playedBy: 'p1' }

// The scripted beats, in order. mode drives how a beat advances:
//   'continue' — wait for the player to click Continue
//   'action'   — wait for a specific player action (expect)
//   'auto'     — advance automatically after autoMs (opponent move / resolution)
//   'done'     — final beat; the overlay shows Finish (exits the tutorial)
const BEATS = [
  {
    mode: 'continue',
    state: proj({ p1hand: [POINT, DENY, FILL1, FILL2], p2handSize: 1, p1energy: 0 }),
    narration: 'Welcome to Horizons! First to **5 points** wins, and points come from playing **point cards**. But playing cards costs **energy**, and you start with none. You gain energy by **voiding** cards from your hand: +3 each.',
  },
  {
    mode: 'action', expect: { action: 'void', cardId: FILL1 }, highlight: FILL1,
    state: proj({ p1hand: [POINT, DENY, FILL1, FILL2], p2handSize: 1, p1energy: 0 }),
    narration: 'Let’s build up energy. Click **Dig for Ideas**, then hit **Void (+3)** to send it away for energy.',
  },
  {
    mode: 'action', expect: { action: 'void', cardId: FILL2 }, highlight: FILL2,
    state: proj({ p1hand: [POINT, DENY, FILL2], p2handSize: 1, p1energy: 3, voidSize: 1 }),
    narration: '+3 energy! Your point card costs **5**, so void one more. Void **Sort**.',
  },
  {
    mode: 'continue',
    state: proj({ p1hand: [POINT, DENY], p2handSize: 1, p1energy: 6, voidSize: 2 }),
    narration: 'Now you have **6 energy** — enough for your point card. Voided cards are gone for the rest of the game, so void carefully.',
  },
  {
    mode: 'action', expect: { action: 'play', cardId: POINT }, highlight: POINT,
    state: proj({ p1hand: [POINT, DENY], p2handSize: 1, p1energy: 6, voidSize: 2 }),
    narration: 'Play your point card. Click **Ambition**, then hit **Play**.',
  },
  {
    mode: 'auto', autoMs: 1200,
    state: proj({ stack: [ON_STACK_POINT], p1hand: [DENY], p2handSize: 1, active: 'p2', p1energy: 1, voidSize: 2 }),
    narration: 'Your point card goes onto the **stack**. It doesn’t score yet — first your opponent gets a chance to respond…',
  },
  {
    mode: 'continue',
    state: proj({ stack: [ON_STACK_STOP, ON_STACK_POINT], p1hand: [DENY], p2handSize: 0, active: 'p1', p1energy: 1, p2energy: 0, voidSize: 2 }),
    narration: 'They played **Stop** to trash your point card! The stack resolves **top-first**, so Stop would resolve before your point. You’ll need to answer it.',
  },
  {
    mode: 'action', expect: { action: 'play', cardId: DENY }, highlight: DENY,
    state: proj({ stack: [ON_STACK_STOP, ON_STACK_POINT], p1hand: [DENY], p2handSize: 0, active: 'p1', p1energy: 1, p2energy: 0, voidSize: 2 }),
    narration: 'Counter their Stop with **Deny Hostility** — it trashes an action played in response to a point card. Click it, then **Play**.',
  },
  {
    mode: 'auto', autoMs: 1100,
    state: proj({ stack: [ON_STACK_DENY, ON_STACK_STOP, ON_STACK_POINT], p1hand: [], p2handSize: 0, active: 'p2', p1energy: 0, p2energy: 0, voidSize: 2 }),
    narration: 'Deny Hostility lands on **top** of the stack. Your opponent has no answer and passes priority…',
  },
  {
    mode: 'action', expect: { action: 'pass' },
    state: proj({ stack: [ON_STACK_DENY, ON_STACK_STOP, ON_STACK_POINT], p1hand: [], p2handSize: 0, active: 'p1', p1energy: 0, p2energy: 0, voidSize: 2 }),
    narration: 'Now **you** pass too. When both players pass, the top card resolves. Hit **Pass** (or press Space).',
  },
  {
    mode: 'auto', autoMs: 1500,
    events: [{ type: 'CARD_TRASHED_FROM_STACK', cardId: STOP }],
    state: proj({ stack: [ON_STACK_POINT], p1hand: [], p2handSize: 0, active: 'p1', p1energy: 0, p2energy: 0, trash: [STOP, DENY], voidSize: 2 }),
    narration: 'Deny Hostility resolves and trashes their **Stop**. Your point card survives — and it’s next to resolve.',
  },
  {
    mode: 'continue',
    state: proj({ stack: [], p1hand: [], p2handSize: 0, active: 'p1', p1points: 1, p1energy: 0, p2energy: 0, trash: [STOP, DENY, POINT], voidSize: 2 }),
    narration: 'With the stack clear, your point card resolves — **you score a point!** 🎉',
  },
  {
    mode: 'done',
    state: proj({ stack: [], p1hand: [], p2handSize: 0, active: 'p1', p1points: 1, p1energy: 0, p2energy: 0, trash: [STOP, DENY, POINT], voidSize: 2 }),
    narration: 'That’s the heart of Horizons: **void** cards for energy to fuel your plays, and remember the **stack is last-in, first-out** — whoever answers the *final* threat wins the exchange. Reach **5 points** to win. You’re ready!',
  },
]

export class TutorialClient extends EventTarget {
  constructor() {
    super()
    this.playerId = 'p1'
    this.roomId = 'TUTORIAL'
    this.gameState = null
    this.i = -1
    this.started = false
    this._timer = null
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  start() {
    if (this.started) return
    this.started = true
    this.emit('joined', { playerId: 'p1', roomId: this.roomId })
    this._enter(0)
  }

  // Kept for API parity with GameClient (App calls connect() on networked play).
  connect() { this.start() }

  disconnect() {
    clearTimeout(this._timer)
    this._timer = null
    this.started = false
  }

  // ── Player actions (same signatures as GameClient) ───────────────────────────

  playCard(cardId) {
    const beat = this._beat()
    const expect = beat?.mode === 'action' ? beat.expect : null
    if (expect?.action === 'play') {
      if (expect.cardId === cardId) return this.next()
      return this._nudge('That’s not the card we need right now — follow the highlighted card.')
    }
    if (expect?.action === 'void') {
      return this._nudge('Use **Void** here to gain energy — not Play.')
    }
    this._nudge('Hold on — just follow the current step.')
  }

  voidCard(cardId) {
    const beat = this._beat()
    const expect = beat?.mode === 'action' ? beat.expect : null
    if (expect?.action === 'void') {
      if (expect.cardId === cardId) return this.next()
      return this._nudge('Void the highlighted card to gain energy.')
    }
    if (expect?.action === 'play') {
      return this._nudge('No need to void now — **Play** the highlighted card.')
    }
    this._nudge('No need to void right now — follow the current step.')
  }

  passPriority() {
    const beat = this._beat()
    const expect = beat?.mode === 'action' ? beat.expect : null
    if (expect?.action === 'pass') return this.next()
    if (expect?.action === 'play') return this._nudge('You need to play the highlighted card here, not pass.')
    if (expect?.action === 'void') return this._nudge('Void the highlighted card here, not pass.')
    this._nudge('Nothing to pass right now — watch what happens, or click Continue.')
  }
  choose() { /* no choice prompts in this scripted scenario */ }
  concede() { /* exiting is handled by the tutorial’s own Exit control */ }

  // ── Beat flow ────────────────────────────────────────────────────────────────

  next() {
    if (this.i < BEATS.length - 1) this._enter(this.i + 1)
  }

  _enter(index) {
    clearTimeout(this._timer)
    this.i = index
    const beat = BEATS[index]

    if (beat.events?.length) this.emit('events', { events: beat.events })

    this.gameState = beat.state
    this.emit('stateUpdate', { state: beat.state, you: 'p1' })

    this.emit('beat', {
      index,
      total: BEATS.length,
      narration: beat.narration,
      mode: beat.mode,
      highlight: beat.highlight ?? null,
    })

    if (beat.mode === 'auto') {
      this._timer = setTimeout(() => this.next(), beat.autoMs ?? 1200)
    }
  }

  _beat() { return BEATS[this.i] }

  _nudge(message) { this.emit('coachNudge', { message }) }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  // ── Getters mirroring GameClient (used by the UI) ─────────────────────────────

  get myState() { return this.gameState?.players?.p1 }
  get opponentState() { return this.gameState?.players?.p2 }
  get isMyTurn() { return this.gameState?.turn === 'p1' }
  get holdingPriority() { return this.gameState?.activePlayer === 'p1' }
  get pendingChoice() { return this.gameState?.pendingChoice ?? null }
  get myChoicePending() { return false }
}
