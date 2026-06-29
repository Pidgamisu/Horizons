import { useEffect, useState } from 'react'
import { cardImageSrc, cardName } from '../data/cardImages.js'

// Render **bold** spans inside otherwise plain coaching text.
function renderText(text) {
  return text.split(/\*\*(.+?)\*\*/g).map((chunk, i) =>
    i % 2 === 1 ? <strong key={i} style={{ color: '#ff66c4' }}>{chunk}</strong> : chunk
  )
}

/**
 * CoachOverlay — the instructional layer for the scripted tutorial. It listens
 * to the TutorialClient's 'beat' and 'coachNudge' events and renders the current
 * step's guidance, an optional highlighted card, and a Continue/Finish control.
 * The board, HUD and ActionBar render normally underneath from the same client.
 */
export function CoachOverlay({ client, onExit }) {
  const [beat, setBeat] = useState(null)
  const [nudge, setNudge] = useState(null)

  useEffect(() => {
    const onBeat = ({ detail }) => { setBeat(detail); setNudge(null) }
    const onNudge = ({ detail }) => {
      setNudge(detail.message)
      setTimeout(() => setNudge(n => (n === detail.message ? null : n)), 3200)
    }
    client.addEventListener('beat', onBeat)
    client.addEventListener('coachNudge', onNudge)
    return () => {
      client.removeEventListener('beat', onBeat)
      client.removeEventListener('coachNudge', onNudge)
    }
  }, [client])

  if (!beat) return null

  const isDone = beat.mode === 'done'
  const showButton = beat.mode === 'continue' || isDone
  const waiting = beat.mode === 'action'

  return (
    <div style={{
      position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)',
      width: 'min(560px, calc(100vw - 32px))', zIndex: 300, pointerEvents: 'all',
      background: 'rgba(14,14,28,0.94)', backdropFilter: 'blur(12px)',
      border: '1px solid rgba(255,0,153,0.35)', borderRadius: 14,
      boxShadow: '0 16px 50px rgba(0,0,0,0.55)',
      padding: '14px 18px', color: '#fff',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 8,
      }}>
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: '0.14em',
          textTransform: 'uppercase', color: '#ff66c4',
        }}>
          Tutorial · Step {beat.index + 1} / {beat.total}
        </span>
        <button
          onClick={onExit}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'rgba(255,255,255,0.4)', fontSize: 11, fontWeight: 600,
            textDecoration: 'underline', textUnderlineOffset: 2,
          }}
        >
          Exit
        </button>
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        {beat.highlight && (
          <img
            src={cardImageSrc(beat.highlight)}
            alt={cardName(beat.highlight)}
            draggable={false}
            style={{
              width: 64, flexShrink: 0, borderRadius: 7,
              border: '2px solid #ff0099', boxShadow: '0 0 14px rgba(255,0,153,0.5)',
            }}
          />
        )}
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: 'rgba(255,255,255,0.92)' }}>
          {renderText(beat.narration)}
        </p>
      </div>

      {nudge && (
        <div style={{
          marginTop: 10, padding: '7px 11px', borderRadius: 8,
          background: 'rgba(255,152,0,0.16)', border: '1px solid rgba(255,152,0,0.4)',
          color: '#ffcc80', fontSize: 12.5, fontWeight: 600,
        }}>
          {nudge}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
        {showButton && (
          <button
            onClick={isDone ? onExit : () => client.next()}
            style={{
              background: '#ff0099', color: '#fff', border: 'none',
              borderRadius: 9, padding: '9px 20px', fontSize: 14, fontWeight: 700,
              cursor: 'pointer', letterSpacing: '0.02em',
            }}
          >
            {isDone ? 'Finish' : 'Continue'}
          </button>
        )}
        {waiting && (
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', fontStyle: 'italic' }}>
            Your move — follow the instructions above.
          </span>
        )}
        {beat.mode === 'auto' && (
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>…</span>
        )}
      </div>
    </div>
  )
}
