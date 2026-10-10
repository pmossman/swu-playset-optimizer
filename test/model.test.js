import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, binomialHead, countHead, prepare, evaluate, simulate } from '../public/model.js';
import { parseList, formatList } from '../public/collection.js';
import { normalizeSet, hasBoosters } from '../lib/tcgcsv.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a}`);

function choose(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

test('binomialHead matches the closed form', () => {
  for (const [n, p] of [[10, 0.3], [240, 1 / 50], [24, 0.09], [0, 0.5]]) {
    const head = binomialHead(n, p, 4);
    for (let k = 0; k < 4; k++) {
      const exact = k > n ? 0 : choose(n, k) * p ** k * (1 - p) ** (n - k);
      close(head[k], exact, 1e-12, `n=${n} p=${p} k=${k}`);
    }
  }
  assert.deepEqual(binomialHead(2, 1, 4), [0, 0, 1, 0]);
});

test('countHead convolves independent slots', () => {
  const n = 12, p1 = 0.2, p2 = 0.05;
  const head = countHead(n, [p1, p2], 3);
  const a = binomialHead(n, p1, 3), b = binomialHead(n, p2, 3);
  close(head[0], a[0] * b[0], 1e-12);
  close(head[1], a[1] * b[0] + a[0] * b[1], 1e-12);
  close(head[2], a[2] * b[0] + a[1] * b[1] + a[0] * b[2], 1e-12);
});

// A toy set shaped like a real one: 8+8 leaders, 8 bases, 100 C, 60 U, 50 R, 20 L, 10 S.
function toySet() {
  const cards = [];
  let n = 1;
  const add = (count, r, t, price) => {
    for (let i = 0; i < count; i++) cards.push({ n: n++, name: `${r}${t}${i}`, r, t, p: { normal: { m: price, l: price, mid: price }, foil: null, hs: null } });
  };
  add(8, 'C', 'Leader', 0.25); add(8, 'R', 'Leader', 2);
  add(8, 'C', 'Base', 0.2);
  add(100, 'C', 'Unit', 0.1); add(60, 'U', 'Unit', 0.3);
  add(50, 'R', 'Unit', 2.5); add(20, 'L', 'Unit', 18);
  add(10, 'S', 'Unit', 4);
  return cards;
}

test('slot probabilities add up to the pack contents', () => {
  const s = { ...DEFAULTS, boxPrice: 70 };
  const { items } = prepare(toySet(), s);
  const perPack = items.reduce((a, it) => a + it.slots.reduce((x, p) => x + p, 0), 0);
  // leader + base + 9 C + 3 U + rare slot + foil slot
  close(perPack, 16, 1e-9);
  assert.equal(items.filter(it => it.group === 'Special').every(it => it.slots.length === 0), true);
});

test('exact expectation agrees with a pack-by-pack simulation', () => {
  const s = { ...DEFAULTS, boxPrice: 70, resalePct: 80, resaleMin: 1 };
  const prep = prepare(toySet(), s);
  const { rows } = evaluate(prep, s, 6);
  const sims = simulate(prep, s, 6, 3000, 42);
  for (const B of [0, 1, 3, 6]) {
    const mean = sims[B].reduce((a, b) => a + b, 0) / sims[B].length;
    close(mean, rows[B].total, Math.max(2, rows[B].total * 0.005), `B=${B}`);
  }
});

test('no boxes means buying exactly the full playset', () => {
  const s = { ...DEFAULTS, boxPrice: 70, includeSpecial: false };
  const prep = prepare(toySet(), s);
  const { rows } = evaluate(prep, s, 0);
  const expected = 3 * (8 * 0.25 + 8 * 2 + 8 * 0.2 + 100 * 0.1 + 60 * 0.3 + 50 * 2.5 + 20 * 18);
  close(rows[0].total, expected, 1e-6);
});

test('cards you own come off what boxes and singles have to cover', () => {
  const cards = toySet();
  const s = { ...DEFAULTS, boxPrice: 70 };
  const fresh = prepare(cards, s);

  const one = prepare(cards, s, { [cards[0].n]: 2 });
  assert.deepEqual([one.items[0].target, one.items[0].have, one.items[0].need], [3, 2, 1]);

  // A complete collection: nothing left to buy, so no boxes.
  const everything = prepare(cards, s, Object.fromEntries(cards.map(c => [c.n, 3])));
  const done = evaluate(everything, s, 4);
  assert.equal(done.best, 0);
  assert.equal(done.rows[0].total, 0);

  // Owning every rare/legendary playset (extra copies are clamped) saves exactly their
  // singles price at zero boxes, and makes boxes no more attractive than before.
  const isRL = c => c.r === 'R' || c.r === 'L';
  const rl = prepare(cards, s, Object.fromEntries(cards.filter(isRL).map(c => [c.n, 5])));
  const before = evaluate(fresh, s, 20), after = evaluate(rl, s, 20);
  const rlCost = fresh.items.filter(it => isRL(it.card)).reduce((a, it) => a + it.target * it.buy, 0);
  close(before.rows[0].total - after.rows[0].total, rlCost, 1e-9);
  assert.ok(after.best <= before.best, `best went from ${before.best} to ${after.best}`);

  // The simulation honours the collection too.
  const sims = simulate(rl, s, 2, 2000, 7);
  const mean = sims[2].reduce((a, b) => a + b, 0) / sims[2].length;
  close(mean, after.rows[2].total, Math.max(2, after.rows[2].total * 0.005), 'simulated B=2');
});

test('trading duplicate rares/legendaries is capped by what you are missing', () => {
  const cards = toySet();
  const noTrade = { ...DEFAULTS, boxPrice: 70, tradePct: 0 };
  const trade = { ...DEFAULTS, boxPrice: 70, tradePct: 90 };
  const plain = evaluate(prepare(cards, noTrade), noTrade, 12);
  const prep = prepare(cards, trade);
  const ev = evaluate(prep, trade, 12);
  for (const r of ev.rows) {
    assert.ok(r.traded >= 0 && r.total <= plain.rows[r.B].total + 1e-9, `B=${r.B}`);
    close(r.total, plain.rows[r.B].total - r.traded, 1e-6, `B=${r.B} credit`);
  }
  assert.equal(ev.rows[0].traded, 0); // no boxes, no duplicates
  assert.ok(ev.rows[12].traded > 50, 'lots of boxes means lots of trade bait');

  // The normal approximation tracks the exact per-opening cap in the simulation.
  const sims = simulate(prep, trade, 12, 3000, 5);
  for (const B of [2, 5, 8, 12]) {
    const mean = sims[B].reduce((a, b) => a + b, 0) / sims[B].length;
    close(mean, ev.rows[B].total, Math.max(3, ev.rows[B].total * 0.01), `B=${B}`);
  }

  // Spare owned copies are trade bait from the start: at zero boxes the credit is exactly min(T, N).
  const rl = cards.filter(c => c.r === 'L');
  const owned = { [rl[0].n]: 6, [rl[1].n]: 3 }; // 3 spare legendaries, one complete
  const p2 = prepare(cards, trade, owned);
  const T = 3 * 0.9 * 18;
  const N = p2.items.filter(it => it.receives).reduce((a, it) => a + it.need * it.buy, 0);
  close(evaluate(p2, trade, 0).rows[0].traded, Math.min(T, N), 1e-9);

  // Trading is pointless when you'd resell for at least as much.
  assert.equal(prepare(cards, { ...trade, resalePct: 90 }).trade, null);
});

test('a want list: skipped cards drop out of the goal and their pulls become extras', () => {
  const cards = toySet();
  const noTrade = { ...DEFAULTS, boxPrice: 70, tradePct: 0 };
  const trade = { ...DEFAULTS, boxPrice: 70, tradePct: 80 };
  const legendaries = cards.filter(c => c.r === 'L');
  // Only want 4 of the 20 legendaries and none of the rares.
  const skip = cards.filter(c => c.r === 'R' && c.t !== 'Leader').map(c => c.n).concat(legendaries.slice(4).map(c => c.n));

  const prep = prepare(cards, noTrade, {}, skip);
  const skipped = prep.items.filter(it => skip.includes(it.card.n));
  assert.ok(skipped.every(it => it.target === 0 && it.need === 0 && it.slots.length > 0), 'still in packs, just not wanted');
  const wantedCost = prep.items.reduce((a, it) => a + it.target * it.buy, 0);
  close(evaluate(prep, noTrade, 0).rows[0].total, wantedCost, 1e-9);

  // Wanting less never makes boxes more attractive when extras are worthless...
  const all = evaluate(prepare(cards, noTrade), noTrade, 20);
  const some = evaluate(prep, noTrade, 20);
  assert.ok(some.best <= all.best, `best went from ${all.best} to ${some.best}`);

  // ...but with trading, every unwanted rare/legendary pulled is trade bait.
  const tp = prepare(cards, trade, {}, skip);
  const withSkip = evaluate(tp, trade, 6), without = evaluate(prepare(cards, trade), trade, 6);
  assert.ok(withSkip.rows[2].traded > without.rows[2].traded, 'unwanted pulls feed trades');
  const sims = simulate(tp, trade, 6, 3000, 9);
  for (const B of [1, 3, 6]) {
    const mean = sims[B].reduce((a, b) => a + b, 0) / sims[B].length;
    close(mean, withSkip.rows[B].total, Math.max(3, withSkip.rows[B].total * 0.01), `B=${B}`);
  }
});

test('parseList reads counts, numbers, names, set codes and CSV exports', () => {
  const cards = [
    { n: 17, name: 'Darth Vader - Commanding the First Legion' },
    { n: 18, name: 'Darth Vader - Victor Squadron Leader' },
    { n: 45, name: 'Grogu - Irresistible' },
    { n: 99, name: 'BB-8 - Happy Beeps' },
    { n: 120, name: '4-LOM - Bounty Hunter for Hire' },
  ];
  const info = { abbr: 'HMW', name: 'Homeworlds', codes: ['SOR', 'HMW', 'LAW'] };
  const text = [
    '3 017',
    '2x Darth Vader - Victor Squadron Leader',
    'Grogu x2',
    'grogu (1)',               // same card again: counts add up
    '1 HMW 120',
    'BB-8 - Happy Beeps',      // "BB" is not a set code
    '2 SOR 017',               // other set: skipped
    '1 Luke Skywalker',        // not in this set
    '1 Darth Vader',           // ambiguous
    '1 Grogu - Irresistible (Hyperspace) [HMW]',
  ].join('\n');
  const r = parseList(text, cards, info);
  assert.deepEqual(r.counts, { 17: 3, 18: 2, 45: 4, 99: 1, 120: 1 });
  assert.equal(r.otherSet, 1);
  assert.deepEqual(r.unmatched.map(u => u.line), ['1 Luke Skywalker', '1 Darth Vader']);
  assert.match(r.unmatched[1].reason, /matches 2 cards/);

  const csv = 'Set,Card Number,Name,Count,Foil\nHMW,017,"Darth Vader - Commanding the First Legion",2,false\nHMW,017,,1,true\nLAW,045,Grogu,3,false\nHomeworlds,,Grogu - Irresistible,1,false';
  assert.deepEqual(parseList(csv, cards, info).counts, { 17: 3, 45: 1 });

  // formatList round-trips through parseList, want list included
  const owned = { 17: 3, 45: 1, 120: 2 };
  const exported = formatList(owned, cards, 'HMW', [17, 18, 99]);
  assert.match(exported, /^Not wanted: 17-18, 99$/m);
  const back = parseList(exported, cards, info);
  assert.deepEqual(back.counts, owned);
  assert.deepEqual(back.skip, [17, 18, 99]);
  assert.equal(parseList('3 017', cards, info).skip, null); // no line, no change to the want list
});

test('normalizeSet merges token-backed bases, maps hyperspace by name, skips tokens', () => {
  const prod = (productId, name, rarity, number, type) => ({
    productId, name, url: `https://www.tcgplayer.com/product/${productId}`, imageUrl: '',
    extendedData: rarity ? [{ name: 'Rarity', value: rarity }, { name: 'Number', value: number }, { name: 'CardType', value: type }] : [],
  });
  const products = [
    prod(1, 'Remote Village // Shield', 'Common', '020 // T02', 'Base'),
    prod(2, 'Remote Village // Experience', 'Common', '020 // T01', 'Base'),
    prod(3, 'Luke Skywalker - Hero', 'Legendary', '100/262', 'Unit'),
    prod(4, 'Luke Skywalker - Hero (Hyperspace)', 'Legendary', '370/262', 'Unit'),
    prod(5, 'Shield', 'Common', 'T02', 'Token'),
    prod(6, 'Shadows - Booster Display', null),
    prod(7, 'Shadows Carbonite Edition - Booster Display', null),
    prod(8, 'Shadows - Booster Case', null),
  ];
  const prices = [
    { productId: 1, subTypeName: 'Normal', marketPrice: 0.3, lowPrice: 0.1, midPrice: 0.2 },
    { productId: 2, subTypeName: 'Normal', marketPrice: 0.2, lowPrice: 0.15, midPrice: 0.25 },
    { productId: 3, subTypeName: 'Normal', marketPrice: 20, lowPrice: 18, midPrice: 21 },
    { productId: 3, subTypeName: 'Foil', marketPrice: 30, lowPrice: 28, midPrice: 31 },
    { productId: 4, subTypeName: 'Normal', marketPrice: 45, lowPrice: 40, midPrice: 50 },
    { productId: 6, subTypeName: 'Normal', marketPrice: 70, lowPrice: 65, midPrice: 72 },
    { productId: 7, subTypeName: 'Normal', marketPrice: 200, lowPrice: 190, midPrice: 210 },
    { productId: 8, subTypeName: 'Normal', marketPrice: 400, lowPrice: 390, midPrice: 410 },
  ];
  const set = normalizeSet(products, prices);
  assert.equal(set.cards.length, 2);
  const base = set.cards.find(c => c.n === 20);
  assert.equal(base.name, 'Remote Village');
  assert.deepEqual(base.p.normal, { m: 0.2, l: 0.1, mid: 0.2 });
  const luke = set.cards.find(c => c.n === 100);
  assert.equal(luke.p.hs.m, 45);
  assert.equal(luke.p.foil.m, 30);
  assert.equal(set.sealed.standard.display.price.m, 70);
  assert.equal(set.sealed.standard.case.price.m, 400);
  assert.equal(set.sealed.carbonite.display.price.m, 200);
});

test('new sets: unknown variant words, unknown rarities and booster detection', () => {
  const card = (productId, name, rarity, number) => ({
    productId, name, extendedData: [{ name: 'Rarity', value: rarity }, { name: 'Number', value: number }, { name: 'CardType', value: 'Unit' }],
  });
  const products = [
    card(1, 'Grogu - Irresistible', 'Rare', '045/300'),
    card(2, 'Grogu - Irresistible (Starlight)', 'Rare', '412/300'),  // variant word we've never seen
    card(3, 'Grogu - Irresistible (Hyperspace)', 'Rare', '345/300'),
    card(4, 'Kylo Ren - Unleashed', 'Mythic', '046/300'),           // rarity we've never seen
    card(5, 'The Mandalorian (Unmasked)', 'Common', '047/300'),     // parentheses, but no plain card of that name
  ];
  const prices = [{ productId: 3, subTypeName: 'Normal', marketPrice: 9, lowPrice: 8, midPrice: 9 }];
  const set = normalizeSet(products, prices);
  assert.deepEqual(set.cards.map(c => `${c.n} ${c.name}`), ['45 Grogu - Irresistible', '47 The Mandalorian (Unmasked)']);
  assert.equal(set.cards[0].p.hs.m, 9);
  assert.deepEqual(set.unknownRarities, { Mythic: 1 });

  const sealed = name => ({ productId: 0, name, extendedData: [] });
  assert.equal(hasBoosters([sealed('Icons 2027 Edition - Booster Display'), sealed('Icons 2027 Edition - Starter Box')]), true);
  assert.equal(hasBoosters([sealed('Twin Suns - Blood Brothers Deck'), card(9, 'X', 'Rare', '1')]), false);
  assert.equal(hasBoosters([sealed('Intro Battle: Hoth - Learn to Play Kit')]), false);
});
