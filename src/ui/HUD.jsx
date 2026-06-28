import { useEffect, useState, useRef } from 'react'

function PointPips({ points, max = 5 }) {
  return (
    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
      {Array.from({ length: max }).map((_, i) => (
        <div key={i} style={{
          width: 10, height: 10, borderRadius: '50%',
          background: i < points ? '#7c6aff' : 'rgba(255,255,255,0.12)',
          boxShadow: i < points ? '0 0 6px rgba(124,106,255,0.7)' : 'none',
          transition: 'all 0.25s',
        }} />
      ))}
    </div>
  )
}

/** Client-side countdown. Resets whenever serverSeconds changes. */
function Timer({ serverSeconds, active }) {
  const [displayed, setDisplayed] = useState(serverSeconds ?? 1500)
  const intervalRef = useRef(null)
  const lastServerRef = useRef(serverSeconds)

  useEffect(() => {
    // Snap to server value whenever it changes by >2s (server sync)
    if (Math.abs((serverSeconds ?? 0) - lastServerRef.current) > 2) {
      setDisplayed(serverSeconds ?? 1500)
    }
    lastServerRef.current = serverSeconds ?? 1500
  }, [serverSeconds])

  useEffect(() => {
    if (active) {
      intervalRef.current = setInterval(() => {
        setDisplayed(prev => Math.max(0, prev - 1))
      }, 1000)
    } else {
      clearInterval(intervalRef.current)
    }
    return () => clearInterval(intervalRef.current)
  }, [active])

  const mins = Math.floor(displayed / 60)
  const secs = displayed % 60
  const low  = displayed < 120

  return (
    <span style={{
      fontVariantNumeric: 'tabular-nums',
      fontSize: 13, fontWeight: 600,
      color: low ? '#ff6b6b' : 'rgba(255,255,255,0.55)',
      background: active ? 'rgba(124,106,255,0.15)' : 'transparent',
      padding: '2px 8px', borderRadius: 5,
      transition: 'color 0.3s, background 0.3s',
    }}>
      {mins}:{String(secs).padStart(2, '0')}
    </span>
  )
}

function PlayerPanel({ label, state, holdingPriority, isMyTurn, align = 'left' }) {
  const isRight = align === 'right'
  const handCount = state?.handSize ?? state?.hand?.length ?? 0

  return (
    <div style={{
      display: 'flex',
      flexDirection: isRight ? 'row-reverse' : 'row',
      alignItems: 'center',
      gap: 14,
      padding: '10px 18px',
      background: holdingPriority ? 'rgba(124,106,255,0.12)' : 'rgba(255,255,255,0.04)',
      borderRadius: 10,
      border: `1px solid ${holdingPriority ? 'rgba(124,106,255,0.4)' : 'rgba(255,255,255,0.06)'}`,
      transition: 'all 0.25s',
      minWidth: 290,
    }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 1,
                    alignItems: isRight ? 'flex-end' : 'flex-start' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7,
                      flexDirection: isRight ? 'row-reverse' : 'row' }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.1em',
                         textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)' }}>
            {label}
          </span>
          {holdingPriority && (
            <span style={{ fontSize: 10, background: '#7c6aff', color: '#fff',
                           padding: '1px 6px', borderRadius: 3, fontWeight: 700,
                           animation: 'priorityPulse 1.5s ease-in-out infinite' }}>
              PRIORITY
            </span>
          )}
        </div>
        <PointPips points={state?.points ?? 0} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Stat value={state?.energy ?? 0} label="energy" color="#4fc3f7" />
        <Stat value={handCount}           label="hand"   color="rgba(255,255,255,0.7)" />
        <Timer serverSeconds={state?.timerSeconds} active={holdingPriority} />
      </div>
    </div>
  )
}

function Stat({ value, label, color }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', textTransform: 'uppercase',
                    letterSpacing: '0.06em' }}>{label}</div>
    </div>
  )
}

export function HUD({ myState, oppState, isMyTurn, holdingPriority, turnNumber }) {
  return (
    <>
      <style>{`
        @keyframes priorityPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
      {/* Opponent — top center */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        display: 'flex', justifyContent: 'center',
        padding: '12px 16px',
        pointerEvents: 'none', zIndex: 100,
      }}>
        <PlayerPanel label="Opponent" state={oppState} holdingPriority={!holdingPriority} isMyTurn={!isMyTurn} align="left" />
      </div>

      {/* Turn indicator — top right corner */}
      <div style={{
        position: 'absolute', top: 12, right: 16,
        textAlign: 'center', color: 'rgba(255,255,255,0.25)', fontSize: 12,
        pointerEvents: 'none', zIndex: 100,
      }}>
        <div style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>Turn</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: 'rgba(255,255,255,0.55)', lineHeight: 1.1 }}>
          {turnNumber ?? 1}
        </div>
        <div style={{ fontSize: 10, marginTop: 3, opacity: 0.4 }}>SPACE to pass</div>
      </div>

      {/* You — bottom center, above the action bar */}
      <div style={{
        position: 'absolute', bottom: 88, left: 0, right: 0,
        display: 'flex', justifyContent: 'center',
        padding: '0 16px',
        pointerEvents: 'none', zIndex: 100,
      }}>
        <PlayerPanel label="You" state={myState} holdingPriority={holdingPriority} isMyTurn={isMyTurn} align="left" />
      </div>
    </>
  )
}
