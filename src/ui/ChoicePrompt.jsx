import { useState } from 'react'

const CARD_IMG_SIZE = { w: 90, h: 126 }

function MiniCard({ cardId, selected, targeted, onClick, label }) {
  return (
    <div
      onClick={onClick}
      style={{
        width: CARD_IMG_SIZE.w,
        height: CARD_IMG_SIZE.h,
        borderRadius: 6,
        border: selected
          ? '2px solid #7c6aff'
          : targeted
            ? '2px solid #00e5ff'
            : '1px solid rgba(255,255,255,0.12)',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        flexShrink: 0,
        boxShadow: selected ? '0 0 12px rgba(124,106,255,0.5)' : 'none',
        transition: 'all 0.15s',
        background: '#1a1a2e',
        position: 'relative',
      }}
    >
      {cardId ? (
        <img
          src={`/cards/${cardId}.png`}
          alt={cardId}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          draggable={false}
        />
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex',
                      alignItems: 'center', justifyContent: 'center',
                      color: 'rgba(255,255,255,0.2)', fontSize: 20 }}>✦</div>
      )}
      {label && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: 'rgba(0,0,0,0.7)', fontSize: 9, color: '#fff',
          textAlign: 'center', padding: '2px 0', letterSpacing: '0.04em',
        }}>
          {label}
        </div>
      )}
    </div>
  )
}

export function ChoicePrompt({ choice, myHand, stackCards, trashCards, onRespond }) {
  const [selected, setSelected] = useState([])

  const toggle = (id) => {
    const count = choice.count ?? 1
    if (count === 1) {
      setSelected([id])
    } else {
      setSelected(prev =>
        prev.includes(id)
          ? prev.filter(x => x !== id)
          : prev.length < count
            ? [...prev, id]
            : prev
      )
    }
  }

  const confirm = () => {
    if (selected.length === 0) return
    const { type } = choice

    if (type === 'trashFromHand') {
      onRespond({ cardIds: selected })
    } else if (type === 'putFromTrashToHand') {
      onRespond({ cardIds: selected })
    } else if (['trashFromStack', 'returnToControllerHand', 'stealFromStack', 'gainControl'].includes(type)) {
      onRespond({ stackIndex: parseInt(selected[0]) })
    } else if (type === 'optional') {
      onRespond({ accept: true })
    }
    setSelected([])
  }

  const decline = () => {
    if (choice.type === 'optional') {
      onRespond({ accept: false })
    }
    setSelected([])
  }

  const { type, count, filter } = choice

  // ── Render by choice type ──────────────────────────────────────────────────

  let title = 'Make a choice'
  let subtitle = ''
  let cards = []
  let isOptional = false
  let confirmLabel = 'Confirm'
  let canConfirm = selected.length > 0

  if (type === 'trashFromHand') {
    title = `Trash ${count} card${count !== 1 ? 's' : ''} from your hand`
    subtitle = `Select ${count} card${count !== 1 ? 's' : ''} to trash`
    cards = myHand.map(id => ({ id, label: null }))
    canConfirm = selected.length === count
    confirmLabel = 'Trash'
  }

  else if (type === 'putFromTrashToHand') {
    title = `Take ${count ?? 1} card${(count ?? 1) !== 1 ? 's' : ''} from the trash`
    subtitle = 'Choose a card to put into your hand'
    cards = trashCards.map(id => ({ id, label: null }))
    canConfirm = selected.length === (count ?? 1)
  }

  else if (type === 'trashFromStack' || type === 'trashFromStackChoice') {
    const filterLabel = filter === 'any' ? 'card' : `${filter} card`
    title = `Trash a ${filterLabel} from the stack`
    subtitle = 'Select a card to trash'
    cards = stackCards
      .filter(e => filter === 'any' || true) // server enforces type
      .map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Trash'
  }

  else if (type === 'returnToControllerHand') {
    title = 'Return a card from the stack'
    subtitle = 'Choose a card to return to its controller\'s hand'
    cards = stackCards.map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Return'
  }

  else if (type === 'stealFromStack') {
    title = 'Take a point card from the stack'
    subtitle = 'Choose a point card to put into your hand'
    cards = stackCards.map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Take'
  }

  else if (type === 'gainControl') {
    title = 'Gain control of a card on the stack'
    subtitle = 'Choose a card'
    cards = stackCards.map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Take Control'
  }

  else if (type === 'optional') {
    isOptional = true
    title = 'Optional effect'
    subtitle = choice.effects?.[0]?.type ?? 'Do you want to use this effect?'
    confirmLabel = 'Yes'
    canConfirm = true
  }

  else if (type === 'putHandCardOnDeckTop') {
    title = 'Put a card on top of the deck'
    subtitle = 'Choose a card from your hand'
    cards = myHand.map(id => ({ id, label: null }))
    canConfirm = selected.length === 1
    confirmLabel = 'Put on Deck'
  }

  else if (type === 'additionalCost') {
    title = 'Pay additional cost'
    const costType = choice.cost?.type
    if (costType === 'trashFromHand') {
      subtitle = 'Trash a card from your hand to play this card'
      cards = myHand.map(id => ({ id, label: null }))
      canConfirm = selected.length === 1
      confirmLabel = 'Pay & Play'
    } else if (costType === 'putHandCardOnDeckTop') {
      subtitle = 'Put a card on top of the deck to play this card'
      cards = myHand.map(id => ({ id, label: null }))
      canConfirm = selected.length === 1
      confirmLabel = 'Pay & Play'
    }
  }

  return (
    <div style={{
      position: 'absolute',
      bottom: 90,
      left: '50%',
      transform: 'translateX(-50%)',
      background: 'rgba(10,10,22,0.96)',
      backdropFilter: 'blur(16px)',
      border: '1px solid rgba(124,106,255,0.3)',
      borderRadius: 14,
      padding: '18px 22px',
      zIndex: 200,
      maxWidth: 600,
      width: 'calc(100vw - 40px)',
      boxShadow: '0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,106,255,0.1)',
      pointerEvents: 'all',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>{subtitle}</div>
      </div>

      {/* Card grid */}
      {cards.length > 0 && (
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          maxHeight: 300,
          overflowY: 'auto',
          marginBottom: 14,
          paddingBottom: 4,
        }}>
          {cards.map(({ id, label, cardId: cid }) => (
            <MiniCard
              key={id}
              cardId={cid ?? id}
              selected={selected.includes(id)}
              onClick={() => toggle(id)}
              label={label}
            />
          ))}
        </div>
      )}

      {/* Buttons */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {isOptional && (
          <button onClick={decline} style={btnStyle('ghost')}>No</button>
        )}
        <button
          onClick={confirm}
          disabled={!canConfirm}
          style={btnStyle(canConfirm ? 'primary' : 'disabled')}
        >
          {confirmLabel}
          {count && count > 1 && selected.length > 0 && ` (${selected.length}/${count})`}
        </button>
      </div>
    </div>
  )
}

function btnStyle(variant) {
  const base = {
    border: 'none',
    borderRadius: 8,
    padding: '8px 20px',
    fontSize: 13,
    fontWeight: 700,
    cursor: variant === 'disabled' ? 'not-allowed' : 'pointer',
    transition: 'all 0.15s',
    letterSpacing: '0.02em',
  }
  if (variant === 'primary') return { ...base, background: '#7c6aff', color: '#fff' }
  if (variant === 'ghost') return { ...base, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }
  if (variant === 'disabled') return { ...base, background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.2)' }
  return base
}
