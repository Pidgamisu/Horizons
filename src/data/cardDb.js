import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(__dirname, 'cards.json'), 'utf8');
const cardList = JSON.parse(raw);

// Index by id for O(1) lookup
export const CARDS = Object.fromEntries(cardList.map(c => [c.id, c]));

export function getCard(id) {
  const card = CARDS[id];
  if (!card) throw new Error(`Unknown card id: ${id}`);
  return card;
}

export const ALL_CARD_IDS = cardList.map(c => c.id);
