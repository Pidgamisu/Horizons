import { useState, useEffect } from 'react'

// ── GameOver ──────────────────────────────────────────────────────────────────

export function GameOver({ winner, myPlayerId, myPoints, oppPoints, onPlayAgain }) {
  const iWon = winner === myPlayerId
  return (
    <div style={{
      position: 'absolute', inset: 0,
      background: 'rgba(0,0,0,0.85)',
      backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 300,
    }}>
      <div style={{
        textAlign: 'center',
        color: '#fff',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
      }}>
        <div style={{ fontSize: 64 }}>{iWon ? '🎉' : '💀'}</div>
        <div style={{ fontSize: 36, fontWeight: 800, letterSpacing: '-0.02em',
                      color: iWon ? '#7c6aff' : 'rgba(255,255,255,0.6)' }}>
          {iWon ? 'You Win' : 'You Lose'}
        </div>
        <div style={{ fontSize: 16, color: 'rgba(255,255,255,0.4)' }}>
          {myPoints} – {oppPoints}
        </div>
        <button
          onClick={onPlayAgain}
          style={{
            marginTop: 8,
            background: '#7c6aff', color: '#fff',
            border: 'none', borderRadius: 10,
            padding: '12px 32px', fontSize: 15, fontWeight: 700,
            cursor: 'pointer', letterSpacing: '0.03em',
          }}
        >
          Back to Lobby
        </button>
      </div>
    </div>
  )
}

// ── Lobby ─────────────────────────────────────────────────────────────────────

export function Lobby({ onConnect }) {
  const [roomInput, setRoomInput] = useState('')
  const [mode, setMode] = useState('choose') // 'choose' | 'create' | 'join'

  // Auto-fill room from URL query param
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const roomParam = params.get('room')
    if (roomParam) {
      onConnect(roomParam.toUpperCase())
    }
  }, [])

  const handleCreate = () => {
    const code = Array.from({ length: 6 }, () =>
      'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]
    ).join('')
    onConnect(code)
  }

  const handleJoin = () => {
    if (roomInput.trim().length >= 4) onConnect(roomInput.trim().toUpperCase())
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
      flexDirection: 'column',
      width: '100%', height: '100%',
      paddingBottom: 72,
      backgroundColor: '#07070f',
      // Card back art (carries the HORIZONS wordmark) centered as the backdrop,
      // with a bottom-weighted dark gradient so the buttons stay readable.
      backgroundImage:
        'linear-gradient(to bottom, rgba(7,7,15,0.15) 0%, rgba(7,7,15,0.35) 55%, rgba(7,7,15,0.9) 100%), url(/cards/back.png)',
      backgroundSize: 'cover, cover',
      backgroundPosition: 'center, center',
      backgroundRepeat: 'no-repeat, no-repeat',
    }}>
      <div style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        gap: 12, maxWidth: 380, width: '100%', padding: '0 24px',
      }}>
        {mode === 'choose' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
            <LobbyButton onClick={handleCreate} primary>
              Create Game
            </LobbyButton>
            <LobbyButton onClick={() => setMode('join')}>
              Join Game
            </LobbyButton>
          </div>
        )}

        {mode === 'join' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', textAlign: 'center' }}>
              Enter room code
            </div>
            <input
              autoFocus
              value={roomInput}
              onChange={e => setRoomInput(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoin()}
              maxLength={8}
              placeholder="XXXXXX"
              style={{
                background: 'rgba(255,255,255,0.06)',
                border: '1px solid rgba(255,255,255,0.12)',
                borderRadius: 10, color: '#fff',
                fontSize: 24, fontWeight: 700,
                textAlign: 'center', letterSpacing: '0.15em',
                padding: '14px', outline: 'none', width: '100%',
              }}
            />
            <LobbyButton onClick={handleJoin} primary disabled={roomInput.length < 4}>
              Join
            </LobbyButton>
            <LobbyButton onClick={() => setMode('choose')}>
              ← Back
            </LobbyButton>
          </div>
        )}
      </div>
    </div>
  )
}

function LobbyButton({ children, onClick, primary, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      style={{
        width: '100%',
        background: disabled ? 'rgba(255,255,255,0.03)'
          : primary ? '#7c6aff'
          : 'rgba(255,255,255,0.07)',
        color: disabled ? 'rgba(255,255,255,0.2)' : '#fff',
        border: `1px solid ${primary ? 'transparent' : 'rgba(255,255,255,0.1)'}`,
        borderRadius: 10,
        padding: '14px',
        fontSize: 15, fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        letterSpacing: '0.03em',
        transition: 'all 0.15s',
      }}
    >
      {children}
    </button>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────────────

export function Toast({ msg, type = 'info' }) {
  const [visible, setVisible] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 2700)
    return () => clearTimeout(t)
  }, [])

  const bg = {
    info:    'rgba(124,106,255,0.9)',
    error:   'rgba(220,53,69,0.9)',
    warning: 'rgba(255,152,0,0.9)',
  }[type] ?? 'rgba(124,106,255,0.9)'

  return (
    <div style={{
      position: 'absolute',
      top: 80, left: '50%',
      transform: `translateX(-50%) translateY(${visible ? 0 : -10}px)`,
      opacity: visible ? 1 : 0,
      transition: 'all 0.3s',
      background: bg,
      color: '#fff',
      padding: '9px 18px',
      borderRadius: 8,
      fontSize: 13, fontWeight: 600,
      zIndex: 400,
      pointerEvents: 'none',
      whiteSpace: 'nowrap',
      boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
    }}>
      {msg}
    </div>
  )
}
