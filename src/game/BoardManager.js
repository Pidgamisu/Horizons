import { createShapeId } from 'tldraw'

const CW = 120  // card width
const CH = 168  // card height
const GAP = 10

// Board layout follows the rulebook diagram (p1): deck and dusk to one side,
// the horizon in the middle between the hands, and each player's zenith on
// their own side of the table.
//
// There are two arrangements of the same seven zones. Cards are a fixed size in
// board units and the camera scales them, so how big a card looks is decided
// entirely by how big the BOARD is relative to the viewport: zoomToFit shrinks
// until the whole board fits. The wide layout is ~900 units across, which on a
// phone means fitting 900 units into 375px — cards land at 36px, unreadable and
// below any sane tap target, with two thirds of the screen left empty because
// the board is square and the screen is not.
//
// So the narrow layout isn't a different design, it's the same table squeezed to
// roughly the aspect ratio of a phone held upright. Nothing else has to change:
// zoomToFit then fills the screen and cards come out about 2.7x bigger.
const LAYOUTS = {
  wide: {
    opponentHand: { cx:    0, cy: -340, w: 900,      h: CH + 20,  label: 'Hand',    zoneType: 'opponent-hand' },
    myHand:       { cx:    0, cy:  340, w: 900,      h: CH + 20,  label: 'Hand',    zoneType: 'hand' },
    horizon:      { cx:    0, cy:    0, w: CW + 40,  h: 460,      label: 'The Horizon', zoneType: 'horizon' },
    deck:         { cx: -320, cy:  -95, w: CW + 40,  h: CH + 40,  label: 'Deck',    zoneType: 'deck' },
    dusk:         { cx: -320, cy:   95, w: CW + 40,  h: CH + 40,  label: 'Dusk',    zoneType: 'dusk' },
    oppZenith:    { cx:  320, cy:  -95, w: CW + 40,  h: CH + 40,  label: 'Their Zenith', zoneType: 'zenith-opp' },
    myZenith:     { cx:  320, cy:   95, w: CW + 40,  h: CH + 40,  label: 'Your Zenith',  zoneType: 'zenith' },
  },
  narrow: {
    opponentHand: { cx:    0, cy: -430, w: 460,      h: CH + 20,  label: 'Hand',    zoneType: 'opponent-hand' },
    myHand:       { cx:    0, cy:  330, w: 460,      h: CH + 20,  label: 'Hand',    zoneType: 'hand' },
    horizon:      { cx:    0, cy:  -45, w: CW + 40,  h: 440,      label: 'The Horizon', zoneType: 'horizon' },
    deck:         { cx: -170, cy: -150, w: CW + 40,  h: CH + 40,  label: 'Deck',    zoneType: 'deck' },
    dusk:         { cx: -170, cy:   60, w: CW + 40,  h: CH + 40,  label: 'Dusk',    zoneType: 'dusk' },
    oppZenith:    { cx:  170, cy: -150, w: CW + 40,  h: CH + 40,  label: 'Their Zenith', zoneType: 'zenith-opp' },
    myZenith:     { cx:  170, cy:   60, w: CW + 40,  h: CH + 40,  label: 'Your Zenith',  zoneType: 'zenith' },
  },
  // A phone on its side is very wide and very short. The wide layout is nearly
  // square, so it fits by height and shrinks to nothing; this keeps the wide
  // arrangement but pulls the hands in and shortens the horizon.
  short: {
    opponentHand: { cx:    0, cy: -190, w: 900,      h: CH + 20,  label: 'Hand',    zoneType: 'opponent-hand' },
    myHand:       { cx:    0, cy:  190, w: 900,      h: CH + 20,  label: 'Hand',    zoneType: 'hand' },
    horizon:      { cx:    0, cy:    0, w: CW + 40,  h: 250,      label: 'The Horizon', zoneType: 'horizon' },
    // Sideways there is width to spare and no height at all, so the four piles
    // sit in one row either side of the horizon rather than stacked in pairs.
    deck:         { cx: -430, cy:    0, w: CW + 20,  h: CH + 10,  label: 'Deck',    zoneType: 'deck' },
    dusk:         { cx: -280, cy:    0, w: CW + 20,  h: CH + 10,  label: 'Dusk',    zoneType: 'dusk' },
    oppZenith:    { cx:  280, cy:    0, w: CW + 20,  h: CH + 10,  label: 'Their Zenith', zoneType: 'zenith-opp' },
    myZenith:     { cx:  430, cy:    0, w: CW + 20,  h: CH + 10,  label: 'Your Zenith',  zoneType: 'zenith' },
  },
}

