import { useEffect, useRef, useState, useCallback } from 'react'
import { Tldraw, useEditor } from 'tldraw'
import 'tldraw/tldraw.css'
import { gameClient } from './game/client.js'
import { TutorialClient } from './game/tutorialClient.js'
import { setClient } from './game/activeClient.js'
import { BoardManager } from './game/BoardManager.js'
import { CardShapeUtil } from './shapes/CardShapeUtil.jsx'
import { ZoneShapeUtil } from './shapes/ZoneShapeUtil.jsx'
import { HUD } from './ui/HUD.jsx'
import { ActionBar } from './ui/ActionBar.jsx'
import { ChoicePrompt } from './ui/ChoicePrompt.jsx'
import { GameOver, Lobby, Toast, BrandBackdrop } from './ui/GameOver.jsx'
import { CardTooltip } from './ui/CardTooltip.jsx'
import { ZoneViewer } from './ui/ZoneViewer.jsx'

// Face-up piles whose full contents are readable at any time (rulebook p5).
const PILE_ZONES = new Set(['dusk', 'zenith', 'zenith-opp'])
import { RulesOverlay } from './ui/Rules.jsx'
import { CoachOverlay } from './ui/CoachOverlay.jsx'
import { useIsNarrow } from './ui/useIsNarrow.js'
import { cardName } from './data/cardImages.js'

const CUSTOM_SHAPE_UTILS = [CardShapeUtil, ZoneShapeUtil]

// Events where a card is removed from the horizon before resolving (= countered):
// trashed, bounced to hand, stolen, moved to the deck, or trashed by a trigger.
const HORIZON_REMOVAL_EVENTS = new Set([
  'CARD_TO_DUSK_FROM_HORIZON',
  'CARD_RETURNED_TO_HAND',
  'CARD_STOLEN_TO_HAND',
  'CARD_TO_DECK',
  'CARD_TO_DUSK_BY_TRIGGER',
])

