import { useState, useEffect } from 'react'

// The four rule cards (in order). Their own art carries all styling.
const RULE_PAGES = ['/rules/1.png', '/rules/2.png', '/rules/3.png', '/rules/4.png']

/** Full-screen paged viewer for the printed rule cards. */
export function RulesOverlay({ onClose }) {
  const [page, setPage] = useState(0)
  const last = RULE_PAGES.length - 1

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') setPage(p => Math.min(last, p + 1))
      else if (e.key === 'ArrowLeft') setPage(p => Math.max(0, p - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, last])

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(8px)',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 18,
        pointerEvents: 'all',
      }}
    >
      <button onClick={onClose} title="Close (Esc)" style={closeBtnStyle}>✕</button>

      <div onClick={e => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <NavButton glyph="‹" disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))} />
        <img
          src={RULE_PAGES[page]}
          alt={`Rules ${page + 1} of ${RULE_PAGES.length}`}
          draggable={false}
          style={{
            height: 'min(82vh, 780px)', maxWidth: '86vw', objectFit: 'contain',
            borderRadius: 16, boxShadow: '0 16px 60px rgba(0,0,0,0.65)',
          }}
        />
        <NavButton glyph="›" disabled={page === last} onClick={() => setPage(p => Math.min(last, p + 1))} />
      </div>

      <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 9 }}>
        {RULE_PAGES.map((_, i) => (
          <button
            key={i}
            onClick={() => setPage(i)}
            aria-label={`Go to page ${i + 1}`}
            style={{
              width: 10, height: 10, borderRadius: '50%', border: 'none', padding: 0,
              cursor: 'pointer',
              background: i === page ? '#ff0099' : 'rgba(255,255,255,0.25)',
              boxShadow: i === page ? '0 0 8px rgba(255,0,153,0.7)' : 'none',
              transition: 'all 0.15s',
            }}
          />
        ))}
      </div>
    </div>
  )
}

function NavButton({ glyph, onClick, disabled }) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        width: 46, height: 46, borderRadius: '50%',
        border: '1px solid rgba(255,255,255,0.12)',
        background: disabled ? 'rgba(255,255,255,0.03)' : 'rgba(255,0,153,0.18)',
        color: disabled ? 'rgba(255,255,255,0.2)' : '#fff',
        fontSize: 26, lineHeight: 1, fontWeight: 700,
        cursor: disabled ? 'default' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'all 0.15s',
      }}
    >
      {glyph}
    </button>
  )
}

const closeBtnStyle = {
  position: 'absolute', top: 18, right: 22,
  width: 40, height: 40, borderRadius: '50%',
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.8)',
  fontSize: 18, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
