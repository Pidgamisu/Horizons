import { createShapeId } from 'tldraw'

const CW = 120  // card width
const CH = 168  // card height
const GAP = 10

const ZONES = {
  opponentHand: { cx: 0, cy: -340, w: 900, h: CH + 20,  label: 'Hand',  zoneType: 'opponent-hand' },
  myHand:       { cx: 0, cy:  340, w: 900, h: CH + 20,  label: 'Hand',  zoneType: 'hand' },
  horizon:      { cx: -220, cy: 0, w: CW + 40, h: 460,  label: 'Horizon', zoneType: 'horizon' },
  trash:        { cx:  20,  cy: 0, w: CW + 40, h: CH + 40, label: 'Trash', zoneType: 'trash' },
  deck:         { cx:  180, cy: -100, w: CW + 40, h: CH + 40, label: 'Deck', zoneType: 'deck' },
  void:         { cx:  180, cy:  100, w: CW + 40, h: CH + 40, label: 'Void', zoneType: 'void' },
}

const sid = (key) => createShapeId(key)

// Glide cards between zones. easeOutQuad so they arrive gently.
const ANIM = { animation: { duration: 280, easing: (t) => 1 - (1 - t) * (1 - t) } }

export class BoardManager {
  constructor(editor) {
    this.editor = editor
    this.selectedCardId = null
    this.myPlayerId = null
  }

