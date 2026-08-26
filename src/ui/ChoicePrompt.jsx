import { useState } from 'react'
import { cardImageSrc, cardName, cardType } from '../data/cardImages.js'

const CARD_IMG_SIZE = { w: 90, h: 126 }

const plural = (n, one, many) => (n === 1 ? one : `${n} ${many}`)

// Player-facing wording for the effects an optional choice offers. Without this
// the prompt would show the raw effect type ("shuffleDuskIntoDeck").
const EFFECT_TEXT = {
  shuffleDuskIntoDeck: () => 'shuffle the dusk into the deck',
  duskFromHand: (e) => `put ${plural(e.count ?? 1, 'a card', 'cards')} from your hand into the dusk`,
  duskHand: () => 'put your hand into the dusk',
  draw: (e) => `draw ${plural(e.count ?? 1, 'a card', 'cards')}`,
  gainEnergy: (e) => `gain ${e.amount} energy`,
  putFromDuskToHand: (e) => `put ${plural(e.count ?? 1, 'a card', 'cards')} from the dusk into your hand`,
  putFromDuskToDeckTop: (e) => `put ${plural(e.count ?? 1, 'a card', 'cards')} from the dusk on top of the deck`,
  putPointFromDuskIntoZenith: () => 'put a point from the dusk into your zenith',
  duskFromHorizon: () => 'put a card on the horizon into the dusk',
}

