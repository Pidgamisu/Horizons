import { createShapeId } from 'tldraw'

const CW = 120  // card width
const CH = 168  // card height
const GAP = 10

const ZONES = {
  opponentHand: { cx: 0, cy: -340, w: 900, h: CH + 20,  label: 'Hand',  zoneType: 'opponent-hand' },
  myHand:       { cx: 0, cy:  340, w: 900, h: CH + 20,  label: 'Hand',  zoneType: 'hand' },
  stack:        { cx: -220, cy: 0, w: CW + 40, h: 520,  label: 'Stack', zoneType: 'stack' },
  trash:        { cx:  20,  cy: 0, w: CW + 40, h: CH + 40, label: 'Trash', zoneType: 'trash' },
  deck:         { cx:  180, cy: -100, w: CW + 40, h: CH + 40, label: 'Deck', zoneType: 'deck' },
  void:         { cx:  180, cy:  100, w: CW + 40, h: CH + 40, label: 'Void', zoneType: 'void' },
}

const sid = (key) => createShapeId(key)

export class BoardManager {
  constructor(editor) {
    this.editor = editor
    this.selectedCardId = null
  }

  syncState(state, myPlayerId) {
    if (!state || state.phase === 'waiting') return
    const opp = myPlayerId === 'p1' ? 'p2' : 'p1'
    // Server-driven sync: run as a single transaction that is kept out of the
    // user's undo history, and bypass shape-lock since our shapes are locked.
    this.editor.run(() => {
      this._syncZones(state)
      this._syncStack(state.zones?.stack ?? [])
      this._syncHand(state.players?.[myPlayerId]?.hand ?? [])
      this._syncOpponentHand(state.players?.[opp]?.handSize ?? 0)
      this._syncTrash(state.zones?.trash ?? [])
      this._updateZoneCount('deck', state.zones?.deckSize ?? 0)
      this._updateZoneCount('void', state.zones?.voidSize ?? 0)
      this._syncTargeting(state.pendingChoice, myPlayerId)
    }, { history: 'ignore', ignoreShapeLock: true })
  }

  // ── Zones ────────────────────────────────────────────────────────────────────

  _syncZones(state) {
    const toCreate = []
    for (const [name, z] of Object.entries(ZONES)) {
      const id = sid(`zone-${name}`)
      if (!this.editor.getShape(id)) {
        toCreate.push({
          id, type: 'horizons-zone', isLocked: true,
          x: z.cx - z.w / 2, y: z.cy - z.h / 2,
          props: { label: z.label, zoneType: z.zoneType, count: null, highlight: false, w: z.w, h: z.h },
        })
      }
    }
    if (toCreate.length) this.editor.createShapes(toCreate)
  }

  _updateZoneCount(name, count) {
    const id = sid(`zone-${name}`)
    if (this.editor.getShape(id)) {
      this.editor.updateShapes([{ id, type: 'horizons-zone', props: { count } }])
    }
  }

  // ── Stack ─────────────────────────────────────────────────────────────────────

  _syncStack(entries) {
    this._clearPrefix('card-stack-')
    if (!entries.length) return

    const z = ZONES.stack
    this.editor.createShapes(entries.map((entry, i) => ({
      id: sid(`card-stack-${i}`),
      type: 'horizons-card',
      isLocked: true,
      x: z.cx - CW / 2,
      y: (z.cy - z.h / 2 + 20) + i * (CH + GAP),
      props: {
        cardId: entry.cardId, faceUp: true, zone: 'stack',
        owner: entry.playedBy, selected: false, targeted: false,
        dimmed: false, w: CW, h: CH,
        stackIndex: i,        // used for choice targeting
        stackIsTop: i === 0,  // visual badge
      },
    })))
  }

  // ── My hand ───────────────────────────────────────────────────────────────────