function GameCanvas({ gameState, myPlayerId, selectedCard, onCardClick, onHorizonCardClick, onCardHover, onZoneClick }) {
  const editor = useEditor()
  const boardRef = useRef(null)
  const hasFitRef = useRef(false)

  useEffect(() => {
    if (!editor) return
    editor.setCurrentTool('select')
    // Disable tldraw's default "double-click empty canvas → create a text shape".
    // The board is fully managed by BoardManager; players never author shapes,
    // and the cards' content is pointer-events:none so dbl-clicks land on the
    // canvas behind them and would otherwise spawn an editable text box.
    const idle = editor.getStateDescendant('select.idle')
    if (idle) idle.onDoubleClick = () => void 0
    boardRef.current = new BoardManager(editor)
    hasFitRef.current = false
    // Re-sync game state now that editor is ready
    if (gameState && myPlayerId) {
      boardRef.current.syncState(gameState, myPlayerId)
    }
    return () => { boardRef.current?.dispose(); boardRef.current = null }
  }, [editor])

  useEffect(() => {
    if (!editor || !boardRef.current || !gameState || !myPlayerId) return
    boardRef.current.syncState(gameState, myPlayerId)
    // Fit once the board actually has cards on it. Fitting on a timer instead
    // raced the first sync: the player who JOINS a game gets their state after
    // the editor mounts, so the fit ran against an empty page and zoomed to
    // nothing — their cards were laid out correctly but far too small to see,
    // and nothing re-fit until something else moved the camera.
    if (!hasFitRef.current && boardRef.current.hasCards()) {
      // Called directly, not via requestAnimationFrame: a hidden tab fires no
      // frames, and the board must be framed correctly there too. It declines
      // when the canvas has no real size yet, and then this stays false so the
      // next resize does the framing instead of skipping it forever.
      hasFitRef.current = boardRef.current.fitBoard()
    }
  }, [editor, gameState, myPlayerId])

  // Undo has no meaning here: the board is entirely server-driven and the player
  // never authors a shape. It isn't harmless either — BoardManager syncs with
  // history:'ignore', but an animation applies its movement on later ticks,
  // outside that block, so those writes land in the undo stack. Ctrl+Z then
  // rewinds cards to wherever they used to be while the game state stays put,
  // leaving the board showing a position that isn't real.
  useEffect(() => {
    if (!editor) return
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const key = e.key.toLowerCase()
      if (key !== 'z' && key !== 'y') return
      // Never swallow it while the player is typing (the room code field).
      const t = e.target
      if (t?.closest?.('input, textarea, [contenteditable="true"]')) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [editor])

  // Re-frame the board when the canvas changes size. Without this the camera is
  // fitted once and never again, so resizing the window (or anything else that
  // resizes the canvas) leaves the board badly framed — too small, or cropped.
  useEffect(() => {
    if (!editor) return
    const container = editor.getContainer()
    if (!container) return

    // Refit immediately rather than on a debounce, so the board tracks the
    // canvas as it is being resized instead of snapping once the drag stops.
    // refitIfResized() is a no-op when the size hasn't actually changed, and
    // ResizeObserver already coalesces to one callback per frame, so this is
    // cheap even mid-drag.
    const refit = () => { if (hasFitRef.current) boardRef.current?.refitIfResized() }

    let observer = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(refit)
      observer.observe(container)
    }
    // Fallback: ResizeObserver is delivered through the rendering lifecycle, so
    // it can be missed where frames aren't being produced. A window resize event
    // is a plain event and fires regardless.
    window.addEventListener('resize', refit)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', refit)
    }
  }, [editor])

  useEffect(() => {
    if (!editor || !boardRef.current) return
    boardRef.current.setSelectedCard(selectedCard)
  }, [editor, selectedCard])

  useEffect(() => {
    if (!editor) return

    const container = editor.getContainer()

    const handleClick = (e) => {
      // Clicks on the on-card Play/Void buttons are theirs to handle.
      if (e.target?.closest?.('button')) return
      // Resolve which card was clicked using the editor's own hit-testing.
      // Cards are locked, so hitLocked is required; hitInside catches clicks
      // anywhere within the filled card, not just its edge.
      const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
      const shape = editor.getShapeAtPoint(point, {
        hitInside: true,
        hitLocked: true,
        filter: (s) =>
          (s.type === 'horizons-card' && !!s.props.cardId) ||
          (s.type === 'horizons-zone' && PILE_ZONES.has(s.props.zoneType)),
      })
      if (!shape) return
      // Clicking anywhere on a face-up pile (a card in it or the zone itself)
      // opens the full-pile viewer, since the canvas only shows the top cards.
      if (shape.type === 'horizons-zone') { onZoneClick(shape.props.zoneType); return }
      const { cardId, zone } = shape.props
      if (PILE_ZONES.has(zone)) onZoneClick(zone)
      else if (zone === 'hand') onCardClick(cardId)
      else if (zone === 'horizon') onHorizonCardClick(cardId, editor)
    }

    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [editor, onCardClick, onHorizonCardClick, onZoneClick])


  return null
}

