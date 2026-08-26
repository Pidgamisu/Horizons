// Card lookup by id. cards.json is imported as a JSON module (supported by both
// Node and Vite) rather than read through fs, so the engine stays importable in
// the browser bundle as well as on the server.
import cardList from './cards.json' with { type: 'json' };

// Index by id for O(1) lookup
export const CARDS = Object.fromEntries(cardList.map(c => [c.id, c]));

export function getCard(id) {
  const card = CARDS[id];
  if (!card) throw new Error(`Unknown card id: ${id}`);
  return card;
}

export const ALL_CARD_IDS = cardList.map(c => c.id);