  syncState(state, myPlayerId) {
    if (!state || state.phase === 'waiting') return
    this.myPlayerId = myPlayerId
    const opp = myPlayerId === 'p1' ? 'p2' : 'p1'
    // Server-driven sync: run as a single transaction that is kept out of the
    // user's undo history, and bypass shape-lock since our shapes are locked.
    // Can this player act right now (hold priority, no choice pending)? Drives
    // the on-card Play/Void buttons.
    const canAct = state.activePlayer === myPlayerId &&
      !(state.pendingChoice && state.pendingChoice.player === myPlayerId)
    this.editor.run(() => {
      this._syncZones(state)

      // Desired card shapes for this state, keyed by card identity so a card
      // keeps ONE shape as it moves between zones — that continuity is what lets
      // us animate a play (hand → horizon) or a trash (horizon → trash).
      const desired = []
      const horizonIds = this._collectHorizon(state.zones?.horizon ?? [], desired)
      this._collectMyHand(state.players?.[myPlayerId]?.hand ?? [], canAct, desired)
      this._collectOpponentHand(state.players?.[opp]?.handSize ?? 0, desired)
      this._collectTrash(state.zones?.trash ?? [], desired)

      this._reconcileCards(desired)
      this._restackHorizon(horizonIds)

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

  // Top-left of a zone's card slot — used as the spawn point for cards that fly
  // in from that zone (a play leaves the hand, a draw leaves the deck).
  _anchor(name) {
    const z = ZONES[name]
    return { x: z.cx - CW / 2, y: z.cy - CH / 2 }
  }

  // ── Desired-shape collectors ───────────────────────────────────────────────────

  _collectHorizon(entries, out) {
    const z = ZONES.horizon
    // Overlap the stacked cards (pitch < card height) and center the pile
    // vertically so it stays in the band between the two hands. Top (i=0) is the
    // newest entry.
    const PITCH = 80
    const totalH = (entries.length - 1) * PITCH + CH
    const startY = z.cy - totalH / 2
    const ids = []
    entries.forEach((entry, i) => {
      const id = sid(`card-${entry.cardId}`)
      ids.push(id)
      out.push({
        id,
        x: z.cx - CW / 2,
        y: startY + i * PITCH,
        // A card revealed on the horizon (mainly the opponent's plays) flies in
        // from its controller's hand.
        spawn: this._anchor(entry.playedBy === this.myPlayerId ? 'myHand' : 'opponentHand'),
        props: {
          cardId: entry.cardId, faceUp: true, zone: 'horizon', owner: entry.playedBy,
          horizonIndex: i, horizonIsTop: i === 0, resolving: !!entry.resolving,
          playable: false, selected: false, w: CW, h: CH,
        },
      })
    })
    return ids
  }

  _collectMyHand(cards, canAct, out) {
    if (!cards.length) return
    const z = ZONES.myHand
    const totalW = cards.length * CW + (cards.length - 1) * GAP
    const startX = z.cx - totalW / 2
    cards.forEach((code, i) => {
      out.push({
        id: sid(`card-${code}`),
        x: startX + i * (CW + GAP),
        y: z.cy - CH / 2,
        spawn: this._anchor('deck'), // a freshly drawn card flies from the deck
        props: {
          cardId: code, faceUp: true, zone: 'hand', owner: 'me',
          selected: this.selectedCardId === code, playable: canAct,
          horizonIndex: null, horizonIsTop: false, resolving: false, w: CW, h: CH,
        },
      })
    })
  }

  _collectOpponentHand(count, out) {
    if (!count) return
    const z = ZONES.opponentHand
    const totalW = count * CW + (count - 1) * GAP
    const startX = z.cx - totalW / 2
    // Face-down cards are anonymous, so they're keyed by slot, not identity.
    for (let i = 0; i < count; i++) {
      out.push({
        id: sid(`oppcard-${i}`),
        x: startX + i * (CW + GAP),
        y: z.cy - CH / 2,
        spawn: this._anchor('deck'),
        props: {
          cardId: null, faceUp: false, zone: 'opponent-hand', owner: 'opp', w: CW, h: CH,
        },
      })
    }
  }

  _collectTrash(codes, out) {
    if (!codes.length) return
    const z = ZONES.trash
    const show = codes.slice(-3)
    show.forEach((code, i) => {
      const offset = (i - (show.length - 1) / 2) * 5
      out.push({
        id: sid(`card-${code}`),
        x: z.cx - CW / 2 + offset,
        y: z.cy - CH / 2 + offset,
        spawn: this._anchor('horizon'), // fallback if the card wasn't already on screen
        props: {
          cardId: code, faceUp: true, zone: 'trash', owner: null,
          horizonIndex: null, horizonIsTop: false, resolving: false,
          playable: false, selected: false, w: CW, h: CH,
        },
      })
    })
  }

  // ── Reconciliation ──────────────────────────────────────────────────────────────

  _reconcileCards(desired) {
    const desiredById = new Map(desired.map(d => [d.id, d]))
    const existing = this.editor.getCurrentPageShapes().filter(s => s.type === 'horizons-card')
    const existingById = new Map(existing.map(s => [s.id, s]))

    // Remove cards that no longer belong anywhere on the board.
    const toDelete = existing.filter(s => !desiredById.has(s.id)).map(s => s.id)
    if (toDelete.length) this.editor.deleteShapes(toDelete)

    const toCreate = []
    const toUpdate = []
    const toAnimate = []

    for (const d of desired) {
      const shape = existingById.get(d.id)
      if (!shape) {
        // New card: appear at its spawn point and glide to its resting place.
        const spawn = d.spawn ?? { x: d.x, y: d.y }
        const willAnimate = Math.abs(spawn.x - d.x) > 1 || Math.abs(spawn.y - d.y) > 1
        toCreate.push({
          id: d.id, type: 'horizons-card', isLocked: true,
          x: willAnimate ? spawn.x : d.x, y: willAnimate ? spawn.y : d.y,
          props: d.props,
        })
        if (willAnimate) toAnimate.push({ id: d.id, type: 'horizons-card', x: d.x, y: d.y })
      } else {
        // Existing card: refresh its props in place, and glide it if it moved
        // (a play, a trash, or a reflow when the pile recenters).
        toUpdate.push({ id: d.id, type: 'horizons-card', props: d.props })
        if (Math.abs(shape.x - d.x) > 1 || Math.abs(shape.y - d.y) > 1) {
          toAnimate.push({ id: d.id, type: 'horizons-card', x: d.x, y: d.y })
        }
      }
    }

    if (toCreate.length) this.editor.createShapes(toCreate)
    if (toUpdate.length) this.editor.updateShapes(toUpdate)
    if (toAnimate.length) this.editor.animateShapes(toAnimate, ANIM)
  }

  // Cards keep one shape for their whole life, so their z-order no longer follows
  // play order. Re-stack the horizon each sync so the top entry (i=0) draws in
  // front of the ones it overlaps.
  _restackHorizon(idsTopToBottom) {
    for (let i = idsTopToBottom.length - 1; i >= 0; i--) {
      if (this.editor.getShape(idsTopToBottom[i])) this.editor.bringToFront([idsTopToBottom[i]])
    }
  }

  // ── Targeting ─────────────────────────────────────────────────────────────────

  _syncTargeting(choice, myPlayerId) {
    if (!choice || choice.player !== myPlayerId) {
      this._setAllTargeted(false)
      return
    }
    const horizonChoiceTypes = ['trashFromHorizon','trashFromHorizonChoice','returnToControllerHand',
                              'returnHorizonCardToHandChoice','stealFromHorizon','stealFromHorizonChoice',
                              'gainControl','gainControlChoice','trashUnlessControllerPays']
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

  fitBoard() {
    this.editor.zoomToFit()
  }
}
