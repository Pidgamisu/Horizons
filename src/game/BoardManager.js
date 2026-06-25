import { createShapeId } from '@tldraw/editor'

const CW = 120  // card width
const CH = 168  // card height
const GAP = 10

const ZONES = {
  opponentHand: { cx: 0, cy: -340, w: 900, h: CH + 20,  label: 'Hand',  zoneType: 'opponent-hand' },
  myHand:       { cx: 0, cy:  340, w: 900, h: CH + 20,  label: 'Hand',  zoneType: 'hand' },
  stack:        { cx: -220, cy: 0, w: CW + 40, h: 520,  label: 'Stack', zoneType: 'stack' },
  trash:        { cx:  20,  cy: 0, w: CW + 40, h: CH + 40, label: 'Trash', zoneType: 'trash' },
  deck:         { cx:  180, cy: -60, w: CW + 40, h: CH + 40, label: 'Deck', zoneType: 'deck' },
  void:         { cx:  180, cy:  80, w: CW + 40, h: CH + 40, label: 'Void', zoneType: 'void' },
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
    this._syncZones(state)
    this._syncStack(state.zones?.stack ?? [])
    this._syncHand(state.players?.[myPlayerId]?.hand ?? [])
    this._syncOpponentHand(state.players?.[opp]?.handSize ?? 0)
    this._syncTrash(state.zones?.trash ?? [])
    this._updateZoneCount('deck', state.zones?.deckSize ?? 0)
    this._updateZoneCount('void', state.zones?.voidSize ?? 0)
    this._syncTargeting(state.pendingChoice, myPlayerId)
  }

  // ── Zones ────────────────────────────────────────────────────────────────────

  _syncZones(state) {
    for (const [name, z] of Object.entries(ZONES)) {
      const id = sid(`zone-${name}`)
      if (!this.editor.getShape(id)) {
        this.editor.createShape({
          id, type: 'horizons-zone',
          x: z.cx - z.w / 2, y: z.cy - z.h / 2,
          props: { label: z.label, zoneType: z.zoneType, count: null, highlight: false, w: z.w, h: z.h },
        })
      }
    }
  }

  _updateZoneCount(name, count) {
    const id = sid(`zone-${name}`)
    if (this.editor.getShape(id)) {
      this.editor.updateShape({ id, type: 'horizons-zone', props: { count } })
    }
  }

  // ── Stack ─────────────────────────────────────────────────────────────────────

  _syncStack(entries) {
    this._clearPrefix('card-stack-')
    if (!entries.length) return

    const z = ZONES.stack
    entries.forEach((entry, i) => {
      const isTop = i === 0
      this.editor.createShape({
        id: sid(`card-stack-${i}`),
        type: 'horizons-card',
        x: z.cx - CW / 2,
        y: (z.cy - z.h / 2 + 20) + i * (CH + GAP),
        props: {
          cardId: entry.cardId, faceUp: true, zone: 'stack',
          owner: entry.playedBy, selected: false, targeted: false,
          dimmed: false, w: CW, h: CH,
          stackIndex: i,     // used for choice targeting
          stackIsTop: isTop, // visual badge
        },
      })
    })
  }

  // ── My hand ───────────────────────────────────────────────────────────────────

  _syncHand(cards) {
    this._clearPrefix('card-myhand-')
    if (!cards.length) return
    const z = ZONES.myHand
    const totalW = cards.length * CW + (cards.length - 1) * GAP
    const startX = z.cx - totalW / 2
    cards.forEach((code, i) => {
      this.editor.createShape({
        id: sid(`card-myhand-${i}`),
        type: 'horizons-card',
        x: startX + i * (CW + GAP), y: z.cy - CH / 2,
        props: {
          cardId: code, faceUp: true, zone: 'hand', owner: 'me',
          selected: this.selectedCardId === code,
          targeted: false, dimmed: false, w: CW, h: CH,
        },
      })
    })
  }

  // ── Opponent hand ─────────────────────────────────────────────────────────────

  _syncOpponentHand(count) {
    this._clearPrefix('card-opphand-')
    if (!count) return
    const z = ZONES.opponentHand
    const totalW = count * CW + (count - 1) * GAP
    const startX = z.cx - totalW / 2
    for (let i = 0; i < count; i++) {
      this.editor.createShape({
        id: sid(`card-opphand-${i}`),
        type: 'horizons-card',
        x: startX + i * (CW + GAP), y: z.cy - CH / 2,
        props: {
          cardId: null, faceUp: false, zone: 'opponent-hand',
          owner: 'opp', selected: false, targeted: false, dimmed: false, w: CW, h: CH,
        },
      })
    }
  }

  // ── Trash ─────────────────────────────────────────────────────────────────────

  _syncTrash(codes) {
    this._clearPrefix('card-trash-')
    if (!codes.length) return
    const z = ZONES.trash
    const show = codes.slice(-3)
    show.forEach((code, i) => {
      const offset = (i - (show.length - 1) / 2) * 5
      this.editor.createShape({
        id: sid(`card-trash-${i}`),
        type: 'horizons-card',
        x: z.cx - CW / 2 + offset, y: z.cy - CH / 2 + offset,
        props: {
          cardId: code, faceUp: true, zone: 'trash',
          owner: null, selected: false, targeted: false, dimmed: false, w: CW, h: CH,
        },
      })
    })
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
      this.editor.getCurrentPageShapes()
        .filter(s => s.type === 'horizons-card' && s.props.zone === 'stack')
        .forEach(s => {
          this.editor.updateShape({ id: s.id, type: 'horizons-card', props: { targeted: true } })
        })
      // Un-target everything else
      this.editor.getCurrentPageShapes()
        .filter(s => s.type === 'horizons-card' && s.props.zone !== 'stack')
        .forEach(s => {
          if (s.props.targeted) this.editor.updateShape({ id: s.id, type: 'horizons-card', props: { targeted: false } })
        })
    } else {
      this._setAllTargeted(false)
    }
  }

  _setAllTargeted(value) {
    this.editor.getCurrentPageShapes()
      .filter(s => s.type === 'horizons-card' && s.props.targeted !== value)
      .forEach(s => this.editor.updateShape({ id: s.id, type: 'horizons-card', props: { targeted: value } }))
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
