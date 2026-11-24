// Build src/data/cards.json for the v4 90-card set.
// Name / cost / text come from docs/cards-v4.md so the data can never drift
// from what is printed on the art; this file only supplies the structure.
import { readFileSync, writeFileSync } from 'node:fs';

const ROOT = process.argv[2] ?? '.';
const md = readFileSync(`${ROOT}/docs/cards-v4.md`, 'utf8');
const rows = [...md.matchAll(/^\| (\d{2}) \| (.+?) \| (\d+) \| (.+?) \| (\S+) \| /gm)]
  .map(m => ({ id: m[1], name: m[2], energyCost: +m[3], effectText: m[4] }));
if (rows.length !== 90) throw new Error(`expected 90 rows, got ${rows.length}`);

const E = (type, rest = {}) => ({ type, ...rest });
const draw = (count, player = 'self', rest = {}) => E('draw', { count, player, ...rest });
const trig = (on, effect, rest = {}) => E('trigger', { on, ...rest, effect });

// id -> everything except id/name/energyCost/effectText
const SPEC = {
  // ── Points ────────────────────────────────────────────────────────────────
  '00': { staticEffects: [E('lockHorizon', { scope: 'opponents', filter: 'action' })] },
  '01': { effects: [E('putPointFromDuskIntoZenith', { player: 'self' })] },
  '02': { effects: [E('gainEnergy', { amount: 4, player: 'self' })] },
  '03': { costModifiers: [E('discountIfCondition', { condition: 'energizedBothTypesThisTurn', amount: 2 })] },
  '04': { effects: [draw(1)] },
  '05': { costModifiers: [E('discountIfCondition', { condition: 'playedBothTypesThisTurn', amount: 4 })] },
  '06': { effects: [E('optional', { effects: [E('duskFromHand', { count: 1, player: 'self' }), draw(1)] })] },
  '07': { effects: [E('duskHand', { player: 'self' })] },
  '08': { staticEffects: [trig('leavesHorizon', draw(1, 'opponent'))] },
  '09': { playRestrictions: [E('mustBeFirstCardThisTurn')], onPlayEffects: [E('lockSelfFromPlaying')] },
  '10': { effects: [E('duskFromHand', { count: 1, player: 'both' })] },
  '11': { effects: [E('duskFromHand', { count: 1, player: 'both' }), draw(1, 'both')] },
  '12': { costModifiers: [E('discountIfCondition', { condition: 'opponentAtFourPoints', amount: 3 })] },
  '13': { staticEffects: [E('modifyPlayCost', { target: 'opponent', amount: -2, filter: 'action' })] },
  '14': { effects: [E('chooseCardToDuskFromRevealedHand', { filter: 'any' })] },
  '15': { costModifiers: [E('discountPerCard', { zone: 'cardsPlayedThisTurn', filter: 'any', amount: 1 })] },
  '16': { onPlayEffects: [E('duskHand', { player: 'self' })] },
  '17': { staticEffects: [E('modifyPlayCost', { target: 'opponent', amount: 2 })] },
  '18': { effects: [E('conditionalDraw', { condition: 'energizedBothTypesThisTurn', count: 2, player: 'self' })] },
  '19': { staticEffects: [trig('opponentActionRises', draw(1, 'controller'))] },
  '20': { effects: [draw(2, 'both')] },
  '21': { staticEffects: [E('lockHorizon', { scope: 'controller', filter: 'action' })] },
  '22': { staticEffects: [trig('anyPlayerPlaysAction', draw(1, 'opponentOfPlayer'))] },
  '23': { effects: [E('putFromDuskToHand', { count: 1 })] },
  '24': { playRestrictions: [E('exactEnergy', { amount: 4 })] },
  '25': { onPlayEffects: [E('drainOpponentEnergy', { player: 'self' })] },
  '26': { effects: [E('duskHandThenDrawSameCount', { player: 'both' })] },
  '27': { staticEffects: [trig('anyPlayerPlaysAction', E('gainEnergy', { amount: 1, player: 'both' }))] },
  '28': { costModifiers: [E('discountIfCondition', { condition: 'drewTwoOrMoreThisTurn', amount: 3 })] },
  '29': { effects: [E('duskHand', { player: 'self' }), draw(3)] },
  '30': { effects: [E('conditionalDraw', { condition: 'selfAtFourPoints', count: 3, player: 'self' })] },
  '31': { effects: [E('revealUntilType', { putChosen: 'hand', putRest: 'opponentHand' })] },
  '32': { staticEffects: [trig('nthCardPlayedThisTurn', E('duskSelf'), { n: 2, filter: 'action', by: 'opponent' })] },
  '33': { staticEffects: [E('allowPlayFromDusk', { filter: 'action', surcharge: 1 })] },
  '34': { staticEffects: [E('lockDraw')] },
  '35': { staticEffects: [trig('leavesHorizonWithoutRising', E('moveSelf', { to: 'deckBottom' }))] },
  '36': { staticEffects: [trig('leavesHorizonWithoutRising', draw(1, 'both'))] },
  '37': { effects: [E('gainEnergy', { amount: 4, player: 'both' })] },
  '38': { staticEffects: [E('setActionCostZero', { target: 'controller' })] },
  '39': { staticEffects: [trig('opponentRespondsToThis', E('duskSelf'))] },
  '40': {
    additionalCosts: [E('payAnyAmount')],
    staticEffects: [E('modifyPlayCost', { target: 'opponent', amount: 'paidAmount' })],
  },
  '41': {
    staticEffects: [trig('leavesHorizon', E('branchOnRose', {
      ifRose: draw(1, 'controller'),
      ifNot: E('duskFromHand', { count: 1, player: 'controller' }),
    }))],
  },
  '42': {
    staticEffects: [{
      type: 'trigger', on: 'opponentRespondsToThis',
      effects: [E('duskSelf'), draw(3)],
    }],
  },
  '43': { additionalCosts: [E('putFromDuskToDeckBottom', { count: 6 })] },
  '44': { costModifiers: [E('freeIfCondition', { condition: 'revealThreePointsFromHand' })] },

  // ── Actions ───────────────────────────────────────────────────────────────
  '45': { effects: [E('returnToControllerHand', { filter: 'point' })] },
  '46': { effects: [E('moveFromHorizonToDeckTop', { filter: 'any' })] },
  '47': { effects: [E('putFromDuskToHand', { count: 1, thenGrant: E('cardFreeThisTurn') })] },
  '48': { effects: [E('duskFromHorizon', { filter: 'point' })] },
  '49': {
    effects: [
      E('revealTopN', { count: 4 }),
      E('opponentChoosesOne', { putChosen: 'chooserHand', putRest: 'casterHand' }),
    ],
  },
  '50': { effects: [E('opponentChoosesFromDusk', { count: 2, putTo: 'casterHand' })] },
  '51': {
    additionalCosts: [E('payAnyAmount')],
    effects: [E('duskUnlessControllerPays', { filter: 'any', ransom: E('payEnergy', { amount: 'paidAmount' }) })],
  },
  '52': { effects: [E('gainEnergy', { amount: 1, player: 'both' }), draw(1, 'self', { timing: 'endOfTurn' })] },
  '53': { effects: [E('lockResponsesToMyCards'), draw(1)] },
  '54': { effects: [E('lockOpponentFromPlaying')] },
  '55': { effects: [draw(2), E('duskFromHand', { count: 2, player: 'self' })] },
  '56': {
    effects: [E('registerTrigger', {
      on: 'selfCardLeavesHorizonWithoutRising', duration: 'turn', effect: draw(2, 'controller'),
    })],
  },
  '57': {
    costModifiers: [E('discountPerCard', { zone: 'ownZenith', filter: 'any', amount: 1 })],
    effects: [draw(2)],
  },
  '58': { effects: [E('putFromDuskToDeckTop', { count: 1 }), draw(1, 'self', { timing: 'endOfTurn' })] },
  '59': { effects: [E('controllerMovesCardFromHorizon', { filter: 'action', destinations: ['deckTop', 'deckBottom'] })] },
  '60': { effects: [E('putPointFromHorizonIntoZenith', { player: 'self' })] },
  '61': { effects: [E('duskUnlessControllerPays', { filter: 'any', ransom: E('payEnergy', { amount: 'countInDusk:any' }) })] },
  '62': { effects: [E('duskFromHorizon', { filter: 'any', thenGrant: E('nextCardFree', { player: 'trashedCardController' }) })] },
  '63': { effects: [E('returnToControllerHand', { filter: 'any' }), E('gainEnergy', { amount: 3, player: 'self' })] },
  '64': { effects: [E('duskTopOfHorizon')] },
  '65': { effects: [E('revealUntilType', { putChosen: 'hand', putRest: 'dusk' })] },
  '66': { effects: [E('duskFromHandThenRansomOnHorizon', { player: 'self' })] },
  '67': { effects: [E('duskFromHorizon', { filter: 'any' }), E('duskHand', { player: 'self' })] },
  '68': { effects: [E('lockOpponentActionResponse'), draw(1)] },
  '69': {
    costModifiers: [E('discountPerCard', { zone: 'horizon', filter: 'any', amount: 1 })],
    effects: [E('duskAllFromHorizon')],
  },
  '70': { effects: [E('duskFromHorizon', { filter: 'actionPlayedInResponseToPoint' })] },
  '71': {
    costModifiers: [E('freeIfCondition', { condition: 'opponentPlayedThreeOrMoreThisTurn' })],
    effects: [E('duskFromHorizon', { filter: 'any' })],
  },
  '72': { effects: [E('duskUnlessControllerPays', { filter: 'any', ransom: E('giveFromDuskToCaster', { count: 3 }) })] },
  '73': { effects: [draw('distinctEnergyCostsOnHorizon')] },
  '74': {
    effects: [
      E('loseAllEnergy', { player: 'self' }),
      E('duskHand', { player: 'self' }),
      E('opponentChoosesFromDusk', { count: 5, putTo: 'casterHand' }),
    ],
  },
  '75': { effects: [draw(4), E('duskFromHand', { count: 4, player: 'self', timing: 'endOfTurn' })] },
  '76': { effects: [E('duskFromHorizon', { filter: 'any' }), draw(1, 'both')] },
  '77': { effects: [E('duskFromHorizon', { filter: 'point', thenGrant: E('gainEnergy', { amount: 'thisCardCost', player: 'self' }) })] },
  '78': { effects: [E('duskFromHorizon', { filter: 'action', thenGrant: E('gainEnergy', { amount: 3, player: 'trashedCardController' }) })] },
  '79': { effects: [E('duskAllFromHorizon')] },
  '80': { effects: [E('duskFromHorizon', { filter: 'point', thenGrant: E('lockPlayer', { player: 'trashedCardController' }) })] },
  '81': { effects: [draw(2), draw(1, 'opponent')] },
  '82': { effects: [E('duskFromHorizon', { filter: 'any', thenGrant: draw(2, 'trashedCardController') })] },
  '83': { effects: [E('moveFromHorizonToHand', { filter: 'point' })] },
  '84': {
    effects: [
      E('duskUnlessControllerPays', { filter: 'action', ransom: E('payEnergy', { amount: 1 }) }),
      draw(1),
    ],
  },
  '85': { effects: [E('duskFromHorizon', { filter: { costLessThanDuskSize: true } })] },
  '86': { effects: [draw(2, 'self', { timing: 'endOfTurn' })] },
  '87': { effects: [E('chooseCardToDuskFromRevealedHand', { filter: 'any' })] },
  '88': {
    effects: [E('returnToControllerHand', {
      filter: 'any',
      thenGrant: E('gainEnergy', { amount: 'thisCardCost', player: 'self', timing: 'endOfTurn' }),
    })],
  },
  '89': { effects: [E('returnToControllerHand', { filter: 'any', thenGrant: E('drawIfMine', { count: 1 }) })] },
};

const cards = rows.map(({ id, name, energyCost, effectText }) => {
  const spec = SPEC[id];
  if (!spec) throw new Error(`no spec for ${id} ${name}`);
  return {
    id,
    name,
    type: +id <= 44 ? 'point' : 'action',
    energyCost,
    effectText,
    playRestrictions: spec.playRestrictions ?? [],
    additionalCosts: spec.additionalCosts ?? [],
    ...(spec.costModifiers ? { costModifiers: spec.costModifiers } : {}),
    ...(spec.onPlayEffects ? { onPlayEffects: spec.onPlayEffects } : {}),
    effects: spec.effects ?? [],
    staticEffects: spec.staticEffects ?? [],
  };
});

const extra = Object.keys(SPEC).filter(k => !rows.some(r => r.id === k));
if (extra.length) throw new Error(`spec has ids not in the table: ${extra}`);

writeFileSync(`${ROOT}/src/data/cards.json`, JSON.stringify(cards, null, 2) + '\n');
console.log(`wrote ${cards.length} cards — ${cards.filter(c => c.type === 'point').length} points, ${cards.filter(c => c.type === 'action').length} actions`);
