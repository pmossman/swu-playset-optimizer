// Playset cost model. Pure functions, shared by the browser UI and the Node tests.
//
// For each card we know, per booster pack, the chance it shows up in each slot it
// can occupy (common slots, foil slot, ...). Over P packs the number of copies X
// is a sum of independent binomials, so for "need" copies the expected shortfall
// E[max(0, need - X)] only needs P(X = 0 .. need-1), which we compute exactly.
// By linearity of expectation, the expected singles bill is the sum over cards.
//
// Trading is the one non-linear piece: duplicate rares/legendaries can only be
// traded for rares/legendaries you're still missing, so the credit is
// E[min(duplicate value, missing value)]. Both are sums over ~100 nearly
// independent cards, so we take each card's exact mean and variance and treat
// the difference as normal (checked against the pack-by-pack simulation in tests).

export const DEFAULTS = Object.freeze({
  // Boxes
  hitValue: 0,          // resale of chase pulls per box, netted off the box price
  // Goal
  copies: 3,
  leaderCopies: 3,
  baseCopies: 3,
  includeSpecial: true,
  // Singles pricing
  priceField: 'm',      // m = market, l = low listing, mid = mid
  minPrice: 0.10,       // nobody sells a single for less than this
  perCardFee: 0,        // shipping / handling spread across each single bought
  anyPrinting: false,   // allow buying a foil/hyperspace copy if it's cheaper
  tradePct: 80,         // duplicate R/L traded toward missing R/L at this % of market (0 = no trading)
  resalePct: 0,         // % of market you'd recoup selling extra copies
  resaleMin: 1,         // ...but only bother trading/selling extras worth at least this
  // Pack odds (community estimates; FFG doesn't publish exact rates)
  packsPerBox: 24,
  commonsPerPack: 9,
  uncommonsPerPack: 3,
  legendaryRate: 1 / 8, // share of rare slots that hold a legendary
  rareLeaderRate: 1 / 6,// share of leader slots that hold a rare leader
  foilCounts: true,     // foil slot copies count toward playsets
  foilC: 69, foilU: 23, foilR: 7, foilL: 1, // foil slot rarity mix (relative weights)
});

export const GROUPS = ['Leaders', 'Bases', 'Commons', 'Uncommons', 'Rares', 'Legendaries', 'Special'];
const RARITY_GROUP = { C: 'Commons', U: 'Uncommons', R: 'Rares', L: 'Legendaries', S: 'Special' };

export function groupOf(card) {
  if (card.r === 'S') return 'Special';
  if (card.t === 'Leader') return 'Leaders';
  if (card.t === 'Base' && card.r === 'C') return 'Bases';
  return RARITY_GROUP[card.r];
}

function pickPrice(triple, field) {
  if (!triple) return null;
  return triple[field] ?? triple.m ?? triple.mid ?? triple.l ?? null;
}

function rawPrice(card, s) {
  const normal = pickPrice(card.p.normal, s.priceField);
  if (!s.anyPrinting && normal != null) return normal;
  const options = [normal, pickPrice(card.p.hs, s.priceField), pickPrice(card.p.foil, s.priceField)].filter(v => v != null);
  return options.length ? Math.min(...options) : null;
}