export default function App() {
  const [screen, setScreen] = useState('lobby')
  const [gameState, setGameState] = useState(null)
  const [myPlayerId, setMyPlayerId] = useState(null)
  const [selectedCard, setSelectedCard] = useState(null)
  const [toasts, setToasts] = useState([])
  const [roomId, setRoomId] = useState(null)
  const [hoveredCard, setHoveredCard] = useState(null)
  const [viewingZone, setViewingZone] = useState(null)
  const [revealedHand, setRevealedHand] = useState(null)
  const [showRules, setShowRules] = useState(false)
  // The client the UI is driving: the networked singleton, or a scripted
  // TutorialClient. Both share the same surface + emitted events.
  const [client, setActiveClient] = useState(gameClient)
  const narrow = useIsNarrow()
  // 'live' | 'reconnecting' | 'lost'. The board is entirely server-driven, so a
  // dropped socket leaves it frozen on the last state it received — visually
  // identical to a game that is simply waiting. Without this the player has no
  // way to tell the difference, and every click silently does nothing.
  const [connection, setConnection] = useState('live')
  const isTutorial = client instanceof TutorialClient
  const rootRef = useRef(null)

  const connect = useCallback((id) => {
    setClient(gameClient)
    setActiveClient(gameClient)
    setConnection('live')
    gameClient.connect(id)
    setRoomId(id)
    setScreen('waiting')
  }, [])

  const startTutorial = useCallback(() => {
    const tut = new TutorialClient()
    setClient(tut)        // module indirection (for the on-card Play/Void buttons)
    setActiveClient(tut)  // triggers re-subscribe + the start effect below
    setRoomId('TUTORIAL')
    setScreen('game')
  }, [])

  const leaveTutorial = useCallback(() => {
    client.disconnect()
    setClient(gameClient)
    setActiveClient(gameClient)
    setScreen('lobby')
    setGameState(null)
    setMyPlayerId(null)
    setSelectedCard(null)
  }, [client])

  useEffect(() => {
    const onJoined = ({ detail }) => {
      setMyPlayerId(detail.playerId)
      setRoomId(detail.roomId)
    }
    const onStateUpdate = ({ detail }) => {
      setMyPlayerId(detail.you)
      setGameState(detail.state)
      if (detail.state.phase === 'active') setScreen('game')
      if (detail.state.phase === 'ended') setScreen('ended')
    }
    const onEvents = ({ detail }) => {
      for (const ev of detail.events) {
        // Any effect that removes a card from the horizon before it resolves = countered.
        if (HORIZON_REMOVAL_EVENTS.has(ev.type)) addToast(`${cardName(ev.cardId)} countered!`)
        if (ev.type === 'HORIZON_CLEARED') addToast(`Horizon cleared — ${ev.cards?.length ?? 0} to the dusk`)
        if (ev.type === 'HAND_REVEALED') {
          const me = client.playerId
          const opp = me === 'p1' ? 'p2' : 'p1'
          if (ev.target === 'both' && ev.cards && !Array.isArray(ev.cards)) {
            setRevealedHand({ title: "Opponent's hand (revealed)", cardIds: ev.cards[opp] ?? [] })
          } else if (Array.isArray(ev.cards)) {
            if (ev.target === me) addToast('Your hand was revealed')
            else setRevealedHand({ title: "Opponent's hand (revealed)", cardIds: ev.cards })
          }
        }
        if (ev.type === 'CONTROL_GAINED') addToast('Gained control of a card')
        if (ev.type === 'HORIZON_POSITIONS_SWAPPED') addToast('Horizon order swapped!')
        if (ev.type === 'GAME_OVER') {
          addToast(ev.winner === myPlayerId ? '🎉 You win!' : 'You lose.', ev.winner === myPlayerId ? 'success' : 'error')
        }
      }
    }
    const onError = ({ detail }) => {
      if (detail.code === 'RECONNECT_FAILED') setConnection('lost')
      addToast(`⚠ ${detail.message}`, 'error')
    }
    const onConnected = () => setConnection('live')
    const onDropped = () => setConnection(c => (c === 'lost' ? c : 'reconnecting'))
    const onDisconn = () => addToast('Opponent disconnected. Waiting…', 'warning')

    client.addEventListener('joined', onJoined)
    client.addEventListener('stateUpdate', onStateUpdate)
    client.addEventListener('events', onEvents)
    client.addEventListener('gameError', onError)
    client.addEventListener('opponentDisconnected', onDisconn)
    client.addEventListener('connected', onConnected)
    client.addEventListener('disconnected', onDropped)

    return () => {
      client.removeEventListener('joined', onJoined)
      client.removeEventListener('stateUpdate', onStateUpdate)
      client.removeEventListener('events', onEvents)
      client.removeEventListener('gameError', onError)
      client.removeEventListener('opponentDisconnected', onDisconn)
      client.removeEventListener('connected', onConnected)
      client.removeEventListener('disconnected', onDropped)
    }
  }, [client, myPlayerId])

  // Start the scripted tutorial once it's the active client. Declared after the
  // listener effect so App (and the CoachOverlay child) are subscribed before
  // start() synchronously emits the first beat. The `started` guard is idempotent.
  useEffect(() => {
    if (client instanceof TutorialClient && !client.started) client.start()
  }, [client])

  const handleCardClick = useCallback((cardCode) => {
    setSelectedCard(prev => prev === cardCode ? null : cardCode)
  }, [])

  const handleHorizonCardClick = useCallback((cardCode, editor) => {
    const choice = client.pendingChoice
    if (!choice || choice.player !== myPlayerId) return
    const horizonChoiceTypes = ['duskFromHorizon', 'duskFromHorizonChoice', 'returnToControllerHand',
      'returnHorizonCardToHandChoice', 'stealFromHorizon', 'stealFromHorizonChoice',
      'gainControl', 'gainControlChoice']
    if (!horizonChoiceTypes.includes(choice.type)) return
    const horizonShapes = editor.getCurrentPageShapes()
      .filter(s => s.type === 'horizons-card' && s.props.zone === 'horizon')
      .sort((a, b) => a.y - b.y)
    const idx = horizonShapes.findIndex(s => s.props.cardId === cardCode)
    if (idx === -1) return
    client.choose({ horizonIndex: idx })
    setSelectedCard(null)
  }, [client, myPlayerId])

  const handleCardHover = useCallback((cardId, point) => {
    setHoveredCard(cardId ? { cardId, point } : null)
  }, [])


  const handleZoneClick = useCallback((zoneType) => {
    setViewingZone(zoneType)
  }, [])

  const handlePlayFromDusk = useCallback((cardId) => {
    client.playCard(cardId, { fromDusk: true })
    setViewingZone(null)
    setSelectedCard(null)
  }, [client])

  const handlePlay = useCallback(() => {
    if (!selectedCard) return
    client.playCard(selectedCard)
    setSelectedCard(null)
  }, [client, selectedCard])

  const handleVoid = useCallback(() => {
    if (!selectedCard) return
    client.voidCard(selectedCard)
    setSelectedCard(null)
  }, [client, selectedCard])

  // Keyboard shortcuts (mirror the ActionBar): Space = pass, P = play, V = void.
  useEffect(() => {
    const onKey = (e) => {
      if (screen !== 'game') return
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const canAct = client.holdingPriority && !client.myChoicePending
      if (e.code === 'Space') {
        e.preventDefault()
        if (canAct) client.passPriority()
      } else if (e.code === 'KeyP') {
        e.preventDefault()
        if (canAct) handlePlay()
      } else if (e.code === 'KeyV') {
        e.preventDefault()
        if (canAct) handleVoid()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen, client, handlePlay, handleVoid])

  // Block zoom gestures (ctrl+wheel / trackpad pinch) over the UI overlays.
  // tldraw handles zoom inside its own container, but the HUD/dialogs are
  // siblings on top of it, so a zoom gesture there falls through to the
  // browser and zooms the whole page. Suppress the default when the gesture
  // isn't over the canvas. Native listener with passive:false so we can
  // preventDefault (React's onWheel is passive and can't).
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onWheel = (e) => {
      if (!e.ctrlKey) return // only zoom gestures carry ctrlKey
      if (e.target.closest?.('.tl-container')) return // over the canvas: let tldraw zoom
      e.preventDefault()
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => root.removeEventListener('wheel', onWheel)
  }, [screen])

  // Clear the selection once the selected card leaves the hand — covers the
  // on-card Play/Void buttons, which act via gameClient directly.
  useEffect(() => {
    const hand = gameState?.players?.[myPlayerId]?.hand
    if (selectedCard && hand && !hand.includes(selectedCard)) setSelectedCard(null)
  }, [gameState, myPlayerId, selectedCard])

  const handlePass = useCallback(() => client.passPriority(), [client])
  const handleConcede = useCallback(() => {
    if (window.confirm('Concede this game?')) client.concede()
  }, [client])

  const addToast = (msg, type = 'info') => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, msg, type }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 3200)
  }

  const myState = gameState?.players?.[myPlayerId]
  const oppSlot = myPlayerId === 'p1' ? 'p2' : 'p1'
  const oppState = gameState?.players?.[oppSlot]
  const holdingPriority = gameState?.activePlayer === myPlayerId
  const isMyTurn = gameState?.turn === myPlayerId
  const pendingChoice = gameState?.pendingChoice ?? null
  const myChoicePending = pendingChoice?.player === myPlayerId

  if (screen === 'lobby') return (
    <>
      <Lobby onConnect={connect} onStartTutorial={startTutorial} />
    </>
  )
  // The waiting screen is also reachable with a dead socket — a drop before the
  // first state arrives, or a reload while offline — and on its own it is
  // indistinguishable from simply waiting for an opponent who hasn't joined yet.
  if (screen === 'waiting') return (
    <>
      <WaitingScreen roomId={roomId} />
      {!isTutorial && connection !== 'live' && <ConnectionBanner status={connection} />}
    </>
  )

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <Tldraw
          licenseKey="tldraw-nathaniel-lefcourt-2031-06-29/WyJBcndlb0lIQSIsWyIqLmhvcml6b25zY2FyZGdhbWUuY29tIl0sOSwiMjAzMS0wNi0yOSJd.Q0PRtvJv0XqsyXrQ6EoSYar9yN9xpsGmG/5kMtaXm8m8jcfe54SkKrGkbj23uRrgbQCIzU2fG8zSPT/pG/c1YA"
          shapeUtils={CUSTOM_SHAPE_UTILS}
          hideUi
          // ContextMenu is disabled outright: on a touch screen tldraw opens it
          // on long-press, which is the same gesture the game uses to enlarge a
          // card, so holding a card popped up an editor menu (Edit / Copy as /
          // Export as) over the board. Players never author shapes here, so the
          // menu has nothing useful to offer either.
          components={{ Background: DarkBackground, ContextMenu: null }}
        >
          <GameCanvas
            gameState={gameState}
            myPlayerId={myPlayerId}
            selectedCard={selectedCard}
            onCardClick={handleCardClick}
            onHorizonCardClick={handleHorizonCardClick}
            onCardHover={handleCardHover}
            onZoneClick={handleZoneClick}
          />
        </Tldraw>
      </div>

      {gameState && (
        <HUD
          myState={myState}
          oppState={oppState}
          isMyTurn={isMyTurn}
          holdingPriority={holdingPriority}
          turnNumber={gameState.turnNumber}
          onConcede={isTutorial ? undefined : handleConcede}
          narrow={narrow}
        />
      )}

      {isTutorial && screen === 'game' && (
        <CoachOverlay client={client} onExit={leaveTutorial} />
      )}

      {screen === 'game' && (
        <ActionBar
          holdingPriority={holdingPriority}
          myChoicePending={myChoicePending}
          onPass={handlePass}
          narrow={narrow}
        />
      )}

      {myChoicePending && pendingChoice && (
        <ChoicePrompt
          choice={pendingChoice}
          myHand={myState?.hand ?? []}
          horizonCards={gameState?.zones?.horizon ?? []}
          duskCards={gameState?.zones?.dusk ?? []}
          myEnergy={myState?.energy ?? 0}
          onRespond={(payload) => { gameClient.choose(payload); setSelectedCard(null) }}
        />
      )}

      {hoveredCard && (
        <CardTooltip cardId={hoveredCard.cardId} point={hoveredCard.point} />
      )}

      {viewingZone === 'dusk' && (
        <ZoneViewer
          title={myState?.canPlayFromDusk ? 'Dusk — you may play from here' : 'Dusk'}
          cardIds={[...(gameState?.zones?.dusk ?? [])].reverse()}
          onClose={() => setViewingZone(null)}
          onPlayCard={myState?.canPlayFromDusk ? handlePlayFromDusk : null}
        />
      )}

      {viewingZone === 'zenith' && (
        <ZoneViewer
          title={`Your Zenith — ${myState?.zenith?.length ?? 0} point${(myState?.zenith?.length ?? 0) === 1 ? '' : 's'}`}
          cardIds={[...(myState?.zenith ?? [])].reverse()}
          onClose={() => setViewingZone(null)}
        />
      )}

      {viewingZone === 'zenith-opp' && (
        <ZoneViewer
          title={`Their Zenith — ${oppState?.zenith?.length ?? 0} point${(oppState?.zenith?.length ?? 0) === 1 ? '' : 's'}`}
          cardIds={[...(oppState?.zenith ?? [])].reverse()}
          onClose={() => setViewingZone(null)}
        />
      )}

      {revealedHand && (
        <ZoneViewer
          title={revealedHand.title}
          cardIds={revealedHand.cardIds}
          badgeTop={false}
          onClose={() => setRevealedHand(null)}
        />
      )}

      {screen === 'ended' && gameState && (
        <GameOver
          winner={gameState.winner}
          myPlayerId={myPlayerId}
          myPoints={myState?.points ?? 0}
          oppPoints={oppState?.points ?? 0}
          onPlayAgain={() => {
            client.disconnect()
            setClient(gameClient)
            setActiveClient(gameClient)
            setScreen('lobby')
            setGameState(null)
            setMyPlayerId(null)
            setSelectedCard(null)
          }}
        />
      )}

      {/* How-to-play (rules) — top-left help button */}
      <button
        onClick={() => setShowRules(true)}
        title="How to play"
        style={{
          position: 'absolute', zIndex: 200,
          ...(narrow ? { top: 10, right: 8 } : { bottom: 20, right: 16 }),
          width: 34, height: 34, borderRadius: '50%',
          border: '1px solid rgba(255,255,255,0.12)',
          background: 'rgba(255,0,153,0.18)', color: '#fff',
          fontSize: 16, fontWeight: 800, cursor: 'pointer',
          pointerEvents: 'all',
        }}
      >
        ?
      </button>


      {showRules && <RulesOverlay onClose={() => setShowRules(false)} />}

      {!isTutorial && connection !== 'live' && <ConnectionBanner status={connection} />}

      <div style={{
        position: 'absolute', top: 76, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', flexDirection: 'column', gap: 6, zIndex: 400, pointerEvents: 'none'
      }}>
        {toasts.map(t => <Toast key={t.id} msg={t.msg} type={t.type} />)}
      </div>
    </div>
  )
}

