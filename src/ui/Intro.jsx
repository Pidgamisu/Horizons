import { useState, useEffect } from 'react'

const PINK = '#ff0099'

// Walkthrough of how to play Horizons online with a friend.
const STEPS = [
  {
    icon: '🌌',
    title: 'Welcome to Horizons',
    body: 'A real-time, two-player card game. Play cards to score points — or stop your opponent from scoring. First to 5 points wins.',
  },
  {
    icon: '🎮',
    title: 'Start a game',
    body: 'Tap "Create Game". Horizons opens a private room just for you and gives you a room code plus a shareable link.',
  },
  {
    icon: '🔗',
    title: 'Invite a friend',
    body: 'Send them the link (or read out the room code). They open it in their own browser and join your room — no sign-up, no install.',
  },
  {
    icon: '⚔️',
    title: 'Play together',
    body: 'The match starts the moment you\'re both in. Tap a card to select it, then hit Play or Void right on the card. Press Space to pass, hold a card to zoom in, and tap "?" any time for the full rules.',
  },
]

export function OnlineIntro({ onClose, onCreateGame }) {
  const [step, setStep] = useState(0)
  const last = STEPS.length - 1
  const s = STEPS[step]

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') setStep(p => Math.min(last, p + 1))
      else if (e.key === 'ArrowLeft') setStep(p => Math.max(0, p - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, last])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 600,
        background: 'rgba(5,5,12,0.78)', backdropFilter: 'blur(10px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '100%', maxWidth: 440,
          background: 'rgba(18,18,34,0.92)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 18,
          padding: '34px 30px 26px',
          boxShadow: '0 24px 70px rgba(0,0,0,0.6)',
          textAlign: 'center',
        }}
      >
        <button onClick={onClose} title="Skip (Esc)" style={skipBtnStyle}>Skip</button>

        <div style={{ fontSize: 46, lineHeight: 1, marginBottom: 14 }}>{s.icon}</div>

        <div style={{
          fontSize: 13, fontWeight: 700, letterSpacing: '0.12em',
          textTransform: 'uppercase', color: PINK, marginBottom: 10,
        }}>
          Step {step + 1} of {STEPS.length}
        </div>

        <h2 style={{
          fontSize: 26, fontWeight: 800, color: '#fff',
          letterSpacing: '-0.01em', margin: '0 0 12px',
        }}>
          {s.title}
        </h2>

        <p style={{
          fontSize: 15, lineHeight: 1.6, color: 'rgba(255,255,255,0.75)',
          margin: '0 0 24px', minHeight: 96,
        }}>
          {s.body}
        </p>

        {/* Step dots */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 22 }}>
          {STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              aria-label={`Go to step ${i + 1}`}
              style={{
                width: 9, height: 9, borderRadius: '50%', border: 'none', padding: 0, cursor: 'pointer',
                background: i === step ? PINK : 'rgba(255,255,255,0.22)',
                boxShadow: i === step ? `0 0 8px ${PINK}aa` : 'none',
                transition: 'all 0.15s',
              }}
            />
          ))}
        </div>

        {/* Nav */}
        <div style={{ display: 'flex', gap: 10 }}>
          {step > 0 && (
            <IntroButton onClick={() => setStep(p => p - 1)}>Back</IntroButton>
          )}
          {step < last ? (
            <IntroButton primary onClick={() => setStep(p => p + 1)}>Next</IntroButton>
          ) : (
            <IntroButton primary onClick={onCreateGame}>Create a Game</IntroButton>
          )}
        </div>
      </div>
    </div>
  )
}

function IntroButton({ children, onClick, primary }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        background: primary ? PINK : 'rgba(255,255,255,0.07)',
        color: '#fff',
        border: `1px solid ${primary ? 'transparent' : 'rgba(255,255,255,0.12)'}`,
        borderRadius: 10, padding: '12px',
        fontSize: 15, fontWeight: 700, letterSpacing: '0.03em',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

const skipBtnStyle = {
  position: 'absolute', top: 14, right: 16,
  background: 'transparent', border: 'none',
  color: 'rgba(255,255,255,0.4)', fontSize: 13, fontWeight: 600,
  cursor: 'pointer', letterSpacing: '0.04em',
}
