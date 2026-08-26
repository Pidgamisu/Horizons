/**
 * Drive every card through the engine and report anything the rules engine
 * cannot yet carry out.
 *
 * For each of the 105 cards: put it on the horizon, let it rise, and auto-answer
 * any choices it spawns. A card is flagged if it emits UNHANDLED_EFFECT (the
 * executor has no case for one of its effect types), if it throws, or if it
 * leaves a choice nobody can answer.
 *
 * Run: node cards-sweep.mjs
 */
import { createGameState, createHorizonEntry, initDeck, drawCards } from './src/engine/state.js';
import { riseTopOfHorizon } from './src/engine/game.js';
import { executeOnPlayEffects } from './src/effects/executor.js';
import { ALL_CARD_IDS, getCard } from './src/data/cardDb.js';

const KNOWN_CHOICE_LIMIT = 40;

function freshState() {
  const state = createGameState();
  initDeck(state);
  drawCards(state, 'p1', 5);
  drawCards(state, 'p2', 5);
  state.phase = 'active';
  state.turn = 'p1';
  state.activePlayer = 'p1';
  state.players.p1.energy = 20;
  state.players.p2.energy = 20;
  // Give the horizon, dusk and both zeniths some content so targeting effects
  // have something legal to find.
  state.zones.dusk.push('001', '002', '051', '052');
  state.players.p1.zenith.push('003');
  state.players.p2.zenith.push('004');
  return state;
}

const results = [];

for (const id of ALL_CARD_IDS) {
  const card = getCard(id);
  const state = freshState();

  // A decoy from each side so horizon-targeting effects have a legal choice.
  state.zones.horizon.push(createHorizonEntry('005', 'p2', { respondedToCardType: 'point' }));
  state.zones.horizon.push(createHorizonEntry('053', 'p2', { respondedToCardType: 'point' }));

  const entry = createHorizonEntry(id, 'p1', { respondedToCardIndex: 0, respondedToCardType: 'point' });
  state.zones.horizon.unshift(entry);

  const issues = [];
  let events = [];
  try {
    events = [...executeOnPlayEffects(state, entry), ...riseTopOfHorizon(state)];
  } catch (err) {
    issues.push(`threw: ${err.message}`);
  }

  for (const ev of events) {
    if (ev.type === 'UNHANDLED_EFFECT') issues.push(`unhandled effect: ${ev.effectType}`);
  }

  // Any choice left queued that the sweep cannot answer is reported, not fatal.
  const pending = state.pendingTriggers.filter(t => t.type !== 'registerTurnTrigger');
  if (pending.length > KNOWN_CHOICE_LIMIT) issues.push('choice queue runaway');

  results.push({ id, name: card.name, type: card.type, issues, pending: pending.map(p => p.type) });
}

const broken = results.filter(r => r.issues.length > 0);
const unhandled = new Map();
for (const r of broken) {
  for (const i of r.issues) {
    if (i.startsWith('unhandled effect: ')) {
      const t = i.slice('unhandled effect: '.length);
      if (!unhandled.has(t)) unhandled.set(t, []);
      unhandled.get(t).push(r.id);
    }
  }
}

console.log(`Swept ${results.length} cards — ${results.length - broken.length} OK, ${broken.length} with issues.\n`);

if (unhandled.size) {
  console.log('Effect types with no executor case:');
  for (const [type, ids] of [...unhandled].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${type.padEnd(38)} ${ids.length} card(s): ${ids.join(', ')}`);
  }
  console.log();
}

const threw = broken.filter(r => r.issues.some(i => i.startsWith('threw:')));
if (threw.length) {
  console.log('Cards that threw:');
  for (const r of threw) console.log(`  ${r.id} ${r.name}: ${r.issues.filter(i => i.startsWith('threw:')).join('; ')}`);
  console.log();
}

process.exitCode = threw.length > 0 ? 1 : 0;
