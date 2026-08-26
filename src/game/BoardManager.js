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

/** Shallow compare of a card's props, so we only write when something changed. */
function samePropsAs(a, b) {
  for (const k in b) if (a[k] !== b[k]) return false
  return true
}

// Glide cards between zones. easeOutQuad so they arrive gently.
const ANIM = { animation: { duration: 260, easing: (t) => 1 - (1 - t) * (1 - t) } }

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

      // Every card the board should be showing, keyed by card identity so a card
      // keeps ONE shape as it changes zones. That continuity is the whole trick:
      // it's what turns a zone change into a position change we can tween.
      const desired = []
      const horizonIds = this._collectHorizon(state.zones?.horizon ?? [], desired)
      this._collectMyHand(state.players?.[myPlayerId]?.hand ?? [], canAct, desired)
      this._collectOpponentHand(state.players?.[opp]?.handSize ?? 0, desired)
      this._collectPile('dusk', state.zones?.dusk ?? [], desired)
      this._collectPile('myZenith', state.players?.[myPlayerId]?.zenith ?? [], desired)
      this._collectPile('oppZenith', state.players?.[opp]?.zenith ?? [], desired)

      // Reconcile first and note which cards moved; the glide is kicked off LAST.
      // bringToFront (restack) and updateShapes (targeting, zone counts) both
      // cancel an in-flight animation, so nothing that touches a card shape may
      // run after animateShapes.
      const toAnimate = this._reconcileCards(desired)
      this._restackHorizon(horizonIds)

      this._updateZoneCount('deck', state.zones?.deckSize ?? 0)
      this._updateZoneCount('dusk', state.zones?.dusk?.length ?? 0)
      this._updateZoneCount('myZenith', state.players?.[myPlayerId]?.zenith?.length ?? 0)
      this._updateZoneCount('oppZenith', state.players?.[opp]?.zenith?.length ?? 0)
      this._syncTargeting(state.pendingChoice, myPlayerId)

      if (toAnimate.length) this.editor.animateShapes(toAnimate, ANIM)
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

  // Top-left of a zone's card slot — the spawn point for a card that flies in
  // from that zone (a draw leaves the deck, a play leaves a hand).
  _anchor(name) {
    const z = ZONES[name]
    return { x: z.cx - CW / 2, y: z.cy - CH / 2 }
  }

  // ── Desired-shape collectors ─────────────────────────────────────────────────

  _collectHorizon(entries, out) {
    const z = ZONES.horizon
    // Overlap the stacked cards (pitch < card height) and center the pile
    // vertically so it stays in the band between the two hands and never
    // collides with them. Top of the horizon (i=0) is the newest entry.
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
        // The opponent's plays were never on screen as a face-up card, so they
        // fly in from their hand.
        spawn: this._anchor(entry.playedBy === this.myPlayerId ? 'myHand' : 'opponentHand'),
        props: {
          cardId: entry.cardId, faceUp: true, zone: 'horizon', owner: entry.playedBy,
          selected: false, targeted: false, dimmed: false, playable: false,
          horizonIndex: i, horizonIsTop: i === 0, w: CW, h: CH,
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
          selected: this.selectedCardId === code, targeted: false, dimmed: false,
          playable: canAct, horizonIndex: null, horizonIsTop: false, w: CW, h: CH,
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
          cardId: null, faceUp: false, zone: 'opponent-hand', owner: 'opp',
          selected: false, targeted: false, dimmed: false, playable: false,
          horizonIndex: null, horizonIsTop: false, w: CW, h: CH,
        },
      })
    }
  }

  // The dusk and both zeniths are face-up piles: show the top few cards fanned
  // by a few pixels so the pile reads as a stack, with the full contents
  // available through the zone viewer.
  _collectPile(name, codes, out) {
    if (!codes.length) return
    const z = ZONES[name]
    const show = codes.slice(-3)
    show.forEach((code, i) => {
      const offset = (i - (show.length - 1) / 2) * 5
      out.push({
        id: sid(`card-${code}`),
        x: z.cx - CW / 2 + offset,
        y: z.cy - CH / 2 + offset,
        // Fallback for a card that reaches the pile without having been on
        // screen (e.g. voided straight out of a hand we can't see).
        spawn: this._anchor('horizon'),
        props: {
          cardId: code, faceUp: true, zone: z.zoneType, owner: null,
          selected: false, targeted: false, dimmed: false, playable: false,
          horizonIndex: null, horizonIsTop: false, w: CW, h: CH,
        },
      })
    })
  }

  // ── Reconciliation ───────────────────────────────────────────────────────────

  _reconcileCards(desired) {
    const desiredById = new Map(desired.map(d => [d.id, d]))
    const existing = this.editor.getCurrentPageShapes().filter(s => s.type === 'horizons-card')
    const existingById = new Map(existing.map(s => [s.id, s]))

    // Cards that no longer belong anywhere on the board.
    const toDelete = existing.filter(s => !desiredById.has(s.id)).map(s => s.id)
    if (toDelete.length) this.editor.deleteShapes(toDelete)

    const toCreate = []
    const toUpdate = []
    const toAnimate = []

    for (const d of desired) {
      const shape = existingById.get(d.id)
      const moved = (a, b) => Math.abs(a - b) > 1
      if (!shape) {
        // New card: appear at its spawn point and glide to its resting place.
        const spawn = d.spawn ?? { x: d.x, y: d.y }
        const willAnimate = moved(spawn.x, d.x) || moved(spawn.y, d.y)
        toCreate.push({
          id: d.id, type: 'horizons-card', isLocked: true,
          x: willAnimate ? spawn.x : d.x,
          y: willAnimate ? spawn.y : d.y,
          props: d.props,
        })
        if (willAnimate) toAnimate.push({ id: d.id, type: 'horizons-card', x: d.x, y: d.y })
      } else {
        // Existing card: refresh its props in place, and glide it if it moved —
        // a play, a rise, or a pile reflowing as it recentres.
        //
        // Only write props that actually changed. updateShapes cancels an
        // in-flight animation on that shape, so a redundant write during a
        // second sync would snap a card mid-glide.
        if (!samePropsAs(shape.props, d.props)) {
          toUpdate.push({ id: d.id, type: 'horizons-card', props: d.props })
        }
        if (moved(shape.x, d.x) || moved(shape.y, d.y)) {
          toAnimate.push({ id: d.id, type: 'horizons-card', x: d.x, y: d.y })
        }
      }
    }

    if (toCreate.length) this.editor.createShapes(toCreate)
    if (toUpdate.length) this.editor.updateShapes(toUpdate)
    // The caller fires the animation last (see syncState) so restack and
    // targeting can't cancel it.
    return toAnimate
  }

  // Cards keep one shape for their whole life, so z-order no longer follows play
  // order. Re-stack the horizon each sync so the top entry (i=0) draws in front
  // of the cards it overlaps.
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
    const horizonChoiceTypes = ['duskFromHorizon','duskFromHorizonChoice','returnToControllerHand',
                              'returnHorizonCardToHandChoice','stealFromHorizon','stealFromHorizonChoice',
                              'gainControl','gainControlChoice','duskUnlessControllerPays']
    if (horizonChoiceTypes.includes(choice.type)) {
      // Only cards this choice can actually take light up, matching the prompt.
      const legal = choice.legalHorizonIndexes
      const updates = this.editor.getCurrentPageShapes()
        .filter(s => s.type === 'horizons-card')
        .map(s => ({
          shape: s,
          want: s.props.zone === 'horizon' &&
            (!legal || legal.includes(s.props.horizonIndex)),
        }))
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

  fitBoard() {
    this.editor.zoomToFit()
  }
}
