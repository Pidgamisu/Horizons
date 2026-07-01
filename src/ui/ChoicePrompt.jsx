import { useState } from 'react'
import { cardImageSrc, cardName, cardType } from '../data/cardImages.js'

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
          ? '2px solid #ff0099'
          : targeted
            ? '2px solid #00e5ff'
            : '1px solid rgba(255,255,255,0.12)',
        overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        flexShrink: 0,
        boxShadow: selected ? '0 0 12px rgba(255,0,153,0.5)' : 'none',
        transition: 'all 0.15s',
        background: '#1a1a2e',
        position: 'relative',
      }}
    >
      {cardId ? (
        <img
          src={cardImageSrc(cardId)}
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

export function ChoicePrompt({ choice, myHand, horizonCards, trashCards, myEnergy = 0, onRespond }) {
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
    const { type } = choice

    // Binary "pay the ransom" choice — no card selection needed.
    if (type === 'trashUnlessControllerPays') { onRespond({ pay: true }); return }

    if (selected.length === 0) return

    if (type === 'trashFromHand') {
      onRespond({ cardIds: selected })
    } else if (type === 'putFromTrashToHand' || type === 'putFromTrashToDeckBottom') {
      onRespond({ cardIds: selected })
    } else if (['trashFromHorizon', 'returnToControllerHand', 'stealFromHorizon', 'gainControl', 'moveFromHorizonToDeckTop', 'trashUnlessControllerPaysTarget', 'controllerMovesCardFromHorizonTarget'].includes(type)) {
      onRespond({ horizonIndex: parseInt(selected[0]) })
    } else if (type === 'optional') {
      onRespond({ accept: true })
    } else if (type === 'putHandCardOnDeckTop' || type === 'chooseCardToTrashFromRevealedHand' || type === 'opponentChoosesOne') {
      onRespond({ cardId: selected[0] })
    } else if (type === 'lookAtTopN') {
      onRespond({ trashCardId: selected[0] })
    } else if (type === 'mayPlayFromHand') {
      onRespond({ play: true, cardId: selected[0] })
    } else if (type === 'additionalCost') {
      // payload shape depends on the underlying cost type (see resolveChoice)
      if (choice.cost?.type === 'putHandCardOnDeckTop') {
        onRespond({ cardId: selected[0] })
      } else {
        onRespond({ cardIds: selected })
      }
    }
    setSelected([])
  }

  const decline = () => {
    if (choice.type === 'optional') {
      onRespond({ accept: false })
    } else if (choice.type === 'trashUnlessControllerPays') {
      onRespond({ pay: false })
    } else if (choice.type === 'mayPlayFromHand') {
      onRespond({ play: false })
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
  let declineLabel = 'No'
  let canConfirm = selected.length > 0
  let isCardTypeChoice = false
  let isNumberChoice = false
  let isFreePlayChoice = false
  let isDestinationChoice = false

  if (type === 'controllerMovesCardFromHorizonTarget') {
    const filterLabel = filter === 'any' ? 'card' : `${filter} card`
    title = `Choose a ${filterLabel} on the horizon`
    subtitle = 'Its controller will move it to the top or bottom of the deck'
    cards = horizonCards.map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Choose'
  }

  else if (type === 'controllerMovesCardFromHorizon') {
    isDestinationChoice = true
    title = `Move ${cardName(choice.targetCardId)} to the deck`
    subtitle = 'Top or bottom?'
  }

  else if (type === 'chooseNumber') {
    isNumberChoice = true
    title = 'Choose a number'
    subtitle = 'Then the top card is revealed; match its energy cost to play it for 0'
  }

  else if (type === 'confirmFreePlay') {
    isFreePlayChoice = true
    title = `Play ${cardName(choice.cardId)} for 0 energy?`
    subtitle = 'You guessed its cost'
  }

  else if (type === 'mayPlayTopOfDeck') {
    isFreePlayChoice = true
    title = `Play ${cardName(choice.cardId)} from the deck for 0 energy?`
    subtitle = 'Revealed from the top of the deck'
  }

  else if (type === 'mayPlayFromHand') {
    const filterLabel = !filter || filter === 'any' ? 'card' : `${filter} card`
    title = `Play a ${filterLabel} from your hand for 0 energy?`
    subtitle = 'Choose one, or decline'
    cards = myHand
      .filter(id => !filter || filter === 'any' || cardType(id) === filter)
      .map(id => ({ id, label: null }))
    isOptional = true
    declineLabel = "Don't play"
    confirmLabel = 'Play for 0'
    canConfirm = selected.length === 1
  }

  else if (type === 'opponentChoosesOne') {
    title = 'Choose a card to keep'
    subtitle = 'You keep the one you pick; your opponent gets the rest'
    cards = (choice.revealedCards ?? []).map(id => ({ id, label: null }))
    canConfirm = selected.length === 1
    confirmLabel = 'Keep'
  }

  else if (type === 'revealUntilType') {
    isCardTypeChoice = true
    title = 'Choose point or action'
    subtitle = choice.putRest === 'opponentHand'
      ? 'Reveal from the deck until that type; take it, the rest go to your opponent’s hand.'
      : 'Reveal from the deck until that type; take it, the rest go to the bottom of the deck.'
  }

  else if (type === 'trashUnlessControllerPaysTarget') {
    const filterLabel = filter === 'any' ? 'card' : `${filter} card`
    title = `Choose a ${filterLabel} on the horizon`
    subtitle = 'Its controller may pay the ransom to save it'
    cards = horizonCards.map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Target'
  }

  else if (type === 'trashUnlessControllerPays') {
    const ransom = choice.ransom
    const targetName = cardName(choice.targetCardId)
    isOptional = true
    declineLabel = `Let ${targetName} be trashed`
    if (ransom?.type === 'payEnergy') {
      const cost = choice.ransomCost ?? 0
      title = `Pay ${cost} energy to save ${targetName}?`
      subtitle = `Otherwise it is trashed. You have ${myEnergy} energy.`
      confirmLabel = `Pay ${cost}`
      canConfirm = myEnergy >= cost
    } else {
      title = `Save ${targetName} from being trashed?`
      subtitle = 'Pay by putting a card from the trash on the bottom of the deck.'
      confirmLabel = 'Pay'
      canConfirm = true
    }
  }

  else if (type === 'lookAtTopN') {
    title = 'Look at the top cards — trash one'
    subtitle = 'Then draw a card'
    cards = (choice.revealed ?? []).map(id => ({ id, label: null }))
    canConfirm = selected.length === 1
    confirmLabel = 'Trash'
  }

  else if (type === 'chooseCardToTrashFromRevealedHand') {
    const filterLabel = !filter || filter === 'any' ? 'card' : `${filter} card`
    title = `Choose a ${filterLabel} to trash from your opponent’s hand`
    subtitle = 'Their hand is revealed'
    const hand = choice.revealedHand ?? []
    cards = hand
      .filter(id => !filter || filter === 'any' || cardType(id) === filter)
      .map(id => ({ id, label: null }))
    canConfirm = selected.length === 1
    confirmLabel = 'Trash'
  }

  else if (type === 'putFromTrashToDeckBottom') {
    title = `Put ${count ?? 1} card${(count ?? 1) !== 1 ? 's' : ''} from the trash on the bottom of the deck`
    subtitle = 'Choose from the trash to pay the ransom'
    cards = trashCards.map(id => ({ id, label: null }))
    canConfirm = selected.length === (count ?? 1)
    confirmLabel = 'Put on Deck Bottom'
  }

  else if (type === 'trashFromHand') {
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

  else if (type === 'trashFromHorizon' || type === 'trashFromHorizonChoice') {
    const filterLabel = filter === 'any' ? 'card' : `${filter} card`
    title = `Trash a ${filterLabel} from the horizon`
    subtitle = 'Select a card to trash'
    cards = horizonCards
      .filter(e => filter === 'any' || true) // server enforces type
      .map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Trash'
  }

  else if (type === 'returnToControllerHand') {
    title = 'Return a card from the horizon'
    subtitle = 'Choose a card to return to its controller\'s hand'
    cards = horizonCards.map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Return'
  }

  else if (type === 'moveFromHorizonToDeckTop') {
    title = 'Put a card from the horizon on top of the deck'
    subtitle = 'Choose a card on the horizon'
    cards = horizonCards.map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Put on Deck'
  }

  else if (type === 'stealFromHorizon') {
    title = 'Take a point card from the horizon'
    subtitle = 'Choose a point card to put into your hand'
    cards = horizonCards.map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
    canConfirm = selected.length === 1
    confirmLabel = 'Take'
  }

  else if (type === 'gainControl') {
    title = 'Gain control of a card on the horizon'
    subtitle = 'Choose a card'
    cards = horizonCards.map((e, i) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
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
      border: '1px solid rgba(255,0,153,0.3)',
      borderRadius: 14,
      padding: '18px 22px',
      zIndex: 200,
      maxWidth: 600,
      width: 'calc(100vw - 40px)',
      boxShadow: '0 8px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,0,153,0.1)',
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
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {isDestinationChoice ? (
          <>
            <button onClick={() => onRespond({ destination: 'deckTop' })} style={btnStyle('primary')}>Top of Deck</button>
            <button onClick={() => onRespond({ destination: 'deckBottom' })} style={btnStyle('primary')}>Bottom of Deck</button>
          </>
        ) : isNumberChoice ? (
          [0, 1, 2, 3, 4, 5, 6, 7].map(n => (
            <button key={n} onClick={() => onRespond({ number: n })} style={btnStyle('primary')}>{n}</button>
          ))
        ) : isFreePlayChoice ? (
          <>
            <button onClick={() => onRespond({ play: false })} style={btnStyle('ghost')}>Decline</button>
            <button onClick={() => onRespond({ play: true })} style={btnStyle('primary')}>Play for 0</button>
          </>
        ) : isCardTypeChoice ? (
          <>
            <button onClick={() => onRespond({ cardType: 'point' })} style={btnStyle('primary')}>Point</button>
            <button onClick={() => onRespond({ cardType: 'action' })} style={btnStyle('primary')}>Action</button>
          </>
        ) : (
          <>
            {isOptional && (
              <button onClick={decline} style={btnStyle('ghost')}>{declineLabel}</button>
            )}
            <button
              onClick={confirm}
              disabled={!canConfirm}
              style={btnStyle(canConfirm ? 'primary' : 'disabled')}
            >
              {confirmLabel}
              {count && count > 1 && selected.length > 0 && ` (${selected.length}/${count})`}
            </button>
          </>
        )}
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
  if (variant === 'primary') return { ...base, background: '#ff0099', color: '#fff' }
  if (variant === 'ghost') return { ...base, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.6)' }
  if (variant === 'disabled') return { ...base, background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.2)' }
  return base
}
