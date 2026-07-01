import { BaseBoxShapeUtil } from 'tldraw'

// Card metrics — kept in sync with CardShapeUtil so zone slots read as cards.
const CW = 120
const CH = 168
const BACK_SRC = '/cards/back.png'

export class ZoneShapeUtil extends BaseBoxShapeUtil {
  static type = 'horizons-zone'

  getDefaultProps() {
    return {
      label: '',
      zoneType: 'hand',
      count: null,
      highlight: false,
      w: 160,
      h: 60,
    }
  }

  component(shape) {
    const { label, zoneType, count, w, h } = shape.props

    // Single-card piles render as card-shaped slots; the deck is a stack of
    // card backs. Everything matches the card look (rounded 8px, card aspect).
    if (zoneType === 'deck' || zoneType === 'trash' || zoneType === 'void') {
      return <PileSlot kind={zoneType} label={label} count={count} w={w} h={h} />
    }

    // Large container zones (hands, horizon) — a clean framed area with a label.
    // Aurora palette: your side pink, opponent aurora-green, the horizon pink.
    const frame = {
      'hand':          { border: 'rgba(255,0,153,0.30)',  fill: 'rgba(255,0,153,0.045)' },
      'opponent-hand': { border: 'rgba(77,255,176,0.26)', fill: 'rgba(77,255,176,0.035)' },
      'horizon':         { border: 'rgba(255,0,153,0.34)',  fill: 'rgba(255,0,153,0.05)' },
    }[zoneType] || { border: 'rgba(255,255,255,0.10)', fill: 'rgba(255,255,255,0.02)' }

    return (
      <div style={{
        width: w,
        height: h,
        borderRadius: 14,
        border: `1px solid ${frame.border}`,
        background: frame.fill,
        padding: '6px 12px',
        pointerEvents: 'none',
      }}>
        <span style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.35)',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
        }}>
          {label}
        </span>
      </div>
    )
  }

  getIndicatorPath() { return undefined }
  indicator() { return null }
  canResize() { return false }
  canRotate() { return false }
  canEdit() { return false }
  canBind() { return false }
  canSelect() { return false }
}

// A card-sized slot, centered in the zone box. For the deck it shows a stack of
// card backs (offset layers behind the top card); for trash/void it's an empty
// card outline with the zone label. A count badge overlays the bottom.
function PileSlot({ kind, label, count, w, h }) {
  const isDeck = kind === 'deck'
  const n = count ?? 0
  const hasCards = n > 0
  const depth = isDeck ? Math.min(3, Math.max(0, n - 1)) : 0

  const tint = {
    deck:  'rgba(255,0,153,0.05)',
    trash: 'rgba(255,77,120,0.07)',
    void:  'rgba(177,77,255,0.07)',
  }[kind] || 'rgba(255,255,255,0.04)'

  const stroke = {
    deck:  'rgba(255,0,153,0.30)',
    trash: 'rgba(255,77,120,0.32)',
    void:  'rgba(177,77,255,0.34)',
  }[kind] || 'rgba(255,255,255,0.14)'

  return (
    <div style={{
      position: 'relative', width: w, height: h,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{ position: 'relative', width: CW, height: CH }}>
        {/* Depth layers behind the top card (deck only) for a "stack" look. */}
        {Array.from({ length: depth }).map((_, i) => {
          const o = depth - i // furthest layer first
          return (
            <div key={i} style={{
              position: 'absolute', inset: 0,
              transform: `translate(${o * 2.5}px, ${o * 2.5}px)`,
              borderRadius: 8,
              background: '#0c0c1c',
              border: '1px solid rgba(255,255,255,0.08)',
              boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
            }} />
          )
        })}

        {/* Top of the pile. */}
        <div style={{
          position: 'absolute', inset: 0,
          borderRadius: 8, overflow: 'hidden',
          border: `1px solid ${stroke}`,
          background: tint,
          boxShadow: hasCards ? '0 4px 14px rgba(0,0,0,0.5)' : 'none',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {isDeck && hasCards ? (
            <img
              src={BACK_SRC}
              alt="deck"
              draggable={false}
              style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          ) : (
            <span style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.3)',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
            }}>
              {label}
            </span>
          )}
        </div>
      </div>

      {/* Count badge. */}
      {count !== null && (
        <div style={{
          position: 'absolute',
          bottom: (h - CH) / 2 + 6,
          left: '50%', transform: 'translateX(-50%)',
          fontSize: 12, fontWeight: 800, color: '#fff',
          background: 'rgba(0,0,0,0.72)',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: 10, padding: '2px 9px',
          letterSpacing: '0.04em',
        }}>
          {count}
        </div>
      )}
    </div>
  )
}