/**
 * Shown whenever the socket is not live. The board keeps rendering underneath
 * (the last state is still worth seeing) but the player is told why nothing
 * they do is landing, and given the one action that actually recovers it.
 */
function ConnectionBanner({ status }) {
  const lost = status === 'lost'
  return (
    <div style={{
      position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
      zIndex: 600, pointerEvents: 'all',
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '10px 16px', borderRadius: 10,
      background: lost ? 'rgba(60,10,20,0.96)' : 'rgba(48,32,8,0.96)',
      border: `1px solid ${lost ? 'rgba(255,80,110,0.5)' : 'rgba(255,176,32,0.5)'}`,
      color: '#fff', fontSize: 13, fontWeight: 600,
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
    }}>
      <span style={{ color: lost ? '#ff8fa3' : '#ffd08a' }}>
        {lost ? 'Disconnected from the server.' : 'Connection lost, reconnecting…'}
      </span>
      {lost && (
        <button
          onClick={() => window.location.reload()}
          style={{
            border: 'none', borderRadius: 7, padding: '6px 14px',
            fontSize: 12, fontWeight: 700, cursor: 'pointer',
            background: '#ff0099', color: '#fff',
          }}
        >
          Reload
        </button>
      )}
    </div>
  )
}

function DarkBackground() {
  return <div style={{
    position: 'absolute', inset: 0,
    background: 'radial-gradient(ellipse at 50% 50%, #0e0e1f 0%, #07070f 100%)'
  }} />
}

