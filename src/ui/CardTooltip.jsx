import { useEffect, useState } from 'react'

const TOOLTIP_W = 180
const TOOLTIP_H = 252

export function CardTooltip({ cardId, point }) {
  const [visible, setVisible] = useState(false)

  // Small delay before showing — prevents flicker while moving
  useEffect(() => {
    setVisible(false)
    if (!cardId) return
    const t = setTimeout(() => setVisible(true), 120)
    return () => clearTimeout(t)
  }, [cardId])

  if (!cardId || !point || !visible) return null

  // Position tooltip near cursor but keep it on screen
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = point.x + 20
  let y = point.y - TOOLTIP_H / 2

  if (x + TOOLTIP_W > vw - 16) x = point.x - TOOLTIP_W - 20
  if (y < 8) y = 8
  if (y + TOOLTIP_H > vh - 8) y = vh - TOOLTIP_H - 8

  return (
    <div style={{
      position: 'absolute',
      left: x,
      top: y,
      width: TOOLTIP_W,
      height: TOOLTIP_H,
      borderRadius: 10,
      overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.15)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(124,106,255,0.15)',
      zIndex: 350,
      pointerEvents: 'none',
      opacity: visible ? 1 : 0,
      transform: visible ? 'scale(1)' : 'scale(0.92)',
      transition: 'opacity 0.12s, transform 0.12s',
      transformOrigin: point.x > vw / 2 ? 'right center' : 'left center',
    }}>
      <img
        src={`/cards/${cardId}.png`}
        alt={cardId}
        style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }}
        draggable={false}
      />
    </div>
  )
}