/** "Put a card from your hand into the dusk, then draw a card?" */
export function describeEffects(effects) {
  if (!effects?.length) return null
  const parts = effects.map(e => EFFECT_TEXT[e.type]?.(e)).filter(Boolean)
  // Unknown effect → no description at all, rather than leaking an identifier.
  if (parts.length !== effects.length) return null
  const sentence = parts.join(', then ')
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}?`
}

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

export function ChoicePrompt({ choice, myHand, horizonCards, duskCards, myEnergy = 0, onRespond }) {
  const [selected, setSelected] = useState([])

  const toggle = (id) => {
    // "Any number" choices (Reset Memory) allow an unbounded multi-select.
    const anyNumber = choice.type === 'duskAnyNumberFromHand'
    const count = choice.count ?? 1
    if (!anyNumber && count === 1) {
      setSelected([id])
    } else {
      setSelected(prev =>
        prev.includes(id)
          ? prev.filter(x => x !== id)
          : anyNumber || prev.length < count
            ? [...prev, id]
            : prev
      )
    }
  }

  const confirm = () => {
    const { type } = choice

    // Binary "pay the ransom" choice — no card selection needed.
    if (type === 'duskUnlessControllerPays') { onRespond({ pay: true }); return }

    // "Any number" allows confirming with zero cards selected.
    if (type === 'duskAnyNumberFromHand') { onRespond({ cardIds: selected }); setSelected([]); return }

    if (selected.length === 0) return

    if (type === 'duskFromHand') {
      onRespond({ cardIds: selected })
    } else if (type === 'putFromDuskToHand' || type === 'putFromDuskToDeckBottom' || type === 'putFromDuskToDeckTop' || type === 'opponentChoosesFromDusk') {
      onRespond({ cardIds: selected })
    } else if (['duskFromHorizon', 'returnToControllerHand', 'stealFromHorizon', 'gainControl', 'moveFromHorizonToDeckTop', 'duskUnlessControllerPaysTarget', 'controllerMovesCardFromHorizonTarget', 'putPointFromHorizonIntoZenith', 'moveOnHorizonToTop'].includes(type)) {
      onRespond({ horizonIndex: parseInt(selected[0]) })
    } else if (type === 'returnTwoDifferentControllers') {
      onRespond({ horizonIndexes: selected.map((i) => parseInt(i)) })
    } else if (type === 'optional') {
      onRespond({ accept: true })
    } else if (type === 'putHandCardOnDeckTop' || type === 'chooseCardToDuskFromRevealedHand' || type === 'opponentChoosesOne' || type === 'putPointFromDuskIntoZenith' || type === 'duskFromHandThenMatchCost') {
      onRespond({ cardId: selected[0] })
    } else if (type === 'lookAtTopN') {
      onRespond({ duskCardId: selected[0] })
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
    } else if (choice.type === 'duskUnlessControllerPays') {
      onRespond({ pay: false })
    } else if (choice.type === 'mayPlayFromHand') {
      onRespond({ play: false })
    }
    setSelected([])
  }

  const { type, count, filter } = choice
  const filterLabel = typeof filter === 'object' && filter !== null
    ? (filter.costEquals != null ? `card costing ${filter.costEquals}` : 'card')
    : filter === 'any' || !filter ? 'card' : `${filter} card`

  // Horizon cards offered as targets, keyed by their real horizon index. A
  // rising card has already left the horizon, so there is nothing to exclude.
  // Only cards this choice can actually take. The server computes the legal
  // indexes with the engine's own matcher, so a prompt never shows a card that
  // would be rejected — an "action only" effect simply doesn't display points.
  // Indexes stay the real horizon indexes, since that's what the payload sends.
  const horizonTargets = () => {
    const legal = choice.legalHorizonIndexes
    return horizonCards
      .map((e, i) => ({ e, i }))
      .filter(({ i }) => !legal || legal.includes(i))
      .map(({ e, i }) => ({ id: String(i), label: i === 0 ? 'TOP' : null, cardId: e.cardId }))
  }

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
  let isAmountChoice = false
  let isFreePlayChoice = false
  let isDestinationChoice = false

  if (type === 'controllerMovesCardFromHorizonTarget') {
    title = `Choose a ${filterLabel} on the horizon`
    subtitle = 'Its controller will move it to the top or bottom of the deck'
    cards = horizonTargets()
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

  else if (type === 'duskUnlessControllerPaysTarget') {
    title = `Choose a ${filterLabel} on the horizon`
    subtitle = 'Its controller may pay the ransom to save it'
    cards = horizonTargets()
    canConfirm = selected.length === 1
    confirmLabel = 'Target'
  }

  else if (type === 'duskUnlessControllerPays') {
    const ransom = choice.ransom
    const targetName = cardName(choice.targetCardId)
    isOptional = true
    declineLabel = `Let ${targetName} go to the dusk`
    if (ransom?.type === 'payEnergy') {
      const cost = choice.ransomCost ?? 0
      title = `Pay ${cost} energy to save ${targetName}?`
      subtitle = `Otherwise it goes to the dusk. You have ${myEnergy} energy.`
      confirmLabel = `Pay ${cost}`
      canConfirm = myEnergy >= cost
    } else {
      title = `Save ${targetName} from the dusk?`
      subtitle = 'Pay by putting a card from the dusk on the bottom of the deck.'
      confirmLabel = 'Pay'
      canConfirm = true
    }
  }

  else if (type === 'lookAtTopN') {
    title = 'Look at the top cards — put one in the dusk'
    subtitle = 'Then draw a card'
    cards = (choice.revealed ?? []).map(id => ({ id, label: null }))
    canConfirm = selected.length === 1
    confirmLabel = 'To the dusk'
  }

  else if (type === 'chooseCardToDuskFromRevealedHand') {
    title = `Choose a ${filterLabel} to put in the dusk from your opponent’s hand`
    subtitle = 'Their hand is revealed'
    const hand = choice.revealedHand ?? []
    cards = hand
      .filter(id => !filter || filter === 'any' || cardType(id) === filter)
      .map(id => ({ id, label: null }))
    canConfirm = selected.length === 1
    confirmLabel = 'To the dusk'
  }

  else if (type === 'putFromDuskToDeckBottom') {
    title = `Put ${count ?? 1} card${(count ?? 1) !== 1 ? 's' : ''} from the dusk on the bottom of the deck`
    subtitle = 'Choose from the dusk to pay the ransom'
    cards = duskCards.map(id => ({ id, label: null }))
    canConfirm = selected.length === (count ?? 1)
    confirmLabel = 'Put on Deck Bottom'
  }

  else if (type === 'duskAnyNumberFromHand') {
    const bonus = choice.drawPlus ?? 0
    title = 'Put any number of cards from your hand into the dusk'
    subtitle = `Then draw that many${bonus ? ` plus ${bonus}` : ''}. Select any number, or none.`
    cards = myHand.map(id => ({ id, label: null }))
    canConfirm = true // zero is a valid choice
    confirmLabel = selected.length
      ? `Dusk ${selected.length} & draw ${selected.length + bonus}`
      : `Dusk none & draw ${bonus}`
  }

  else if (type === 'duskFromHand') {
    title = `Put ${count} card${count !== 1 ? 's' : ''} from your hand into the dusk`
    subtitle = `Select ${count} card${count !== 1 ? 's' : ''} to put in the dusk`
    cards = myHand.map(id => ({ id, label: null }))
    canConfirm = selected.length === count
    confirmLabel = 'To the dusk'
  }

  else if (type === 'opponentChoosesFromDusk') {
    title = `Choose ${count} card${count !== 1 ? 's' : ''} from the dusk for your opponent`
    subtitle = 'They pick the card — you decide which ones they get'
    cards = duskCards.map(id => ({ id, label: null }))
    canConfirm = selected.length === count
    confirmLabel = 'Give'
  }

  else if (type === 'duskFromHandThenMatchCost') {
    title = 'Put a card from your hand into the dusk'
    subtitle = 'You may then dusk a card on the horizon that shares its energy cost'
    cards = myHand.map(id => ({ id, label: null }))
    canConfirm = selected.length === 1
    confirmLabel = 'To the dusk'
  }

  else if (type === 'returnTwoDifferentControllers') {
    title = 'Return two cards on the horizon to their controllers'
    subtitle = 'The two cards must be controlled by different players'
    cards = horizonTargets()
    canConfirm = selected.length === 2
    confirmLabel = 'Return both'
  }

  else if (type === 'putPointFromDuskIntoZenith') {
    title = 'Put a point from the dusk into your zenith'
    subtitle = 'It scores immediately — one point per card in your zenith'
    cards = duskCards.filter(id => cardType(id) === 'point').map(id => ({ id, label: null }))
    canConfirm = selected.length === 1
    confirmLabel = 'To my zenith'
  }

  else if (type === 'putPointFromHorizonIntoZenith') {
    title = 'Put a point from the horizon into your zenith'
    subtitle = 'It never rises — it is banked straight into your zenith'
    cards = horizonTargets()
    canConfirm = selected.length === 1
    confirmLabel = 'To my zenith'
  }

  else if (type === 'moveOnHorizonToTop') {
    title = 'Move a card to the top of the horizon'
    subtitle = 'The card you choose will rise next'
    cards = horizonTargets()
    canConfirm = selected.length === 1
    confirmLabel = 'Move to top'
  }

  else if (type === 'putFromDuskToDeckTop') {
    title = `Put ${count ?? 1} card${(count ?? 1) !== 1 ? 's' : ''} from the dusk on top of the deck`
    subtitle = 'It will be drawn next'
    cards = duskCards.map(id => ({ id, label: null }))
    canConfirm = selected.length === (count ?? 1)
    confirmLabel = 'To deck top'
  }

  else if (type === 'putFromDuskToHand') {
    title = `Take ${count ?? 1} card${(count ?? 1) !== 1 ? 's' : ''} from the dusk`
    subtitle = 'Choose a card to put into your hand'
    cards = duskCards.map(id => ({ id, label: null }))
    canConfirm = selected.length === (count ?? 1)
  }

  else if (type === 'duskFromHorizon' || type === 'duskFromHorizonChoice') {
    title = `Put a ${filterLabel} from the horizon into the dusk`
    subtitle = 'Select a card to put in the dusk'
    cards = horizonTargets()
    canConfirm = selected.length === 1
    confirmLabel = 'To the dusk'
  }

  else if (type === 'returnToControllerHand') {
    title = 'Return a card from the horizon'
    subtitle = 'Choose a card to return to its controller\'s hand'
    cards = horizonTargets()
    canConfirm = selected.length === 1
    confirmLabel = 'Return'
  }

  else if (type === 'moveFromHorizonToDeckTop') {
    title = 'Put a card from the horizon on top of the deck'
    subtitle = 'Choose a card on the horizon'
    cards = horizonTargets()
    canConfirm = selected.length === 1
    confirmLabel = 'Put on Deck'
  }

  else if (type === 'stealFromHorizon') {
    title = 'Take a point card from the horizon'
    subtitle = 'Choose a point card to put into your hand'
    cards = horizonTargets()
    canConfirm = selected.length === 1
    confirmLabel = 'Take'
  }

  else if (type === 'gainControl') {
    title = 'Gain control of a card on the horizon'
    subtitle = 'Choose a card'
    cards = horizonTargets()
    canConfirm = selected.length === 1
    confirmLabel = 'Take Control'
  }

  else if (type === 'optional') {
    isOptional = true
    title = describeEffects(choice.effects) ?? 'Use this effect?'
    subtitle = 'This is optional — you may decline.'
    confirmLabel = 'Yes'
    declineLabel = 'No'
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
    const costCount = choice.cost?.count ?? 1
    if (costType === 'duskFromHand') {
      subtitle = 'Put a card from your hand into the dusk to play this card'
      cards = myHand.map(id => ({ id, label: null }))
      canConfirm = selected.length === 1
      confirmLabel = 'Pay & Play'
    } else if (costType === 'putHandCardOnDeckTop') {
      subtitle = 'Put a card on top of the deck to play this card'
      cards = myHand.map(id => ({ id, label: null }))
      canConfirm = selected.length === 1
      confirmLabel = 'Pay & Play'
    } else if (costType === 'putFromDuskToDeckBottom') {
      // Abyss (048)
      subtitle = `Put ${costCount} cards from the dusk on the bottom of the deck to play this card`
      cards = duskCards.map(id => ({ id, label: null }))
      canConfirm = selected.length === costCount
      confirmLabel = 'Pay & Play'
    } else if (costType === 'payAnyAmount') {
      // Auction (045), Bid (058) — the amount paid feeds the card's own text.
      isAmountChoice = true
      title = 'Pay any amount of energy'
      subtitle = `How much do you want to pay? You have ${myEnergy}.`
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
        ) : isAmountChoice ? (
          Array.from({ length: Math.min(myEnergy, 12) + 1 }, (_, n) => (
            <button key={n} onClick={() => onRespond({ amount: n })} style={btnStyle('primary')}>{n}</button>
          ))
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
