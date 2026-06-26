import { cardImageSrc } from '../data/cardImages.js'

const CARD_W = 110
const CARD_H = 154

// Modal overlay that shows every card in a zone (e.g. the trash pile), since
// the canvas only renders the top of the pile. Cards are passed top-first.
export function ZoneViewer({ title, cardIds, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(4px)',
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'all',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'rgba(10,10,22,0.97)',
          border: '1px solid rgba(124,106,255,0.3)',
          borderRadius: 14,
          padding: '18px 22px',
          maxWidth: '82vw',
          maxHeight: '82vh',
          boxShadow: '0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,106,255,0.1)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: '#fff', letterSpacing: '0.02em' }}>
            {title}
            <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 400, marginLeft: 8 }}>
              {cardIds.length} card{cardIds.length !== 1 ? 's' : ''}
            </span>
          </div>
          <button onClick={onClose} style={closeBtnStyle}>✕</button>
        </div>

        {/* Card grid */}
        {cardIds.length === 0 ? (
          <div style={{ color: 'rgba(255,255,255,0.4)', padding: '40px 30px', textAlign: 'center', fontSize: 13 }}>
            Empty
          </div>
        ) : (
          <div style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 10,
            overflowY: 'auto',
            paddingRight: 4,
          }}>
            {cardIds.map((cardId, i) => (
              <div
                key={`${cardId}-${i}`}
                style={{
                  width: CARD_W,
                  height: CARD_H,
                  borderRadius: 8,
                  overflow: 'hidden',
                  border: i === 0 ? '2px solid rgba(124,106,255,0.6)' : '1px solid rgba(255,255,255,0.12)',
                  background: '#1a1a2e',
                  flexShrink: 0,
                  position: 'relative',
                }}
              >
                <img
                  src={cardImageSrc(cardId)}
                  alt={cardId}
                  style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                  draggable={false}
                />
                {i === 0 && (
                  <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0,
                    background: 'rgba(124,106,255,0.85)', fontSize: 9, color: '#fff',
                    textAlign: 'center', padding: '2px 0', letterSpacing: '0.06em', fontWeight: 700,
                  }}>
                    TOP
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const closeBtnStyle = {
  border: 'none',
  borderRadius: 8,
  width: 28,
  height: 28,
  fontSize: 14,
  fontWeight: 700,
  cursor: 'pointer',
  background: 'rgba(255,255,255,0.06)',
  color: 'rgba(255,255,255,0.6)',
  lineHeight: 1,
}
