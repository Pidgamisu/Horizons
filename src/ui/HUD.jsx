
function ZenithScore({ points }) {
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
      <span style={{
        fontSize: 18, fontWeight: 700, color: '#9aff4d',
        textShadow: '0 0 8px rgba(154,255,77,0.6)', minWidth: 14, textAlign: 'right',
      }}>{points}</span>
      <span style={{ fontSize: 10, letterSpacing: 0.6, color: 'rgba(255,255,255,0.5)' }}>
        {points === 1 ? 'POINT' : 'POINTS'}
      </span>
    </div>
  )
}

function PlayerPanel({ label, state, holdingPriority, isMyTurn, align = 'left', onConcede }) {
  const isRight = align === 'right'
  const handCount = state?.handSize ?? state?.hand?.length ?? 0

  return (
    <div style={{
      display: 'flex',
      flexDirection: isRight ? 'row-reverse' : 'row',
      alignItems: 'center',
      gap: 14,
      padding: '10px 18px',
      background: holdingPriority ? 'rgba(255,0,153,0.12)' : 'rgba(255,255,255,0.04)',
      borderRadius: 10,
      border: `1px solid ${holdingPriority ? 'rgba(255,0,153,0.4)' : 'rgba(255,255,255,0.06)'}`,
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
            <span style={{ fontSize: 10, background: '#ff0099', color: '#fff',
                           padding: '1px 6px', borderRadius: 3, fontWeight: 700,
                           animation: 'priorityPulse 1.5s ease-in-out infinite' }}>
              PRIORITY
            </span>
          )}
        </div>
        <ZenithScore points={state?.zenith?.length ?? state?.points ?? 0} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <Stat value={state?.energy ?? 0} label="energy" color="#4fc3f7" />
        <Stat value={handCount}           label="hand"   color="rgba(255,255,255,0.7)" />
      </div>

      {onConcede && (
        <button
          onClick={onConcede}
          title="Concede this game"
          style={{
            pointerEvents: 'all',
            marginLeft: 4,
            background: 'transparent',
            color: 'rgba(255,100,100,0.55)',
            border: '1px solid rgba(255,100,100,0.25)',
            borderRadius: 7, padding: '6px 10px',
            fontSize: 11, fontWeight: 700, cursor: 'pointer',
            letterSpacing: '0.04em', whiteSpace: 'nowrap',
          }}
        >
          Concede
        </button>
      )}
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

export function HUD({ myState, oppState, isMyTurn, holdingPriority, turnNumber, onConcede }) {
  return (
    <>
      <style>{`
        @keyframes priorityPulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>
      {/* Opponent — top left */}
      <div style={{
        position: 'absolute', top: 14, left: 16,
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

      {/* You — bottom left, beside the action bar */}
      <div style={{
        position: 'absolute', bottom: 20, left: 16,
        pointerEvents: 'none', zIndex: 100,
      }}>
        <PlayerPanel label="You" state={myState} holdingPriority={holdingPriority} isMyTurn={isMyTurn} align="left" onConcede={onConcede} />
      </div>
    </>
  )
}