// Below this width-to-height ratio the wide layout wastes most of the screen.
// A phone upright is ~0.46, a phone on its side ~2.2, a laptop ~1.6.
const NARROW_BELOW_ASPECT = 0.9

// Under this height there isn't room for the wide layout's full-height board.
const SHORT_BELOW_HEIGHT = 520

// Board units kept clear at the top and bottom of the narrow layout for the HUD
// bars. At the zoom this produces it works out around 75 screen pixels each end.
const CHROME_BAND = 110

// tldraw clamps to 0.05; anything at or under this means the board was framed
// against a viewport that was not really there.
const MIN_SANE_ZOOM = 0.06

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
    this._lastSync = null
    this._fitSize = null
    this._settleTimer = null
    this.mode = this._pickMode()
    this.zones = LAYOUTS[this.mode]

    // A hidden tab gets no animation frames, so it lays cards out without
    // animating. Re-sync when it comes back so anything that moved while it was
    // away is placed correctly, even if no new state arrives in the meantime.
    this._onVisibility = () => {
      if (document.visibilityState !== 'visible' || !this._lastSync) return
      this.syncState(this._lastSync.state, this._lastSync.myPlayerId)
      // A resize while the tab was hidden produces no ResizeObserver callback,
      // so check for one here too.
      this.refitIfResized()
      // And if the camera was left collapsed by a fit that ran while the tab
      // had no viewport, nothing above will notice — the recorded size can come
      // back identical. Recognise the stuck camera itself and reframe.
      if (this.hasCards() && this.editor.getZoomLevel() <= MIN_SANE_ZOOM) {
        this._fitSize = null
        this.fitBoard()
      }
    }
    document.addEventListener('visibilitychange', this._onVisibility)
  }

  dispose() {
    document.removeEventListener('visibilitychange', this._onVisibility)
    clearTimeout(this._settleTimer)
  }

  /**
   * Backstop for the glide. An animation can fail to finish for reasons the
   * board cannot see, and a card left part-way is worse than one that never
   * moved, so once the tween should be over any shape that did not arrive is
   * placed outright. setTimeout is used deliberately: unlike animation frames it
   * still fires in a tab that is not painting.
   */
  _scheduleSettle(targets) {
    clearTimeout(this._settleTimer)
    this._settleTimer = setTimeout(() => {
      const late = targets
        .filter(t => {
          const s = this.editor.getShape(t.id)
          return s && (Math.abs(s.x - t.x) > 1 || Math.abs(s.y - t.y) > 1)
        })
        .map(t => ({ id: t.id, type: 'horizons-card', x: t.x, y: t.y }))
      if (!late.length) return
      this.editor.run(() => this.editor.updateShapes(late),
        { history: 'ignore', ignoreShapeLock: true })
    }, ANIM.animation.duration + 150)
  }

  /** Can this tab actually run a tween? tldraw animates on requestAnimationFrame,
   *  which a hidden tab never fires. */
  _canAnimate() {
    return typeof document === 'undefined' || document.visibilityState === 'visible'
  }

  syncState(state, myPlayerId) {
    if (!state || state.phase === 'waiting') return
    this.myPlayerId = myPlayerId
    this._lastSync = { state, myPlayerId }
    // The constructor may have run before the container had a size, so settle
    // the layout here too rather than trusting the initial guess.
    this.applyLayoutMode()
    const opp = myPlayerId === 'p1' ? 'p2' : 'p1'
    // Server-driven sync: run as a single transaction that is kept out of the
    // user's undo history, and bypass shape-lock since our shapes are locked.
    // Can this player act right now (hold priority, no choice pending)? Drives
    // the on-card Play/Void buttons.
    const canAct = state.activePlayer === myPlayerId &&
      !(state.pendingChoice && state.pendingChoice.player === myPlayerId)
    const canAnimate = this._canAnimate()

    this.editor.run(() => {
      this._syncZones(state)

      // Every card the board should be showing, keyed by card identity so a card
      // keeps ONE shape as it changes zones. That continuity is the whole trick:
      // it's what turns a zone change into a position change we can tween.
      const desired = []
      const horizonIds = this._collectHorizon(state.zones?.horizon ?? [], desired)
      this._collectMyHand(state.players?.[myPlayerId]?.hand ?? [], canAct, desired)
      this._collectOpponentHand(state.players?.[opp]?.handSize ?? 0, desired)
      const pileIds = [
        ...this._collectPile('dusk', state.zones?.dusk ?? [], desired),
        ...this._collectPile('myZenith', state.players?.[myPlayerId]?.zenith ?? [], desired),
        ...this._collectPile('oppZenith', state.players?.[opp]?.zenith ?? [], desired),
      ]

      // Reconcile first and note which cards moved; the glide is kicked off LAST.
      // bringToFront (restack) and updateShapes (targeting, zone counts) both
      // cancel an in-flight animation, so nothing that touches a card shape may
      // run after animateShapes.
      const toAnimate = this._reconcileCards(desired, canAnimate)
      // Overlapping hands need a settled order or the fan reads as a jumble and
      // a tap can land on the card behind. Horizon last: it must sit above all.
      this._restackFan(pileIds)
      this._restackFan(this._handIds(state.players?.[myPlayerId]?.hand ?? []))
      this._restackFan(Array.from(
        { length: state.players?.[opp]?.handSize ?? 0 }, (_, i) => sid(`oppcard-${i}`)))
      // Keep the selected card on top across a sync too, not just on selection.
      if (this.selectedCardId) {
        const chosen = sid()
        if (this.editor.getShape(chosen)) this.editor.bringToFront([chosen])
      }
      this._restackHorizon(horizonIds)

      this._updateZoneCount('deck', state.zones?.deckSize ?? 0)
      this._updateZoneCount('dusk', state.zones?.dusk?.length ?? 0)
      this._updateZoneCount('myZenith', state.players?.[myPlayerId]?.zenith?.length ?? 0)
      this._updateZoneCount('oppZenith', state.players?.[opp]?.zenith?.length ?? 0)
      this._syncTargeting(state.pendingChoice, myPlayerId)

      if (toAnimate.length) {
        this.editor.animateShapes(toAnimate, ANIM)
        this._scheduleSettle(toAnimate)
      }
    }, { history: 'ignore', ignoreShapeLock: true })

    // Nothing on this board is ever the player's to undo, and an animation's
    // tick-driven writes land outside the block above, so drop whatever reached
    // the stack rather than letting it grow.
    this.editor.clearHistory()
  }

  // ── Zones ────────────────────────────────────────────────────────────────────

  /**
   * Selection changes the layout now (the chosen card lifts out of the fan),
   * so it has to re-run the whole sync rather than just repaint a prop.
   */
  setSelectedCard(cardId) {
    if (this.selectedCardId === cardId) return
    this.selectedCardId = cardId
    if (this._lastSync) this.syncState(this._lastSync.state, this._lastSync.myPlayerId)
  }

  /** Which arrangement suits the current viewport? */
  _pickMode() {
    const size = this._containerSize()
    if (!size || !size.h) return 'wide'
    if (size.w / size.h < NARROW_BELOW_ASPECT) return 'narrow'
    return size.h < SHORT_BELOW_HEIGHT ? 'short' : 'wide'
  }

  /**
   * Adopt the layout the viewport calls for. Returns true if it changed, so the
   * caller knows the board needs re-laying-out and re-framing.
   */
  applyLayoutMode() {
    const mode = this._pickMode()
    if (mode === this.mode) return false
    this.mode = mode
    this.zones = LAYOUTS[mode]
    return true
  }

  _syncZones(state) {
    const toCreate = []
    const toUpdate = []
    for (const [name, z] of Object.entries(this.zones)) {
      const id = sid(`zone-${name}`)
      const x = z.cx - z.w / 2
      const y = z.cy - z.h / 2
      const shape = this.editor.getShape(id)
      if (!shape) {
        toCreate.push({
          id, type: 'horizons-zone', isLocked: true, x, y,
          props: { label: z.label, zoneType: z.zoneType, count: null, highlight: false, w: z.w, h: z.h },
        })
      } else if (shape.x !== x || shape.y !== y || shape.props.w !== z.w || shape.props.h !== z.h) {
        // The layout switched under us (rotation, resize). Zones move outright
        // rather than gliding — the whole table is being re-drawn, not a card
        // travelling from one place to another.
        toUpdate.push({ id, type: 'horizons-zone', x, y, props: { w: z.w, h: z.h } })
      }
    }
    if (toCreate.length) this.editor.createShapes(toCreate)
    if (toUpdate.length) this.editor.updateShapes(toUpdate)
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
    const z = this.zones[name]
    return { x: z.cx - CW / 2, y: z.cy - CH / 2 }
  }

  // ── Desired-shape collectors ─────────────────────────────────────────────────

  _collectHorizon(entries, out) {
    const z = this.zones.horizon
    // Overlap the stacked cards (pitch < card height) and center the pile
    // vertically so it stays in the band between the two hands and never
    // collides with them. Top of the horizon (i=0) is the newest entry.
    const PITCH = 80
    const totalH = (entries.length - 1) * PITCH + CH
    const startY = z.cy - totalH / 2
    const ids = []
    entries.forEach((entry, i) => {
      const id = sid(`card-${entry.cardId}`)
      const controller = entry.controlledBy ?? entry.playedBy
      ids.push(id)
      out.push({
        id,
        x: z.cx - CW / 2,
        y: startY + i * PITCH,
        // The opponent's plays were never on screen as a face-up card, so they
        // fly in from their hand.
        spawn: this._anchor(entry.playedBy === this.myPlayerId ? 'myHand' : 'opponentHand'),
        props: {
          cardId: entry.cardId, faceUp: true, zone: 'horizon', owner: controller,
          // Control, not who played it: a card taken with Reverse or Change of
          // Luck answers to its new controller, and that is what decides who may
          // respond to it and whose it is to lose.
          mine: controller === this.myPlayerId,
          selected: false, targeted: false, dimmed: false, playable: false,
          horizonIndex: i, horizonIsTop: i === 0, w: CW, h: CH,
        },
      })
    })
    return ids
  }

  /**
   * How far apart to place cards in a hand. A full pitch is one card plus a gap;
   * once that would overflow the zone the cards overlap instead, like a hand
   * held in one fist. Without this a five-card hand is 650 units wide, which is
   * what forced the whole board to shrink on a phone.
   */
  _handPitch(zoneWidth, n) {
    if (n <= 1) return CW + GAP
    return Math.min(CW + GAP, (zoneWidth - 20 - CW) / (n - 1))
  }

  _collectMyHand(cards, canAct, out) {
    if (!cards.length) return
    const z = this.zones.myHand
    const pitch = this._handPitch(z.w, cards.length)
    const totalW = (cards.length - 1) * pitch + CW
    const startX = z.cx - totalW / 2
    cards.forEach((code, i) => {
      // The selected card lifts clear of the fan. Raising its z-order alone
      // isn't enough once cards overlap: its Play/Void buttons are wider than
      // the sliver of card left showing, so without the lift they read as
      // belonging to the neighbour they cover.
      const lift = this.selectedCardId === code ? 45 : 0
      out.push({
        id: sid(`card-${code}`),
        x: startX + i * pitch,
        y: z.cy - CH / 2 - lift,
        spawn: this._anchor('deck'), // a freshly drawn card flies from the deck
        props: {
          cardId: code, faceUp: true, zone: 'hand', owner: 'me',
          selected: this.selectedCardId === code, targeted: false, dimmed: false,
          playable: canAct, chunky: this.mode !== 'wide',
          horizonIndex: null, horizonIsTop: false, w: CW, h: CH,
        },
      })
    })
  }

  _collectOpponentHand(count, out) {
    if (!count) return
    const z = this.zones.opponentHand
    const pitch = this._handPitch(z.w, count)
    const totalW = (count - 1) * pitch + CW
    const startX = z.cx - totalW / 2
    // Face-down cards are anonymous, so they're keyed by slot, not identity.
    for (let i = 0; i < count; i++) {
      out.push({
        id: sid(`oppcard-${i}`),
        x: startX + i * pitch,
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
    if (!codes.length) return []
    const z = this.zones[name]
    const show = codes.slice(-3)
    const ids = []
    show.forEach((code, i) => {
      ids.push(sid(`card-${code}`))
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
          // Only the top card shows the tally, or the ones underneath would
          // print it again a few pixels away.
          pileCount: i === show.length - 1 ? codes.length : null,
          chunky: this.mode !== 'wide',
          horizonIndex: null, horizonIsTop: false, w: CW, h: CH,
        },
      })
    })
    return ids
  }

  // ── Reconciliation ───────────────────────────────────────────────────────────

  _reconcileCards(desired, canAnimate) {
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
        // A new card is always created where it belongs. It used to be spawned
        // at the deck and walked into place by the animation, which meant that
        // if the tween didn't run the card was simply left on the deck — the
        // whole hand piled up invisibly on one spot. Placement must never depend
        // on an animation actually playing.
        toCreate.push({
          id: d.id, type: 'horizons-card', isLocked: true,
          x: d.x, y: d.y,
          props: d.props,
        })
      } else {
        // Existing card: refresh its props in place, and glide it if it moved —
        // a play, a rise, or a pile reflowing as it recentres.
        //
        // Only write props that actually changed. updateShapes cancels an
        // in-flight animation on that shape, so a redundant write during a
        // second sync would snap a card mid-glide.
        const propsChanged = !samePropsAs(shape.props, d.props)
        const hasMoved = moved(shape.x, d.x) || moved(shape.y, d.y)
        if (hasMoved && !canAnimate) {
          // No animation frames available — move it outright, so a background
          // tab still shows every card where it belongs.
          toUpdate.push({ id: d.id, type: 'horizons-card', x: d.x, y: d.y, props: d.props })
        } else {
          if (propsChanged) toUpdate.push({ id: d.id, type: 'horizons-card', props: d.props })
          if (hasMoved) toAnimate.push({ id: d.id, type: 'horizons-card', x: d.x, y: d.y })
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
  _handIds(cards) {
    return cards.map(code => sid(`card-${code}`))
  }

  /** Left-to-right fan: each card overlaps the one before it. */
  _restackFan(ids) {
    for (const id of ids) {
      if (this.editor.getShape(id)) this.editor.bringToFront([id])
    }
  }

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

  /** Does the board have any cards laid out yet? Used to fit the camera only
   *  once there is something to fit. */
  hasCards() {
    return this.editor.getCurrentPageShapes().some(s => s.type === 'horizons-card')
  }

  /**
   * The canvas's size, or null if it doesn't currently have a real one.
   *
   * A backgrounded or unmounted tab reports 0x0, and fitting a board to a zero
   * sized viewport zooms to tldraw's minimum — the board becomes an invisible
   * speck and stays that way after the tab comes back, because nothing else
   * moves the camera. Refusing to answer is what stops every caller from acting
   * on a size that isn't real.
   */
  _containerSize() {
    // The editor's own viewport, not the container element: the camera maths
    // uses this, and the two disagree in a backgrounded tab — the element still
    // reports a width while tldraw's viewport has collapsed to zero. Measuring
    // the element there produced a plausible-looking size and a board fitted to
    // nothing.
    const b = this.editor.getViewportScreenBounds?.()
    if (!b || b.w <= 1 || b.h <= 1) return null
    return { w: Math.round(b.w), h: Math.round(b.h) }
  }

  fitBoard() {
    // Never frame against a viewport that isn't really there — see
    // _containerSize. Leaving _fitSize unset means the next real resize fits.
    if (!this._containerSize()) return false
    const bounds = this.editor.getCurrentPageBounds()
    if (bounds) {
      // zoomToFit reserves a generous margin all round. On a desktop that just
      // looks like breathing room; on a phone it is a third of the screen and
      // the difference between a readable card and a thumbnail, so the narrow
      // layout claims almost all of it.
      //
      // What it does keep is a band at the top and bottom for the HUD bars.
      // Reserving it here rather than letting them float over the board is the
      // only way they can't cover a hand: at this size the board fills the
      // screen, so anything drawn on top of it is drawn on top of a card.
      if (this.mode !== 'wide') {
        const b = bounds.clone()
        const band = this.mode === 'short' ? CHROME_BAND * 0.55 : CHROME_BAND
        b.y -= band
        b.h += band * 2
        this.editor.zoomToBounds(b, { inset: 6 })
      } else {
        // Unchanged on a wide screen: zoomToFit's own margin is what keeps the
        // floating HUD panels clear of the two hands.
        this.editor.zoomToFit()
      }
    } else {
      this.editor.zoomToFit()
    }
    this._fitSize = this._containerSize()
    return true
  }

  /**
   * Re-frame only if the canvas is a different size than when it was last
   * fitted. ResizeObserver is delivered through the rendering lifecycle, so a
   * hidden tab never gets the callback — this lets the visibility handler catch
   * a resize that happened while the tab was away.
   */
  refitIfResized() {
    if (!this.hasCards()) return false
    const now = this._containerSize()
    if (!now) return false
    // No recorded fit means the first attempt happened while the canvas had no
    // real size, so this is that fit rather than a re-fit.
    if (this._fitSize && now.w === this._fitSize.w && now.h === this._fitSize.h) return false
    // A resize can cross the aspect threshold — a phone rotating, a window being
    // dragged narrow. Re-lay the board out before re-framing it, or the camera
    // fits the old arrangement.
    if (this.applyLayoutMode() && this._lastSync) {
      this.syncState(this._lastSync.state, this._lastSync.myPlayerId)
    }
    this.fitBoard()
    return true
  }
}
