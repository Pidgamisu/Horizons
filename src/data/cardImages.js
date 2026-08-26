// Card art lookup. Art files are named by card id, e.g. "000" -> "/cards/000.png".
import cards from './cards.json'

const IDS = new Set(cards.map((c) => c.id))

/** Image path for a card id; falls back to the card back for unknown/hidden cards. */
export function cardImageSrc(cardId) {
  return cardId != null && IDS.has(cardId) ? `/cards/${cardId}.png` : '/cards/back.png'
}

const NAME_BY_ID = Object.fromEntries(cards.map((c) => [c.id, c.name]))

/** Display name for a card id; falls back to "A card" for unknown/hidden cards. */
export function cardName(cardId) {
  return (cardId != null && NAME_BY_ID[cardId]) || 'A card'
}

const TYPE_BY_ID = Object.fromEntries(cards.map((c) => [c.id, c.type]))

/** Card type ('point' | 'action') for a card id, or null if unknown. */
export function cardType(cardId) {
  return (cardId != null && TYPE_BY_ID[cardId]) || null
}
