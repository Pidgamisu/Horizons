export function ActionBar({
  selectedCard,
  holdingPriority,
  myChoicePending,
  onPlay,
  onVoid,
  onPass,
  onConcede,
}) {
  const canAct = holdingPriority && !myChoicePending

  return (
    <div style={{
      position: 'absolute',
      bottom: 20,
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 16px',
      background: 'rgba(10,10,20,0.85)',
      backdropFilter: 'blur(12px)',
      borderRadius: 14,
      border: '1px solid rgba(255,255,255,0.08)',
      zIndex: 100,
      pointerEvents: 'all',
    }}>

      {/* Play button — only when a card is selected and priority held */}
      <ActionButton
        label="Play"
        shortcut="P"
        onClick={onPlay}
        disabled={!selectedCard || !canAct}
        variant="primary"
      />

      {/* Void button — only when a card is selected and priority held */}
      <ActionButton
        label="Void"
        shortcut="V"
        onClick={onVoid}
        disabled={!selectedCard || !canAct}
        variant="secondary"
        tooltip="+3 energy"
      />

      {/* Divider */}
      <div style={{ width: 1, height: 32, background: 'rgba(255,255,255,0.1)' }} />

      {/* Pass priority — always available when holding priority and no choice pending */}
      <ActionButton
        label="Pass"
        shortcut="Space"
        onClick={onPass}
        disabled={!canAct}
        variant={canAct ? 'pass' : 'ghost'}
      />

      {/* Divider */}
      <div style={{ width: 1, height: 32, background: 'rgba(255,255,255,0.1)' }} />

      {/* Concede */}
      <ActionButton
        label="Concede"
        onClick={onConcede}
        disabled={false}
        variant="danger"
      />

      {/* Status indicator */}
      {myChoicePending && (
        <div style={{
          position: 'absolute',
          top: -30, left: '50%',
          transform: 'translateX(-50%)',
          background: '#ff9800',
          color: '#000',
          fontSize: 11,
          fontWeight: 700,
          padding: '3px 10px',
          borderRadius: 6,
          whiteSpace: 'nowrap',
          letterSpacing: '0.05em',
        }}>
          CHOICE REQUIRED ↓
        </div>
      )}

      {!holdingPriority && !myChoicePending && (
        <div style={{
          position: 'absolute',
          top: -30, left: '50%',
          transform: 'translateX(-50%)',
          color: 'rgba(255,255,255,0.3)',
          fontSize: 11,
          whiteSpace: 'nowrap',
        }}>
          Opponent's priority
        </div>
      )}
    </div>
  )
}

function ActionButton({ label, shortcut, onClick, disabled, variant = 'secondary', tooltip }) {
  const colors = {
    primary:   { bg: '#7c6aff', hover: '#9580ff', text: '#fff' },
    secondary: { bg: 'rgba(255,255,255,0.08)', hover: 'rgba(255,255,255,0.14)', text: 'rgba(255,255,255,0.8)' },
    pass:      { bg: 'rgba(76,175,80,0.2)', hover: 'rgba(76,175,80,0.35)', text: '#81c784' },
    ghost:     { bg: 'transparent', hover: 'rgba(255,255,255,0.05)', text: 'rgba(255,255,255,0.2)' },
    danger:    { bg: 'transparent', hover: 'rgba(244,67,54,0.1)', text: 'rgba(255,100,100,0.5)' },
  }

  const c = colors[variant]

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={disabled ? undefined : onClick}
        title={tooltip}
        style={{
          background: disabled ? 'rgba(255,255,255,0.04)' : c.bg,
          color: disabled ? 'rgba(255,255,255,0.2)' : c.text,
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8,
          padding: '7px 16px',
          fontSize: 13,
          fontWeight: 600,
          cursor: disabled ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          transition: 'all 0.15s',
          whiteSpace: 'nowrap',
          letterSpacing: '0.02em',
        }}
      >
        {label}
        {shortcut && (
          <span style={{
            fontSize: 10,
            opacity: 0.45,
            background: 'rgba(255,255,255,0.08)',
            padding: '1px 5px',
            borderRadius: 3,
          }}>
            {shortcut}
          </span>
        )}
      </button>
    </div>
  )
}
