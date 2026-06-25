import { useEffect, useRef, useState, useCallback } from 'react'
import { Tldraw, useEditor } from 'tldraw'
import 'tldraw/tldraw.css'
import { gameClient } from './game/client.js'
import { BoardManager } from './game/BoardManager.js'
import { CardShapeUtil } from './shapes/CardShapeUtil.jsx'
import { ZoneShapeUtil } from './shapes/ZoneShapeUtil.jsx'
import { HUD } from './ui/HUD.jsx'
import { ActionBar } from './ui/ActionBar.jsx'
import { ChoicePrompt } from './ui/ChoicePrompt.jsx'
import { GameOver, Lobby, Toast } from './ui/GameOver.jsx'
import { CardTooltip } from './ui/CardTooltip.jsx'

const CUSTOM_SHAPE_UTILS = [CardShapeUtil, ZoneShapeUtil]

function GameCanvas({ gameState, myPlayerId, selectedCard, onCardClick, onStackCardClick, onCardHover }) {
  const editor = useEditor()
  const boardRef = useRef(null)

  useEffect(() => {
    if (!editor) return
    editor.setCurrentTool('select')
    boardRef.current = new BoardManager(editor)
    // Re-sync game state now that editor is ready
    if (gameState && myPlayerId) {
      boardRef.current.syncState(gameState, myPlayerId)
    }
    setTimeout(() => boardRef.current?.fitBoard(), 100)
    return () => { boardRef.current = null }
  }, [editor])

  useEffect(() => {
    if (!editor || !boardRef.current || !gameState || !myPlayerId) return
    boardRef.current.syncState(gameState, myPlayerId)
  }, [editor, gameState, myPlayerId])

  useEffect(() => {
    if (!editor || !boardRef.current) return
    boardRef.current.selectedCardId = selectedCard
    const updates = editor.getCurrentPageShapes()
      .filter(s => s.type === 'horizons-card' && s.props.zone === 'hand')
      .filter(s => s.props.selected !== (s.props.cardId === selectedCard))
      .map(s => ({ id: s.id, type: 'horizons-card', props: { selected: s.props.cardId === selectedCard } }))
    if (updates.length) {
      editor.run(() => editor.updateShapes(updates), { history: 'ignore', ignoreShapeLock: true })
    }
  }, [editor, selectedCard])

  useEffect(() => {
    if (!editor) return

    const container = editor.getContainer()

    const handleClick = (e) => {
      // Resolve which card was clicked using the editor's own hit-testing.
      // Cards are locked, so hitLocked is required; hitInside catches clicks
      // anywhere within the filled card, not just its edge.
      const point = editor.screenToPage({ x: e.clientX, y: e.clientY })
      const shape = editor.getShapeAtPoint(point, {
        hitInside: true,
        hitLocked: true,
        filter: (s) => s.type === 'horizons-card' && !!s.props.cardId,
      })
      if (!shape) return
      const { cardId, zone } = shape.props
      if (zone === 'hand') onCardClick(cardId)
      else if (zone === 'stack') onStackCardClick(cardId, editor)
    }

    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [editor, onCardClick, onStackCardClick])

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

  const connect = useCallback((id) => {
    gameClient.connect(id)
    setRoomId(id)
    setScreen('waiting')
  }, [])

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
        if (ev.type === 'CARD_TRASHED_FROM_STACK') addToast('Card countered!')
        if (ev.type === 'STACK_CLEARED') addToast(`Stack cleared — ${ev.cards?.length ?? 0} trashed`)
        if (ev.type === 'HAND_REVEALED') addToast('Hand revealed!')
        if (ev.type === 'CONTROL_GAINED') addToast('Gained control of a card')
        if (ev.type === 'STACK_POSITIONS_SWAPPED') addToast('Stack order swapped!')
        if (ev.type === 'GAME_OVER') {
          addToast(ev.winner === myPlayerId ? '🎉 You win!' : 'You lose.', ev.winner === myPlayerId ? 'success' : 'error')
        }
      }
    }
    const onError = ({ detail }) => addToast(`⚠ ${detail.message}`, 'error')
    const onDisconn = () => addToast('Opponent disconnected. Waiting…', 'warning')

    gameClient.addEventListener('joined', onJoined)
    gameClient.addEventListener('stateUpdate', onStateUpdate)
    gameClient.addEventListener('events', onEvents)
    gameClient.addEventListener('gameError', onError)
    gameClient.addEventListener('opponentDisconnected', onDisconn)

    return () => {
      gameClient.removeEventListener('joined', onJoined)
      gameClient.removeEventListener('stateUpdate', onStateUpdate)
      gameClient.removeEventListener('events', onEvents)
      gameClient.removeEventListener('gameError', onError)
      gameClient.removeEventListener('opponentDisconnected', onDisconn)
    }
  }, [myPlayerId])

  useEffect(() => {
    const onKey = (e) => {
      if (e.code !== 'Space') return
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      e.preventDefault()
      if (screen !== 'game') return
      if (!gameClient.holdingPriority || gameClient.myChoicePending) return
      gameClient.passPriority()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen])

  const handleCardClick = useCallback((cardCode) => {
    setSelectedCard(prev => prev === cardCode ? null : cardCode)
  }, [])

  const handleStackCardClick = useCallback((cardCode, editor) => {
    const choice = gameClient.pendingChoice
    if (!choice || choice.player !== myPlayerId) return
    const stackChoiceTypes = ['trashFromStack', 'trashFromStackChoice', 'returnToControllerHand',
      'returnStackCardToHandChoice', 'stealFromStack', 'stealFromStackChoice',
      'gainControl', 'gainControlChoice']
    if (!stackChoiceTypes.includes(choice.type)) return
    const stackShapes = editor.getCurrentPageShapes()
      .filter(s => s.type === 'horizons-card' && s.props.zone === 'stack')
      .sort((a, b) => a.y - b.y)
    const idx = stackShapes.findIndex(s => s.props.cardId === cardCode)
    if (idx === -1) return
    gameClient.choose({ stackIndex: idx })
    setSelectedCard(null)
  }, [myPlayerId])

  const handleCardHover = useCallback((cardId, point) => {
    setHoveredCard(cardId ? { cardId, point } : null)
  }, [])

  const handlePlay = useCallback(() => {
    if (!selectedCard) return
    gameClient.playCard(selectedCard)
    setSelectedCard(null)
  }, [selectedCard])

  const handleVoid = useCallback(() => {
    if (!selectedCard) return
    gameClient.voidCard(selectedCard)
    setSelectedCard(null)
  }, [selectedCard])

  const handlePass = useCallback(() => gameClient.passPriority(), [])
  const handleConcede = useCallback(() => {
    if (window.confirm('Concede this game?')) gameClient.concede()
  }, [])

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

  if (screen === 'lobby') return <Lobby onConnect={connect} />
  if (screen === 'waiting') return <WaitingScreen roomId={roomId} />

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <Tldraw
          shapeUtils={CUSTOM_SHAPE_UTILS}
          hideUi
          components={{ Background: DarkBackground }}
        >
          <GameCanvas
            gameState={gameState}
            myPlayerId={myPlayerId}
            selectedCard={selectedCard}
            onCardClick={handleCardClick}
            onStackCardClick={handleStackCardClick}
            onCardHover={handleCardHover}
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
        />
      )}

      {screen === 'game' && (
        <ActionBar
          selectedCard={selectedCard}
          holdingPriority={holdingPriority}
          myChoicePending={myChoicePending}
          onPlay={handlePlay}
          onVoid={handleVoid}
          onPass={handlePass}
          onConcede={handleConcede}
        />
      )}

      {myChoicePending && pendingChoice && (
        <ChoicePrompt
          choice={pendingChoice}
          myHand={myState?.hand ?? []}
          stackCards={gameState?.zones?.stack ?? []}
          trashCards={gameState?.zones?.trash ?? []}
          onRespond={(payload) => { gameClient.choose(payload); setSelectedCard(null) }}
        />
      )}

      {hoveredCard && (
        <CardTooltip cardId={hoveredCard.cardId} point={hoveredCard.point} />
      )}

      {screen === 'ended' && gameState && (
        <GameOver
          winner={gameState.winner}
          myPlayerId={myPlayerId}
          myPoints={myState?.points ?? 0}
          oppPoints={oppState?.points ?? 0}
          onPlayAgain={() => {
            gameClient.disconnect()
            setScreen('lobby')
            setGameState(null)
            setMyPlayerId(null)
            setSelectedCard(null)
          }}
        />
      )}

      <div style={{
        position: 'absolute', top: 76, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', flexDirection: 'column', gap: 6, zIndex: 400, pointerEvents: 'none'
      }}>
        {toasts.map(t => <Toast key={t.id} msg={t.msg} type={t.type} />)}
      </div>
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
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: '100%', height: '100%',
      background: 'radial-gradient(ellipse at 50% 50%, #0e0e1f 0%, #07070f 100%)'
    }}>
      <div style={{
        textAlign: 'center', color: '#fff', display: 'flex',
        flexDirection: 'column', alignItems: 'center', gap: 18
      }}>
        <div style={{
          width: 40, height: 40, border: '3px solid rgba(255,255,255,0.1)',
          borderTop: '3px solid #7c6aff', borderRadius: '50%',
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
            borderRadius: 6, color: '#7c6aff', userSelect: 'all', cursor: 'pointer',
            maxWidth: 420, wordBreak: 'break-all'
          }}>
          {shareUrl}
        </code>
        <p style={{ fontSize: 11, opacity: 0.3 }}>Click the link to copy</p>
      </div>
    </div>
  )
}
