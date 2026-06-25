import { BaseBoxShapeUtil } from 'tldraw'

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

    const zoneColors = {
      'hand':          'rgba(255,255,255,0.04)',
      'opponent-hand': 'rgba(255,255,255,0.04)',
      'stack':         'rgba(0,150,255,0.08)',
      'trash':         'rgba(255,100,100,0.08)',
      'void':          'rgba(150,0,255,0.08)',
      'deck':          'rgba(255,255,255,0.06)',
    }

    const borderColors = {
      'hand':          'rgba(255,255,255,0.12)',
      'opponent-hand': 'rgba(255,255,255,0.08)',
      'stack':         'rgba(0,150,255,0.3)',
      'trash':         'rgba(255,100,100,0.25)',
      'void':          'rgba(150,0,255,0.25)',
      'deck':          'rgba(255,255,255,0.15)',
    }

    return (
      <div style={{
        width: w,
        height: h,
        borderRadius: 10,
        border: `1px dashed ${borderColors[zoneType] || 'rgba(255,255,255,0.1)'}`,
        background: zoneColors[zoneType] || 'transparent',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        pointerEvents: 'none',
      }}>
        <span style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.4)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}>
          {label}
        </span>
        {count !== null && (
          <span style={{
            fontSize: 12, fontWeight: 700,
            color: 'rgba(255,255,255,0.7)',
            background: 'rgba(255,255,255,0.1)',
            borderRadius: 10, padding: '1px 7px',
          }}>
            {count}
          </span>
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
  canSelect() { return false }
}
