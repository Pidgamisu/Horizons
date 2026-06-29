import { useState, useEffect } from 'react'
import { OnlineIntro } from './Intro.jsx'

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
                      color: iWon ? '#ff0099' : 'rgba(255,255,255,0.6)' }}>
          {iWon ? 'You Win' : 'You Lose'}
        </div>
        <div style={{ fontSize: 16, color: 'rgba(255,255,255,0.4)' }}>
          {myPoints} – {oppPoints}
        </div>
        <button
          onClick={onPlayAgain}
          style={{
            marginTop: 8,
            background: '#ff0099', color: '#fff',
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

// ── BrandBackdrop ─────────────────────────────────────────────────────────────
// Darkened aurora photo + crisp pink HORIZONS wordmark, shared by the lobby and
// the waiting-for-opponent screen so they look identical. Renders children below.

export function BrandBackdrop({ children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexDirection: 'column', gap: 44,
      width: '100%', height: '100%',
      backgroundColor: '#07070f',
      backgroundImage:
        'linear-gradient(to bottom, rgba(5,5,12,0.6) 0%, rgba(5,5,12,0.5) 45%, rgba(5,5,12,0.78) 100%), url(/lobby-bg.png)',
      backgroundSize: 'cover, cover',
      backgroundPosition: 'center, center',
      backgroundRepeat: 'no-repeat, no-repeat',
    }}>
      {/* HORIZONS wordmark + copyright — crisp layer over the photo */}
      <div style={{ textAlign: 'center' }}>
        <div style={{
          fontSize: 66, fontWeight: 800, letterSpacing: '0.14em',
          color: '#ff0099',
          textShadow: '0 0 32px rgba(255,0,153,0.5), 0 2px 30px rgba(0,0,0,0.5)',
          lineHeight: 1,
        }}>
          HORIZONS
        </div>
        <div style={{
          fontSize: 11, color: 'rgba(255,255,255,0.55)',
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

export function Lobby({ onConnect, onStartTutorial, onShowRules }) {
  const [roomInput, setRoomInput] = useState('')
  const [mode, setMode] = useState('choose') // 'choose' | 'create' | 'join'
  const [showIntro, setShowIntro] = useState(false)

  // Auto-fill room from URL query param; first-time visitors (who aren't
  // joining via a link) get the how-to-play-online walkthrough.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const roomParam = params.get('room')
    if (roomParam) {
      onConnect(roomParam.toUpperCase())
      return
    }
    if (!localStorage.getItem('horizons_intro_seen')) setShowIntro(true)
  }, [])

  const dismissIntro = () => {
    localStorage.setItem('horizons_intro_seen', '1')
    setShowIntro(false)
  }

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
            <LobbyButton onClick={onShowRules}>
              How to Play
            </LobbyButton>
            <button
              onClick={() => setShowIntro(true)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'rgba(255,255,255,0.45)', fontSize: 13, fontWeight: 600,
                marginTop: 2, letterSpacing: '0.02em', textDecoration: 'underline',
                textUnderlineOffset: 3,
              }}
            >
              New here? See how it works
            </button>
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

      {showIntro && (
        <OnlineIntro
          onClose={dismissIntro}
          onCreateGame={() => { dismissIntro(); handleCreate() }}
        />
      )}
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