  _syncHand(cards) {
    this._clearPrefix('card-myhand-')
    if (!cards.length) return
    const z = ZONES.myHand
    const totalW = cards.length * CW + (cards.length - 1) * GAP
    const startX = z.cx - totalW / 2
    this.editor.createShapes(cards.map((code, i) => ({
      id: sid(`card-myhand-${i}`),
      type: 'horizons-card',
      isLocked: true,
      x: startX + i * (CW + GAP), y: z.cy - CH / 2,
      props: {
        cardId: code, faceUp: true, zone: 'hand', owner: 'me',
        selected: this.selectedCardId === code,
        targeted: false, dimmed: false, w: CW, h: CH,
      },
    })))
  }

  // ── Opponent hand ─────────────────────────────────────────────────────────────

  _syncOpponentHand(count) {
    this._clearPrefix('card-opphand-')
    if (!count) return
    const z = ZONES.opponentHand
    const totalW = count * CW + (count - 1) * GAP
    const startX = z.cx - totalW / 2
    const shapes = []
    for (let i = 0; i < count; i++) {
      shapes.push({
        id: sid(`card-opphand-${i}`),
        type: 'horizons-card',
        isLocked: true,
        x: startX + i * (CW + GAP), y: z.cy - CH / 2,
        props: {
          cardId: null, faceUp: false, zone: 'opponent-hand',
          owner: 'opp', selected: false, targeted: false, dimmed: false, w: CW, h: CH,
        },
      })
    }
    this.editor.createShapes(shapes)
  }

  // ── Trash ─────────────────────────────────────────────────────────────────────

  _syncTrash(codes) {
    this._clearPrefix('card-trash-')
    if (!codes.length) return
    const z = ZONES.trash
    const show = codes.slice(-3)
    this.editor.createShapes(show.map((code, i) => {
      const offset = (i - (show.length - 1) / 2) * 5
      return {
        id: sid(`card-trash-${i}`),
        type: 'horizons-card',
        isLocked: true,
        x: z.cx - CW / 2 + offset, y: z.cy - CH / 2 + offset,
        props: {
          cardId: code, faceUp: true, zone: 'trash',
          owner: null, selected: false, targeted: false, dimmed: false, w: CW, h: CH,
        },
      }
    }))
  }

  // ── Targeting ─────────────────────────────────────────────────────────────────

  _syncTargeting(choice, myPlayerId) {
    if (!choice || choice.player !== myPlayerId) {
      this._setAllTargeted(false)
      return
    }
    const stackChoiceTypes = ['trashFromStack','trashFromStackChoice','returnToControllerHand',
                              'returnStackCardToHandChoice','stealFromStack','stealFromStackChoice',
                              'gainControl','gainControlChoice','trashUnlessControllerPays']
    if (stackChoiceTypes.includes(choice.type)) {
      const updates = this.editor.getCurrentPageShapes()
        .filter(s => s.type === 'horizons-card')
        .map(s => ({ shape: s, want: s.props.zone === 'stack' }))
        .filter(({ shape, want }) => shape.props.targeted !== want)
        .map(({ shape, want }) => ({ id: shape.id, type: 'horizons-card', props: { targeted: want } }))
      if (updates.length) this.editor.updateShapes(updates)
    } else {
      this._setAllTargeted(false)
    }
  }

  _setAllTargeted(value) {
    const updates = this.editor.getCurrentPageShapes()
      .filter(s => s.type === 'horizons-card' && s.props.targeted !== value)
      .map(s => ({ id: s.id, type: 'horizons-card', props: { targeted: value } }))
    if (updates.length) this.editor.updateShapes(updates)
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  _clearPrefix(prefix) {
    const ids = this.editor.getCurrentPageShapes()
      .filter(s => s.id.startsWith(`shape:${prefix}`))
      .map(s => s.id)
    if (ids.length) this.editor.deleteShapes(ids)
  }

  fitBoard() {
    this.editor.zoomToFit()
  }
}
