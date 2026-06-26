import { BaseBoxShapeUtil } from 'tldraw'
import { cardImageSrc } from '../data/cardImages.js'

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
      w: CW,
      h: CH,
    }
  }

  component(shape) {
    const { cardId, faceUp, selected, targeted, dimmed, zone, stackIndex, stackIsTop, w, h } = shape.props
    const onStack = zone === 'stack'

    const border = targeted ? '2px solid #00e5ff'
      : selected ? '2px solid #fff'
      : '1px solid rgba(255,255,255,0.10)'

    const glow = targeted ? '0 0 14px rgba(0,229,255,0.55)'
      : selected ? '0 0 10px rgba(255,255,255,0.35)'
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
            background: stackIsTop ? '#7c6aff' : 'rgba(0,0,0,0.65)',
            color: stackIsTop ? '#fff' : 'rgba(255,255,255,0.55)',
            fontSize: 9, fontWeight: 800,
            padding: '2px 5px', borderRadius: 4,
            letterSpacing: '0.04em',
            border: stackIsTop ? 'none' : '1px solid rgba(255,255,255,0.12)',
          }}>
            {stackIsTop ? 'TOP' : `#${stackIndex + 1}`}
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

export const CARD_SIZE = { w: CW, h: CH }
