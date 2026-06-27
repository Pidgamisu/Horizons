// Browser-safe card art lookup. cardDb.js can't be imported on the client
// (it uses Node's fs), so this module imports cards.json directly (Vite parses
// JSON imports) and maps each card id to its slugged art filename. Card art
// files are named after the card's name, e.g. "00" -> "/cards/unstoppable.png".
import cards from './cards.json'

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

const SLUG_BY_ID = Object.fromEntries(cards.map((c) => [c.id, slugify(c.name)]))

/** Image path for a card id; falls back to the card back for unknown/hidden cards. */
export function cardImageSrc(cardId) {
  const slug = cardId != null ? SLUG_BY_ID[cardId] : null
  return slug ? `/cards/${slug}.png` : '/cards/back.png'
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
