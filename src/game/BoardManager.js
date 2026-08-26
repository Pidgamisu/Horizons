import { createShapeId } from 'tldraw'

const CW = 120  // card width
const CH = 168  // card height
const GAP = 10

// Board layout follows the rulebook diagram (p1): deck and dusk to one side,
// the horizon in the middle between the hands, and each player's zenith on
// their own side of the table.
const ZONES = {
  opponentHand: { cx:    0, cy: -340, w: 900,      h: CH + 20,  label: 'Hand',    zoneType: 'opponent-hand' },
  myHand:       { cx:    0, cy:  340, w: 900,      h: CH + 20,  label: 'Hand',    zoneType: 'hand' },
  horizon:      { cx:    0, cy:    0, w: CW + 40,  h: 460,      label: 'The Horizon', zoneType: 'horizon' },
  deck:         { cx: -320, cy:  -95, w: CW + 40,  h: CH + 40,  label: 'Deck',    zoneType: 'deck' },
  dusk:         { cx: -320, cy:   95, w: CW + 40,  h: CH + 40,  label: 'Dusk',    zoneType: 'dusk' },
  oppZenith:    { cx:  320, cy:  -95, w: CW + 40,  h: CH + 40,  label: 'Their Zenith', zoneType: 'zenith-opp' },
  myZenith:     { cx:  320, cy:   95, w: CW + 40,  h: CH + 40,  label: 'Your Zenith',  zoneType: 'zenith' },
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
    // Can this player act right now (hold priority, no choice pending)? Drives
    // the on-card Play/Void buttons.
    const canAct = state.activePlayer === myPlayerId &&
      !(state.pendingChoice && state.pendingChoice.player === myPlayerId)
    this.editor.run(() => {
      this._syncZones(state)
      this._syncHorizon(state.zones?.horizon ?? [])
      this._syncHand(state.players?.[myPlayerId]?.hand ?? [], canAct)
      this._syncOpponentHand(state.players?.[opp]?.handSize ?? 0)
      this._syncPile('dusk', state.zones?.dusk ?? [])
      this._syncPile('myZenith', state.players?.[myPlayerId]?.zenith ?? [])
      this._syncPile('oppZenith', state.players?.[opp]?.zenith ?? [])
      this._updateZoneCount('deck', state.zones?.deckSize ?? 0)
      this._updateZoneCount('dusk', state.zones?.dusk?.length ?? 0)
      this._updateZoneCount('myZenith', state.players?.[myPlayerId]?.zenith?.length ?? 0)
      this._updateZoneCount('oppZenith', state.players?.[opp]?.zenith?.length ?? 0)
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

  // ── Horizon ─────────────────────────────────────────────────────────────────────

  _syncHorizon(entries) {
    this._clearPrefix('card-horizon-')
    if (!entries.length) return

    const z = ZONES.horizon
    // Overlap the stacked cards (pitch < card height) and center the pile
    // vertically so it stays in the band between the two hands and never
    // collides with them. Top of the horizon (i=0) is the newest entry.
    const PITCH = 80
    const totalH = (entries.length - 1) * PITCH + CH
    const startY = z.cy - totalH / 2
    const shapes = entries.map((entry, i) => ({
      id: sid(`card-horizon-${i}`),
      type: 'horizons-card',
      isLocked: true,
      x: z.cx - CW / 2,
      y: startY + i * PITCH,
      props: {
        cardId: entry.cardId, faceUp: true, zone: 'horizon',
        owner: entry.playedBy, selected: false, targeted: false,
        dimmed: false, w: CW, h: CH,
        horizonIndex: i,        // used for choice targeting
        horizonIsTop: i === 0,  // visual badge
      },
    }))
    // Create bottom-to-top so the top-of-horizon card (i=0) is drawn last and
    // therefore overlaps the cards below it.
    this.editor.createShapes(shapes.reverse())
  }

  // ── My hand ───────────────────────────────────────────────────────────────────

  _syncHand(cards, canAct = false) {
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
        targeted: false, dimmed: false, playable: canAct, w: CW, h: CH,
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

  // ── Face-up piles (dusk, zeniths) ─────────────────────────────────────────────

  // The dusk and both zeniths are face-up piles: show the top few cards fanned
  // by a few pixels so the pile reads as a stack, with the full contents
  // available through the zone viewer.
  _syncPile(name, codes) {
    this._clearPrefix(`card-${name}-`)
    if (!codes.length) return
    const z = ZONES[name]
    const show = codes.slice(-3)
    this.editor.createShapes(show.map((code, i) => {
      const offset = (i - (show.length - 1) / 2) * 5
      return {
        id: sid(`card-${name}-${i}`),
        type: 'horizons-card',
        isLocked: true,
        x: z.cx - CW / 2 + offset, y: z.cy - CH / 2 + offset,
        props: {
          cardId: code, faceUp: true, zone: z.zoneType,
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
    const horizonChoiceTypes = ['duskFromHorizon','duskFromHorizonChoice','returnToControllerHand',
                              'returnHorizonCardToHandChoice','stealFromHorizon','stealFromHorizonChoice',
                              'gainControl','gainControlChoice','duskUnlessControllerPays']
    if (horizonChoiceTypes.includes(choice.type)) {
      const updates = this.editor.getCurrentPageShapes()
        .filter(s => s.type === 'horizons-card')
        .map(s => ({ shape: s, want: s.props.zone === 'horizon' }))
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
