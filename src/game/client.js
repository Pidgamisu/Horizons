/**
 * GameClient — WebSocket connection to the Horizons game server.
 * Emits events that the React layer subscribes to.
 */

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'ws://localhost:8080'

const MAX_RECONNECT_ATTEMPTS = 5
const RECONNECT_BASE_MS = 1000

export class GameClient extends EventTarget {
  constructor() {
    super()
    this.ws = null
    this.roomId = null
    this.playerId = null   // 'p1' | 'p2'
    this.gameState = null  // latest PlayerProjection from server
    this.connected = false
    this.reconnectTimer = null
    this.reconnectAttempts = 0
    this.intentionalClose = false  // set when WE close on purpose
    this.stopped = false           // set when reconnecting is pointless (e.g. ROOM_FULL)
  }

  // ── Connection ──────────────────────────────────────────────────────────────

  connect(roomId) {
    this.roomId = roomId.toUpperCase()

    // Guard: don't open a second socket if one is already live or connecting.
    // (This is what produces the ROOM_FULL reconnect storm in dev.)
    if (this.ws &&
        (this.ws.readyState === WebSocket.OPEN ||
         this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }

    this.intentionalClose = false
    this.stopped = false

    const url = `${SERVER_URL}/game/${this.roomId}`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => {
      this.connected = true
      this.reconnectAttempts = 0   // success → reset the backoff counter
      this.emit('connected', { roomId: this.roomId })
    }

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      this._handleMessage(msg)
    }

    this.ws.onclose = () => {
      this.connected = false
      this.emit('disconnected', {})
      this._scheduleReconnect()
    }

    this.ws.onerror = () => {
      this.emit('gameError', { code: 'CONNECTION', message: 'Connection error' })
    }
  }

  _scheduleReconnect() {
    // Don't reconnect if we closed on purpose, were told to stop, or are out of attempts.
    if (this.intentionalClose || this.stopped) return
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.warn('[GameClient] gave up reconnecting after', this.reconnectAttempts, 'attempts')
      this.emit('gameError', {
        code: 'RECONNECT_FAILED',
        message: 'Lost connection to server. Reload the page to rejoin.',
      })
      return
    }

    this.reconnectAttempts++
    const delay = RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1)  // 1s, 2s, 4s, 8s, 16s
    console.warn(`[GameClient] reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`)

    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      if (this.roomId && !this.intentionalClose && !this.stopped) {
        this.connect(this.roomId)
      }
    }, delay)
  }

  disconnect() {
    this.intentionalClose = true
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.ws?.close()
    this.ws = null
  }

  // ── Outgoing Messages ───────────────────────────────────────────────────────

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    // Don't silently swallow it — say so, so a dead socket can't masquerade as a working game.
    console.warn('[GameClient] dropped message, socket not open:', msg.type, '(readyState:', this.ws?.readyState, ')')
    this.emit('gameError', { code: 'NOT_CONNECTED', message: 'Not connected to server' })
    return false
  }

  playCard(cardId, context = {}) {
    this.send({ type: 'PLAY_CARD', cardId, context })
  }

  voidCard(cardId) {
    this.send({ type: 'VOID_CARD', cardId })
  }

  passPriority() {
    this.send({ type: 'PASS_PRIORITY' })
  }

  choose(payload) {
    this.send({ type: 'CHOOSE', payload })
  }

  concede() {
    this.send({ type: 'CONCEDE' })
  }

  // ── Incoming Messages ───────────────────────────────────────────────────────

  _handleMessage(msg) {
    switch (msg.type) {
      case 'JOINED':
        this.playerId = msg.you
        this.roomId = msg.roomId
        this.emit('joined', { playerId: msg.you, roomId: msg.roomId })
        break

      case 'GAME_STATE':
        this.gameState = msg.state
        this.playerId = msg.you
        this.emit('stateUpdate', { state: msg.state, you: msg.you })
        break

      case 'EVENTS':
        this.emit('events', { events: msg.events })
        break

      case 'ERROR':
        // ROOM_FULL means reconnecting is pointless — stop the storm permanently.
        if (msg.code === 'ROOM_FULL') {
          this.stopped = true
          clearTimeout(this.reconnectTimer)
          console.warn('[GameClient] ROOM_FULL — halting reconnect attempts')
        }
        this.emit('gameError', { code: msg.code, message: msg.message })
        break

      case 'OPPONENT_DISCONNECTED':
        this.emit('opponentDisconnected', {})
        break
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }

  get myState() {
    return this.gameState?.players?.[this.playerId]
  }

  get opponentState() {
    const opp = this.playerId === 'p1' ? 'p2' : 'p1'
    return this.gameState?.players?.[opp]
  }

  get isMyTurn() {
    return this.gameState?.turn === this.playerId
  }

  get holdingPriority() {
    return this.gameState?.activePlayer === this.playerId
  }

  get pendingChoice() {
    return this.gameState?.pendingChoice ?? null
  }

  get myChoicePending() {
    return this.pendingChoice?.player === this.playerId
  }
}

export const gameClient = new GameClient()
window.gameClient = gameClient

// On hot-reload, close the old socket so Vite doesn't leave a zombie connection
// holding a room slot (the original cause of the ROOM_FULL reconnect loop).
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    gameClient.disconnect()
  })
}