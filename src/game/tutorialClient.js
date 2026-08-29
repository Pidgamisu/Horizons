/**
 * TutorialClient, a scripted, on-rails client that teaches the horizon + priority
 * exchange without an engine or a second player. It mirrors the public surface
 * of GameClient (same methods + emitted events) so App.jsx and the board/HUD/
 * ActionBar render it exactly like a real game.
 *
 * The lesson: you play a point card, the opponent answers with Delusion to send
 * it to the dusk, and you counter with Deny Hostility so your point rises into
 * your zenith. Each "beat" is a hand-authored projection (the same shape the
 * server broadcasts) plus coaching metadata. The player can only take the taught
 * action at each step; anything else gets a gentle nudge and the beat doesn't
 * advance.
 */

const POINT = '042' // Splendor      , point, cost 5: each player gains 4 energy
const STOP  = '053' // Delusion      , action, cost 2: put a point on the horizon into the dusk
const DENY  = '079' // Deny Hostility, action, cost 1: dusk an action played in response to a point
const FILL1 = '055' // Dig For Ideas , voided for energy
const FILL2 = '063' // Sort          , voided for energy
// A fresh draw shown when the hand refills at end of turn (any real card ids).
const REFILL = ['004', '020', '060', '083', '097']

// Build a full per-player projection with sensible tutorial defaults; callers
// override just the fields that change between beats. The horizon is ordered
// newest-first (index 0 = top), matching the engine (play = unshift, rise =
// shift) and how BoardManager renders it.
function proj({
  horizon = [], p1hand = [], p2handSize = 0, active = 'p1',
  p1zenith = [], p1energy = 0, p2energy = 3, dusk = [], turnNumber = 1,
}) {
  const entry = (e) => ({ cardId: e.cardId, playedBy: e.playedBy, controlledBy: e.playedBy })
  return {
    phase: 'active', turn: 'p1', activePlayer: active,
    priorityPassCount: 0, turnNumber, winner: null,
    players: {
      p1: {
        hand: p1hand, handSize: p1hand.length,
        zenith: p1zenith, points: p1zenith.length, energy: p1energy,
        lockedFromPlaying: false, canPlayFromDusk: false,
      },
      p2: {
        hand: [], handSize: p2handSize,
        zenith: [], points: 0, energy: p2energy,
        lockedFromPlaying: false,
      },
    },
    zones: { deckSize: 40, horizon: horizon.map(entry), dusk, reshufflesRemaining: 0 },
    pendingChoice: null,
    cardsPlayedThisTurn: horizon.length,
  }
}

const ON_HORIZON_POINT = { cardId: POINT, playedBy: 'p1' }
const ON_HORIZON_STOP  = { cardId: STOP,  playedBy: 'p2' }
const ON_HORIZON_DENY  = { cardId: DENY,  playedBy: 'p1' }

const DUSK_START = [FILL1, FILL2]
const DUSK_END = [FILL1, FILL2, DENY, STOP]