function WaitingScreen({ roomId }) {
  const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomId}`
  return (
    <BrandBackdrop>
      <div style={{
        textAlign: 'center', color: '#fff', display: 'flex',
        flexDirection: 'column', alignItems: 'center', gap: 18
      }}>
        <div style={{
          width: 40, height: 40, border: '3px solid rgba(255,255,255,0.1)',
          borderTop: '3px solid #ff0099', borderRadius: '50%',
          animation: 'spin 1s linear infinite'
        }} />
        <p style={{ fontSize: 18, opacity: 0.8 }}>Waiting for opponent…</p>
        <p style={{ fontSize: 22, letterSpacing: '0.05em' }}>Room: <strong>{roomId}</strong></p>
        <p style={{ fontSize: 12, opacity: 0.4, marginTop: 4 }}>Send them this link:</p>
        <code
          onClick={() => navigator.clipboard?.writeText(shareUrl)}
          title="Click to copy"
          style={{
            fontSize: 12, background: 'rgba(255,255,255,0.07)', padding: '8px 16px',
            borderRadius: 6, color: '#ff0099', userSelect: 'all', cursor: 'pointer',
            maxWidth: 420, wordBreak: 'break-all'
          }}>
          {shareUrl}
        </code>
        <p style={{ fontSize: 11, opacity: 0.3 }}>Click the link to copy</p>
      </div>
    </BrandBackdrop>
  )
}
