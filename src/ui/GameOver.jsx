import { useState, useEffect } from 'react'

// ── GameOver ──────────────────────────────────────────────────────────────────

// The headline is set live rather than baked into the art, so it reflows on a
// phone instead of being cropped or letterboxed. ZENITH is Rubik Distressed,
// which matches the printed cards. The thin line above it should be CODE, which
// is not on Google Fonts and has no file in the repo — Jura Light stands in for
// it until one is supplied, and swapping it is a one-line change here.
const CODE_STACK = "'Jura', 'Rubik', system-ui, sans-serif"
const DISTRESSED_STACK = "'Rubik Distressed', 'Rubik', system-ui, sans-serif"

export function GameOver({ winner, myPlayerId, myPoints, oppPoints, onPlayAgain }) {
  const isDraw = winner === 'draw'
  const iWon = !isDraw && winner === myPlayerId
  const backdrop = iWon || isDraw ? '/end-bg-rose.png' : '/end-bg-fell.png'
  const lead = isDraw ? 'YOU MET' : iWon ? 'YOU ROSE' : 'YOU FELL'
  // A draw meets the zenith rather than moving to it.
  const link = isDraw ? 'AT THE' : 'TO THE'

  return (
    <div style={{
      position: 'absolute', inset: 0, zIndex: 300,
      backgroundImage: `url(${backdrop})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '24px 16px',
    }}>
      <div style={{
          fontFamily: CODE_STACK, fontWeight: 300,
          fontSize: 'clamp(24px, 6.5vw, 58px)',
          letterSpacing: '0.16em', lineHeight: 1.22,
          color: '#ffcf8a',
          textShadow: '0 0 18px rgba(255,176,90,0.55)',
          textAlign: 'center',
        }}>
        <div>{lead}</div>
        <div>{link}</div>
      </div>

      <div style={{
        fontFamily: DISTRESSED_STACK, fontWeight: 400,
        fontSize: 'clamp(56px, 17vw, 140px)',
        letterSpacing: '0.02em', lineHeight: 1.05,
        color: '#d2f56d',
        textShadow: '0 0 28px rgba(190,255,90,0.75), 0 0 70px rgba(150,255,60,0.35)',
        marginTop: 6,
        textAlign: 'center',
      }}>
        ZENITH
      </div>

      <div style={{
        marginTop: 26, textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
      }}>
        <div style={{
          fontSize: 16, color: 'rgba(255,255,255,0.75)',
          textShadow: '0 1px 10px rgba(0,0,0,0.6)',
        }}>
          {myPoints} – {oppPoints} in the zenith
        </div>
        <button
          onClick={onPlayAgain}
          style={{
            background: '#ff0099', color: '#fff',
            border: 'none', borderRadius: 10,
            padding: '12px 32px', fontSize: 15, fontWeight: 700,
            cursor: 'pointer', letterSpacing: '0.03em',
            boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
          }}
        >
          Back to Lobby
        </button>
      </div>
    </div>
  )
}

// ── BrandBackdrop ─────────────────────────────────────────────────────────────
// Aurora backdrop + the HORIZONS wordmark, shared by the lobby and the
// waiting-for-opponent screen so they look identical. Renders children below.

export function BrandBackdrop({ children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 44,
      width: '100%', height: '100%',
      backgroundColor: '#07070f',
      // A light scrim only: the artwork is already dark, and a heavy one flattens
      // the aurora. Just enough to keep the controls legible.
      backgroundImage:
        'linear-gradient(to bottom, rgba(5,5,12,0.15) 0%, rgba(5,5,12,0.1) 45%, rgba(5,5,12,0.5) 100%), url(/lobby-bg.png)',
      backgroundSize: 'cover, cover',
      backgroundPosition: 'center, center',
      backgroundRepeat: 'no-repeat, no-repeat',
    }}>
      {/* HORIZONS wordmark + copyright — crisp layer over the photo */}
      <div style={{ textAlign: 'center', width: '100%', padding: '0 12px' }}>
        <div style={{
          // Rubik Spray Paint is a single-weight display face, so the weight and
          // tight tracking of the old wordmark would fight it.
          fontFamily: "'Rubik Spray Paint', 'Rubik', system-ui, sans-serif",
          // Fluid, because a fixed 82px renders "HORIZONS" 475px wide and a
          // phone is 375: it ran off both edges, losing the H and the S.
          fontSize: 'clamp(32px, 15vw, 82px)',
          fontWeight: 400, letterSpacing: '0.04em',
          whiteSpace: 'nowrap',
          color: '#ffd6f5',
          textShadow: '0 0 26px rgba(255,0,153,0.85), 0 0 60px rgba(255,0,153,0.45), 0 2px 30px rgba(0,0,0,0.5)',
          lineHeight: 1.15,
        }}>
          HORIZONS
        </div>
        <div style={{
          fontSize: 11, color: 'rgba(255,255,255,0.62)',
          marginTop: 10, letterSpacing: '0.05em',
        }}>
          © 2026 Nathaniel Robert Lefcourt
        </div>
      </div>
      {children}
    </div>
  )
}

// ── Lobby ─────────────────────────────────────────────────────────────────────

export function Lobby({ onConnect, onStartTutorial }) {
  const [roomInput, setRoomInput] = useState('')
  const [mode, setMode] = useState('choose') // 'choose' | 'create' | 'join'

  // Auto-fill room from URL query param; first-time visitors (who aren't
  // joining via a link) are dropped straight into the interactive tutorial.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const roomParam = params.get('room')
    if (roomParam) {
      onConnect(roomParam.toUpperCase())
      return
    }
    if (onStartTutorial && !localStorage.getItem('horizons_tutorial_seen')) {
      localStorage.setItem('horizons_tutorial_seen', '1')
      onStartTutorial()
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
    <BrandBackdrop>
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
            {onStartTutorial && (
              <LobbyButton onClick={onStartTutorial}>
                Tutorial
              </LobbyButton>
            )}
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
    </BrandBackdrop>
  )
}

function LobbyButton({ children, onClick, primary, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      style={{
        width: '100%',
        background: disabled ? 'rgba(255,255,255,0.03)'
          : primary ? '#ff0099'
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
    info:    'rgba(255,0,153,0.9)',
    error:   'rgba(220,53,69,0.9)',
    warning: 'rgba(255,152,0,0.9)',
  }[type] ?? 'rgba(255,0,153,0.9)'

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