function median(values) {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** How many copies of this card the goal calls for. */
export function targetFor(card, s) {
  if (card.r === 'S' && !s.includeSpecial) return 0;
  const perType = card.t === 'Leader' ? s.leaderCopies : card.t === 'Base' ? s.baseCopies : s.copies;
  return Math.max(0, Math.round(perType));
}

/**
 * Turn raw set data + settings into per-card items with slot probabilities and
 * prices, plus the slot pools the Monte Carlo draws from. `owned` maps collector
 * number -> copies already in hand; only the rest (`need`) is left to boxes/singles,
 * and copies beyond the goal (`spare`) are extras from the start. Cards in `skip`
 * (collector numbers) aren't wanted at all: every copy pulled is an extra.
 */
export function prepare(cards, s, owned = {}, skip = null) {
  const skipped = skip instanceof Set ? skip : new Set(skip || []);
  const items = cards.map(card => {
    const group = groupOf(card);
    const target = skipped.has(card.n) ? 0 : targetFor(card, s);
    const count = Math.max(0, Math.floor(owned[card.n] || 0));
    const have = Math.min(target, count);
    return { card, group, target, have, spare: count - have, need: target - have, raw: rawPrice(card, s), slots: [] };
  }).filter(it => it.group);

  // Trading only beats selling-and-buying when it's worth more than resale.
  const tradePct = s.tradePct ?? 0;
  const trading = tradePct > 0 && tradePct > s.resalePct;

  // Cards with no listing at all get the median price of their group, flagged.
  const byGroup = {};
  for (const it of items) if (it.raw != null) (byGroup[it.group] ??= []).push(it.raw);
  for (const it of items) {
    it.estimated = it.raw == null;
    const price = it.estimated ? median(byGroup[it.group] || []) : it.raw;
    it.buy = Math.max(s.minPrice, price) + s.perCardFee;
    const market = it.card.p.normal?.m ?? price;
    it.sell = market >= s.resaleMin ? (s.resalePct / 100) * market : 0;
    // Rares/legendaries you're missing can be traded for; duplicates worth the bother can be traded away.
    it.receives = trading && (it.card.r === 'R' || it.card.r === 'L');
    it.tau = it.receives && market >= s.resaleMin ? (tradePct / 100) * market : 0;
  }

  // Booster slot pools. Special cards come from Spotlight/starter decks, not boosters.
  const idx = pred => items.map((it, i) => (pred(it) ? i : -1)).filter(i => i >= 0);
  const pools = {
    leaderC: idx(it => it.group === 'Leaders' && it.card.r === 'C'),
    leaderR: idx(it => it.group === 'Leaders' && (it.card.r === 'R' || it.card.r === 'L')),
    base: idx(it => it.group === 'Bases'),
    C: idx(it => it.group === 'Commons'),
    U: idx(it => it.group === 'Uncommons'),
    R: idx(it => it.group === 'Rares'),   // includes rare bases, which ride the rare slot
    L: idx(it => it.group === 'Legendaries'),
  };

  const odds = slotOdds(pools, s);
  const addSlot = (pool, perPack) => {
    if (!pool.length || perPack <= 0) return;
    const p = Math.min(1, perPack / pool.length);
    for (const i of pool) items[i].slots.push(p);
  };
  addSlot(pools.leaderC, odds.leaderC);
  addSlot(pools.leaderR, odds.leaderR);
  addSlot(pools.base, pools.base.length ? 1 : 0);
  addSlot(pools.C, s.commonsPerPack);
  addSlot(pools.U, s.uncommonsPerPack);
  addSlot(pools.R, odds.rare);
  addSlot(pools.L, odds.legendary);
  for (const r of ['C', 'U', 'R', 'L']) addSlot(pools[r], odds.foil[r]);

  // A traded duplicate is one you no longer sell, so each $1 of trade credit nets (1 - ratio).
  const trade = trading ? { ratio: s.resalePct / tradePct } : null;
  return { items, pools, odds, trade };
}

/** Per-pack chance of each slot outcome, after dropping outcomes whose pool is empty. */
export function slotOdds(pools, s) {
  const share = (p, haveA, haveB) => (!haveA ? 0 : !haveB ? 1 : p);
  const leaderR = share(s.rareLeaderRate, pools.leaderR.length > 0, pools.leaderC.length > 0);
  const legendary = share(s.legendaryRate, pools.L.length > 0, pools.R.length > 0);
  const foil = { C: 0, U: 0, R: 0, L: 0 };
  if (s.foilCounts) {
    const w = { C: s.foilC, U: s.foilU, R: s.foilR, L: s.foilL };
    let sum = 0;
    for (const r in w) if (pools[r].length && w[r] > 0) sum += w[r];
    for (const r in w) if (sum > 0 && pools[r].length && w[r] > 0) foil[r] = w[r] / sum;
  }
  return {
    leaderR,
    leaderC: pools.leaderC.length ? 1 - leaderR : 0,
    legendary,
    rare: pools.R.length ? 1 - legendary : 0,
    foil,
  };
}

/** P(Binomial(n, p) = k) for k = 0 .. K-1. */
export function binomialHead(n, p, K) {
  const out = new Array(K).fill(0);
  if (K === 0) return out;
  if (p <= 0 || n === 0) { out[0] = 1; return out; }
  if (p >= 1) { if (n < K) out[n] = 1; return out; }
  let b = Math.exp(n * Math.log1p(-p));
  const ratio = p / (1 - p);
  for (let k = 0; k < K; k++) {
    out[k] = b;
    b = k + 1 <= n ? b * ((n - k) / (k + 1)) * ratio : 0;
  }
  return out;
}

/** Distribution head P(X = 0 .. need-1) where X = sum of Binomial(packs, p_s). */
export function countHead(packs, slots, need) {
  let dist = new Array(need).fill(0);
  if (need === 0) return dist;
  dist[0] = 1;
  for (const p of slots) {
    const b = binomialHead(packs, p, need);
    const next = new Array(need).fill(0);
    for (let i = 0; i < need; i++) {
      if (!dist[i]) continue;
      for (let j = 0; i + j < need; j++) next[i + j] += dist[i] * b[j];
    }
    dist = next;
  }
  return dist;
}

/**
 * Expected shortfall and extras (and their second moments, for trading), plus the
 * chance of needing to buy at least one copy. Extras include spare owned copies.
 */
export function cardStats(item, packs) {
  const need = item.need, spare = item.spare || 0;
  const head = countHead(packs, item.slots, need);
  let short = 0, shortSq = 0, pShort = 0;
  for (let k = 0; k < need; k++) { short += (need - k) * head[k]; shortSq += (need - k) ** 2 * head[k]; pShort += head[k]; }
  let mean = 0, variance = 0;
  for (const p of item.slots) { mean += packs * p; variance += packs * p * (1 - p); }
  // extras = (X - o)+ with o = need - spare (only one of need/spare can be non-zero)
  const o = need - spare;
  return { short, shortSq, pShort, mean, extra: mean - o + short, extraSq: Math.max(0, variance + (mean - o) ** 2 - shortSq) };
}

const normPdf = z => Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
function normCdf(z) {
  // Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}
/** E[max(0, D)] for D ~ Normal(mu, sigma²). */
export function expectedPositive(mu, sigma) {
  if (!(sigma > 1e-9)) return Math.max(0, mu);
  const z = mu / sigma;
  return mu * normCdf(z) + sigma * normPdf(z);
}

/** Expected cost for every box count 0..maxBoxes. */
export function evaluate(prep, s, maxBoxes) {
  const rows = [];
  for (let B = 0; B <= maxBoxes; B++) {
    const packs = B * s.packsPerBox;
    let singles = 0, resale = 0;
    let missing = 0, gapMean = 0, gapVar = 0; // missing R/L value N, and N - duplicate trade value
    for (const it of prep.items) {
      const st = cardStats(it, packs);
      singles += it.buy * st.short;
      resale += it.sell * st.extra;
      if (it.receives) {
        const n = it.buy * st.short, t = it.tau * st.extra;
        // n and t are never both non-zero for one card, so E[(n - t)²] has no cross term.
        const sq = it.buy ** 2 * st.shortSq + it.tau ** 2 * st.extraSq;
        missing += n;
        gapMean += n - t;
        gapVar += Math.max(0, sq - (n - t) ** 2);
      }
    }
    // E[min(T, N)] = E[N] - E[(N - T)+]
    const traded = prep.trade ? Math.max(0, missing - expectedPositive(gapMean, Math.sqrt(gapVar))) : 0;
    if (prep.trade) resale -= prep.trade.ratio * traded; // traded duplicates aren't sold
    const boxCost = B * s.boxPrice;
    rows.push({ B, boxCost, singles, traded, resale, total: boxCost + singles - traded - resale });
  }
  for (let i = 0; i < rows.length; i++) rows[i].marginal = i ? rows[i - 1].total - rows[i].total + s.boxPrice : null;
  let best = rows[0];
  for (const r of rows) if (r.total < best.total - 0.005) best = r;
  return { rows, best: best.B };
}

/** Per-group and per-card detail at a given box count. */
export function detail(prep, s, B) {
  const packs = B * s.packsPerBox;
  const groups = Object.fromEntries(GROUPS.map(g => [g, { group: g, cards: 0, wanted: 0, target: 0, have: 0, fromBoxes: 0, toBuy: 0, cost: 0, inPacks: false }]));
  const cards = [];
  for (const it of prep.items) {
    const st = cardStats(it, packs);
    const g = groups[it.group];
    g.cards++;
    if (it.target > 0) g.wanted++;
    g.target += it.target;
    g.have += it.have;
    g.fromBoxes += it.need - st.short;
    g.toBuy += st.short;
    g.cost += it.buy * st.short;
    if (it.slots.length) g.inPacks = true;
    if (it.need > 0) cards.push({ ...it, ...st, cost: it.buy * st.short });
  }
  cards.sort((a, b) => b.cost - a.cost || a.card.n - b.card.n);
  return { groups: GROUPS.map(g => groups[g]).filter(g => g.cards), cards };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Sorted total costs across trials, per box count. */
export function simulate(prep, s, maxBoxes, trials = 400, seed = 1) {
  return simulateDetailed(prep, s, maxBoxes, trials, seed).totals;
}

/**
 * Open real (simulated) packs: distinct commons/uncommons within a pack, one
 * leader, one base, one rare-slot card, one foil. Trades are settled exactly per
 * opening: min(duplicate trade value, missing R/L value). Returns, per box count,
 * the sorted totals and the sorted cash spent on singles (after trades).
 */
export function simulateDetailed(prep, s, maxBoxes, trials = 400, seed = 1) {
  const { items, pools, odds, trade } = prep;
  const rng = mulberry32(seed);
  const n = items.length;
  const need = Int32Array.from(items, it => it.need);
  const buy = Float64Array.from(items, it => it.buy);
  const sell = Float64Array.from(items, it => it.sell);
  const tau = Float64Array.from(items, it => it.tau || 0);
  const receives = Uint8Array.from(items, it => (it.receives ? 1 : 0));
  const ratio = trade?.ratio ?? 0;
  const counts = new Int32Array(n);
  const sum = f => items.reduce((a, it) => a + f(it), 0);
  const baseSingles = sum(it => it.need * it.buy);
  const baseResale = sum(it => (it.spare || 0) * it.sell);
  const baseDupes = sum(it => (it.spare || 0) * (it.tau || 0));
  const baseMissing = sum(it => (it.receives ? it.need * it.buy : 0));
  const totals = Array.from({ length: maxBoxes + 1 }, () => new Float64Array(trials));
  const bills = Array.from({ length: maxBoxes + 1 }, () => new Float64Array(trials));
  const nC = Math.round(s.commonsPerPack), nU = Math.round(s.uncommonsPerPack);
  const foilCum = [];
  let acc = 0;
  for (const r of ['C', 'U', 'R', 'L']) if (odds.foil[r] > 0) { acc += odds.foil[r]; foilCum.push([acc, pools[r]]); }

  const one = pool => pool[Math.floor(rng() * pool.length)];
  const picked = [];

  for (let t = 0; t < trials; t++) {
    counts.fill(0);
    let singles = baseSingles, resale = baseResale, dupes = baseDupes, missing = baseMissing;
    const add = i => {
      const c = counts[i]++;
      if (c < need[i]) { singles -= buy[i]; if (receives[i]) missing -= buy[i]; } else { resale += sell[i]; dupes += tau[i]; }
    };
    const record = b => {
      const traded = trade ? Math.max(0, Math.min(dupes, missing)) : 0;
      totals[b][t] = b * s.boxPrice + singles - traded - (resale - ratio * traded);
      bills[b][t] = singles - traded;
    };
    const addDistinct = (pool, k) => {
      if (k >= pool.length) { for (const i of pool) add(i); return; }
      picked.length = 0;
      while (picked.length < k) {
        const i = one(pool);
        if (!picked.includes(i)) picked.push(i);
      }
      for (const i of picked) add(i);
    };
    record(0);
    for (let b = 1; b <= maxBoxes; b++) {
      for (let p = 0; p < s.packsPerBox; p++) {
        if (pools.leaderR.length && rng() < odds.leaderR) add(one(pools.leaderR));
        else if (pools.leaderC.length) add(one(pools.leaderC));
        if (pools.base.length) add(one(pools.base));
        if (pools.C.length) addDistinct(pools.C, nC);
        if (pools.U.length) addDistinct(pools.U, nU);
        if (pools.L.length && rng() < odds.legendary) add(one(pools.L));
        else if (pools.R.length) add(one(pools.R));
        if (foilCum.length) {
          const u = rng() * acc;
          const hit = foilCum.find(([edge]) => u < edge) || foilCum[foilCum.length - 1];
          add(one(hit[1]));
        }
      }
      record(b);
    }
  }
  const sorted = arrs => arrs.map(arr => arr.sort());
  return { totals: sorted(totals), singles: sorted(bills) };
}

export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