// The scripted beats, in order. mode drives how a beat advances:
//   'continue', wait for the player to click Continue
//   'action'  , wait for a specific player action (expect)
//   'auto'    , advance automatically after autoMs (opponent move / resolution)
//   'done'    , final beat; the overlay shows Finish (exits the tutorial)
const BEATS = [
  {
    mode: 'continue',
    state: proj({ p1hand: [POINT, DENY, FILL1, FILL2], p2handSize: 1, p1energy: 0 }),
    narration: 'Welcome to **Horizons**. The deck is shared and finite: when it runs out the game ends, and whoever has the most **points** in their **zenith** wins.',
  },
  {
    mode: 'continue',
    state: proj({ p1hand: [POINT, DENY, FILL1, FILL2], p2handSize: 1, p1energy: 0 }),
    narration: 'Four zones matter. The **horizon** in the middle is where played cards wait. The **dusk** on the left is one shared face-up pile. Each player has a **zenith** on their right, where their **points** pile up.',
  },
  {
    mode: 'continue',
    state: proj({ p1hand: [POINT, DENY, FILL1, FILL2], p2handSize: 1, p1energy: 0 }),
    narration: 'There are two kinds of card. A **point** is what you’re trying to score. An **action** does something and then leaves. Cards cost **energy**, and you make energy by **voiding** cards you don’t need.',
  },
  {
    mode: 'action', expect: { action: 'void', cardId: FILL1 }, highlight: FILL1,
    state: proj({ p1hand: [POINT, DENY, FILL1, FILL2], p2handSize: 1, p1energy: 0 }),
    narration: 'Voiding puts a card into the **dusk** and gives you **3 energy**. Let’s pay for **Splendor**, which costs **5**. Click **Dig For Ideas**, then hit **Void (+3)**.',
  },
  {
    mode: 'action', expect: { action: 'void', cardId: FILL2 }, highlight: FILL2,
    state: proj({ p1hand: [POINT, DENY, FILL2], p2handSize: 1, p1energy: 3, dusk: [FILL1] }),
    narration: 'Three energy, and the card is now in the **dusk**. Void **Sort** as well to reach five. Any energy you don’t spend disappears at the end of the turn, so there’s no reason to hoard it.',
  },
  {
    mode: 'action', expect: { action: 'play', cardId: POINT }, highlight: POINT,
    state: proj({ p1hand: [POINT, DENY], p2handSize: 1, p1energy: 6, dusk: DUSK_START }),
    narration: 'Six energy. A **point** can only be played on your own turn while the **horizon** is empty. Both are true right now. Click **Splendor**, then hit **Play**.',
  },
  {
    mode: 'continue',
    state: proj({ horizon: [ON_HORIZON_POINT], p1hand: [DENY], p2handSize: 1, active: 'p2', p1energy: 1, dusk: DUSK_START }),
    narration: 'Nothing happens yet. Your card sits on the **horizon** and waits. That pause is the whole game: while a card of yours is on top, your opponent may **respond** to it.',
  },
  {
    mode: 'continue',
    state: proj({ horizon: [ON_HORIZON_STOP, ON_HORIZON_POINT], p1hand: [DENY], p2handSize: 0, active: 'p1', p1energy: 1, p2energy: 0, dusk: DUSK_START }),
    narration: 'And they do. **Delusion** is an **action** that sends a **point** on the **horizon** to the **dusk**, aimed at your Splendor. It went on top, and the **horizon** rises from the top down, so Delusion would go first.',
  },
  {
    mode: 'action', expect: { action: 'play', cardId: DENY }, highlight: DENY,
    state: proj({ horizon: [ON_HORIZON_STOP, ON_HORIZON_POINT], p1hand: [DENY], p2handSize: 0, active: 'p1', p1energy: 1, p2energy: 0, dusk: DUSK_START }),
    narration: 'You can answer, because their card is on top now. **Deny Hostility** sends an **action** that was played in response to a **point** to the **dusk**. Click it, then **Play**.',
  },
  {
    mode: 'continue',
    state: proj({ horizon: [ON_HORIZON_DENY, ON_HORIZON_STOP, ON_HORIZON_POINT], p1hand: [], p2handSize: 0, active: 'p2', p1energy: 0, p2energy: 0, dusk: DUSK_START }),
    narration: 'Three cards are stacked up. **Deny Hostility** is on top and it is yours, so there is nothing for you to answer. Only your opponent can **respond** to it. They have no cards left, so they **pass**, and once nobody responds the top card **rises**.',
  },
  {
    mode: 'continue',
    events: [{ type: 'CARD_TO_DUSK_FROM_HORIZON', cardId: STOP }],
    state: proj({ horizon: [], p1hand: [], p2handSize: 0, active: 'p1', p1zenith: [POINT], p1energy: 0, p2energy: 0, dusk: DUSK_END }),
    narration: 'Deny Hostility **rises** first and removes Delusion. A card taken off the **horizon** never rises, so its text never happens. Both land in the **dusk**, where every risen **action** ends up.',
  },
  {
    mode: 'continue',
    state: proj({ horizon: [], p1hand: [], p2handSize: 0, active: 'p1', p1zenith: [POINT], p1energy: 0, p2energy: 0, dusk: DUSK_END }),
    narration: 'With the **horizon** clear, your **point** finally **rises** into your **zenith**, not the **dusk**. That’s one **point**. Every **point** in your **zenith** is worth exactly one, whatever it cost.',
  },
  {
    mode: 'action', expect: { action: 'pass' },
    state: proj({ horizon: [], p1hand: [], p2handSize: 0, active: 'p1', p1zenith: [POINT], p1energy: 0, p2energy: 0, dusk: DUSK_END }),
    narration: 'Your hand is empty and that’s fine. Emptying it is the idea. The **horizon** is clear and it is still your turn, so this is where you **pass**, to end it. Hit **Pass** (or press Space).',
  },
  {
    mode: 'continue',
    state: proj({ horizon: [], p1hand: REFILL, p2handSize: 0, active: 'p1', p1zenith: [POINT], p1energy: 0, p2energy: 0, dusk: DUSK_END }),
    narration: 'You drew back up to **5 cards**, and there is no maximum hand size. Notice your opponent didn’t draw. You only refill at the end of your **own** turn, so anything you spend during theirs isn’t replaced until yours comes round.',
  },
  {
    mode: 'continue',
    state: proj({ horizon: [], p1hand: REFILL, p2handSize: 0, active: 'p1', p1zenith: [POINT], p1energy: 0, p2energy: 0, dusk: DUSK_END }),
    narration: 'Those draws are also the clock. Nothing reshuffles, so the deck only ever runs down, and when it runs out the **sun sets**: the **horizon** empties into the **dusk** and the game is over on the spot.',
  },
  {
    mode: 'done',
    state: proj({ horizon: [], p1hand: REFILL, p2handSize: 0, active: 'p1', p1zenith: [POINT], p1energy: 0, p2energy: 0, dusk: DUSK_END }),
    narration: 'That’s the whole game. **Void** for **energy**, play onto the **horizon**, **respond** to what your opponent does there, and let your **points** **rise** into your **zenith** before the deck runs dry. You’re ready.',
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
      return this._nudge('That’s not the card we need right now, follow the highlighted card.')
    }
    if (expect?.action === 'void') {
      return this._nudge('Use **Void** here to gain energy, not Play.')
    }
    this._nudge('Hold on, just follow the current step.')
  }

  voidCard(cardId) {
    const beat = this._beat()
    const expect = beat?.mode === 'action' ? beat.expect : null
    if (expect?.action === 'void') {
      if (expect.cardId === cardId) return this.next()
      return this._nudge('Void the highlighted card to gain energy.')
    }
    if (expect?.action === 'play') {
      return this._nudge('No need to void now, **Play** the highlighted card.')
    }
    this._nudge('No need to void right now, follow the current step.')
  }

  passPriority() {
    const beat = this._beat()
    const expect = beat?.mode === 'action' ? beat.expect : null
    if (expect?.action === 'pass') return this.next()
    if (expect?.action === 'play') return this._nudge('You need to play the highlighted card here, not pass.')
    if (expect?.action === 'void') return this._nudge('Void the highlighted card here, not pass.')
    this._nudge('Nothing to pass right now, watch what happens, or click Continue.')
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
