import { BaseBoxShapeUtil } from 'tldraw'
import { cardImageSrc } from '../data/cardImages.js'
import { gameClient } from '../game/client.js'

const CW = 120
const CH = 168

export class CardShapeUtil extends BaseBoxShapeUtil {
  static type = 'horizons-card'

  getDefaultProps() {
    return {
      cardId: null,
      faceUp: false,
      zone: 'hand',
      owner: null,
      selected: false,
      targeted: false,
      dimmed: false,
      stackIndex: null,
      stackIsTop: false,
      playable: false,
      w: CW,
      h: CH,
    }
  }

  component(shape) {
    const { cardId, faceUp, selected, targeted, dimmed, zone, stackIndex, stackIsTop, playable, w, h } = shape.props
    const onStack = zone === 'stack'
    const showActions = selected && zone === 'hand' && playable && cardId

    const border = targeted ? '2px solid #00e5ff'
      : selected ? '2px solid #ff0099'
      : '1px solid rgba(255,255,255,0.10)'

    const glow = targeted ? '0 0 14px rgba(0,229,255,0.55)'
      : selected ? '0 0 12px rgba(255,0,153,0.6)'
      : onStack ? '0 4px 16px rgba(0,0,0,0.5)'
      : 'none'

    // Clicks are resolved by the editor (see App.jsx via editor.getShapeAtPoint),
    // so the card content is presentational and lets pointer events fall through
    // to tldraw's own input handling.
    return (
      <div
        style={{
        width: w,
        height: h,
        borderRadius: 8,
        border,
        opacity: dimmed ? 0.4 : 1,
        boxShadow: glow,
        overflow: 'hidden',
        background: '#12122a',
        transition: 'box-shadow 0.15s, opacity 0.15s',
        pointerEvents: 'none',
        position: 'relative',
      }}>
        {faceUp && cardId ? (
          <img
            src={cardImageSrc(cardId)}
            alt={cardId}
            style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }}
            draggable={false}
          />
        ) : (
          <img
            src="/cards/back.png"
            alt="card back"
            style={{ width: '100%', height: '100%', display: 'block', objectFit: 'cover' }}
            draggable={false}
          />
        )}

        {onStack && stackIndex !== null && (
          <div style={{
            position: 'absolute', top: 4, right: 4,
            background: stackIsTop ? '#ff0099' : 'rgba(0,0,0,0.65)',
            color: stackIsTop ? '#fff' : 'rgba(255,255,255,0.55)',
            fontSize: 9, fontWeight: 800,
            padding: '2px 5px', borderRadius: 4,
            letterSpacing: '0.04em',
            border: stackIsTop ? 'none' : '1px solid rgba(255,255,255,0.12)',
          }}>
            {stackIsTop ? 'TOP' : `#${stackIndex + 1}`}
          </div>
        )}

        {/* Play / Void actions on the selected hand card. Buttons opt back into
            pointer events (the card itself is pointer-events:none) and stop
            propagation so tldraw's canvas input doesn't swallow the click. */}
        {showActions && (
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: 8,
            background: 'linear-gradient(to top, rgba(7,7,15,0.92) 60%, rgba(7,7,15,0))',
            pointerEvents: 'none',
          }}>
            <CardActionButton label="Play" bg="#ff0099"
              onClick={() => gameClient.playCard(cardId)} />
            <CardActionButton label="Void" sub="+3" bg="rgba(255,255,255,0.16)"
              onClick={() => gameClient.voidCard(cardId)} />
          </div>
        )}
      </div>
    )
  }

getIndicatorPath() { return undefined }
  indicator() { return null }
  canResize() { return false }
  canRotate() { return false }
  canEdit() { return false }
  canBind() { return false }
}

function CardActionButton({ label, sub, bg, onClick }) {
  return (
    <button
      onPointerDown={e => e.stopPropagation()}
      onClick={e => { e.stopPropagation(); onClick() }}
      style={{
        pointerEvents: 'all',
        width: '100%',
        background: bg, color: '#fff',
        border: 'none', borderRadius: 6,
        padding: '6px 0', fontSize: 13, fontWeight: 700,
        letterSpacing: '0.04em', cursor: 'pointer',
      }}
    >
      {label}{sub && <span style={{ opacity: 0.6, fontSize: 10, marginLeft: 5 }}>{sub}</span>}
    </button>
  )
}

export const CARD_SIZE = { w: CW, h: CH }
