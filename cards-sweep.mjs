import cards from './src/data/cards.json' with { type: 'json' };
import { createGameState, initDeck, createStackEntry, controllerOf, opponent, stackEntryMatchesFilter } from './src/engine/state.js';
import { executeEffects, executeOnPlayEffects } from './src/effects/executor.js';
import { resolveChoice } from './src/engine/choices.js';
import { advancePendingChoices } from './src/server.js';
import { getCard } from './src/data/cardDb.js';

const DUMMY_HAND = ['53','04','45','65','66'];

function setup() {
  const s = createGameState(); initDeck(s);
  s.phase='active'; s.turn='p1'; s.activePlayer='p1'; s.turnNumber=2;
  s.players.p1.energy=30; s.players.p2.energy=30;
  // give p1 a hand of dummies (remove from deck if present)
  for (const id of DUMMY_HAND){ const i=s.zones.deck.indexOf(id); if(i!==-1)s.zones.deck.splice(i,1); s.players.p1.hand.push(id); }
  for (const id of ['07','12','13']){ const i=s.zones.deck.indexOf(id); if(i!==-1)s.zones.deck.splice(i,1); s.players.p2.hand.push(id); }
  // seed a few cards in trash (for putFromTrashToHand etc.)
  s.zones.trash.push('22','34','38');
  // seed stack with dummy targets beneath the test card: an action (played in response to a point) and a point
  const actionDummy = createStackEntry('53','p2',{ respondedToCardIndex:1, respondedToCardType:'point' });
  const pointDummy  = createStackEntry('04','p2',{});
  s.zones.stack = [actionDummy, pointDummy];
  return s;
}

function makePayload(s, ch) {
  const p = ch.player; const hand = s.players[p].hand;
  const findStack = () => s.zones.stack.findIndex(e => stackEntryMatchesFilter(e, ch.filter));
  switch (ch.type) {
    case 'trashFromHand': return { cardIds: hand.slice(0, ch.count ?? 1) };
    case 'putFromTrashToHand': return { cardIds: s.zones.trash.slice(0, ch.count ?? 1) };
    case 'trashFromStack': case 'returnToControllerHand': case 'stealFromStack': case 'gainControl': case 'moveFromStackToDeckTop': {
      const i = findStack(); return i>=0 ? { stackIndex:i } : { stackIndex:0 };
    }
    case 'putHandCardOnDeckTop': return hand.length ? { cardId: hand[0] } : undefined;
    case 'additionalCost':
      return ch.cost?.type==='putHandCardOnDeckTop'
        ? (hand.length?{cardId:hand[0]}:undefined)
        : { cardIds: hand.slice(0, ch.cost?.count ?? 1) };
    case 'optional': return { accept: true };
    case 'revealUntilType': return { cardType: 'action' };
    case 'lookAtTopN': return { trashCardId: (ch.revealed ?? s.zones.deck)[0] };
    case 'opponentChoosesOne': return ch.revealedCards?.length ? { cardId: ch.revealedCards[0] } : undefined;
    case 'controllerMovesCardFromStackTarget': { const i=findStack(); return i>=0 ? { stackIndex:i } : { stackIndex:0 }; }
    case 'controllerMovesCardFromStack': return { destination: 'deckTop' };
    case 'chooseNumber': return { number: 0 };
    case 'confirmFreePlay': return { play: false };
    case 'trashUnlessControllerPaysTarget': { const i=findStack(); return i>=0 ? { stackIndex:i } : { stackIndex:0 }; }
    case 'trashUnlessControllerPays': return { pay: false };
    case 'putFromTrashToDeckBottom': return { cardIds: s.zones.trash.slice(0, ch.count ?? 1) };
    case 'chooseCardToTrashFromRevealedHand': {
      const cand = (ch.revealedHand ?? []).filter(id => !ch.filter || ch.filter === 'any' || getCard(id).type === ch.filter);
      return cand.length ? { cardId: cand[0] } : undefined;
    }
    default: return undefined; // unknown choice type
  }
}

const CHOICE_TRIGGER_TYPES = new Set(['trashFromHandChoice','trashFromStackChoice','returnStackCardToHandChoice','stealFromStackChoice','gainControlChoice','putFromTrashToHandChoice','optionalEffectChoice','additionalCost','putHandCardOnDeckTop','revealUntilType','opponentChoosesOne','controllerMovesCardFromStack','lookAtTopN','chooseNumber','chooseCardToTrashFromRevealedHand','trashUnlessControllerPays','trashFromRevealed','conditionalPlay','trashFromRevealedHand','mayPlayFromHand','mayPlayTopOfDeck','moveFromStackToDeckTop','chooseCardType','confirmFreePlay','trashUnlessControllerPaysTarget','controllerMovesCardFromStackTarget','revealTopN']);

function sweepCard(card) {
  const s = setup();
  const entry = createStackEntry(card.id, 'p1', { respondedToCardIndex:0, respondedToCardType:'point' });
  const events = [];
  let crash = null, choiceFail = null;
  try {
    events.push(...executeOnPlayEffects(s, entry));
    events.push(...executeEffects(s, entry));
    // drain choices
    let guard=0;
    while (guard++ < 80) {
      if (!s.pendingChoice) { if (!advancePendingChoices(s)) break; }
      const ch = s.pendingChoice;
      const payload = makePayload(s, ch);
      if (payload === undefined) { choiceFail = { kind:'UNRESOLVABLE', type: ch.type }; break; }
      const { error } = resolveChoice(s, ch.player, payload);
      if (error) { choiceFail = { kind:'ERROR', type: ch.type, error }; break; }
    }
  } catch (e) { crash = e.message; }
  const unhandled = [...new Set(events.filter(e=>e.type==='UNHANDLED_EFFECT').map(e=>e.effectType))];
  // leftover un-surfaced choice triggers
  const leftover = [...new Set(s.pendingTriggers.filter(t=>CHOICE_TRIGGER_TYPES.has(t.type)).map(t=>t.type))];
  let status='OK', detail='';
  if (crash){ status='CRASH'; detail=crash; }
  else if (choiceFail){ status='CHOICE_'+choiceFail.kind; detail=choiceFail.type+(choiceFail.error?': '+choiceFail.error:''); }
  else if (unhandled.length){ status='UNHANDLED_EFFECT'; detail=unhandled.join(','); }
  else if (leftover.length){ status='CHOICE_NOT_SURFACED'; detail=leftover.join(','); }
  return { id:card.id, name:card.name, type:card.type, status, detail };
}

const results = cards.map(sweepCard);
const bad = results.filter(r=>r.status!=='OK');
console.log(`SWEEP: ${results.length} cards | OK: ${results.length-bad.length} | issues: ${bad.length}\n`);
const byStatus = {};
for (const r of bad) (byStatus[r.status]=byStatus[r.status]||[]).push(r);
for (const st of Object.keys(byStatus).sort()){
  console.log(`### ${st} (${byStatus[st].length})`);
  for (const r of byStatus[st]) console.log(`  ${r.id} ${r.name.padEnd(18)} ${r.type.padEnd(6)} — ${r.detail}`);
  console.log('');
}
