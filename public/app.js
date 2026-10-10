import { DEFAULTS, prepare, evaluate, detail, simulateDetailed, quantile, targetFor } from './model.js';
import { parseList, formatList, norm } from './collection.js';

const MAX_BOXES = 60;
const TRIALS = 400;
const RARITY_NAME = { C: 'Common', U: 'Uncommon', R: 'Rare', L: 'Legendary', S: 'Special' };
const RARITY_ORDER = ['C', 'U', 'R', 'L', 'S'];

const $ = sel => document.querySelector(sel);
const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = v => usd0.format(Math.round(v) === 0 ? 0 : v);
const cents = v => usd2.format(v);
const dollars = v => (v < 9.995 ? cents(v) : money(v)); // keep small amounts from reading as $0
const pct = v => (v >= 0.995 ? '>99%' : v < 0.005 ? '<1%' : `${Math.round(v * 100)}%`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const boxes = n => plural(n, 'box', 'boxes');
const moreBoxes = n => plural(n, 'more box', 'more boxes');
// Cash still going to singles after trades, minus what extras sell for.
const netSingles = r => r.singles - r.traded - r.resale;
const safeUrl = u => (typeof u === 'string' && u.startsWith('https://www.tcgplayer.com/') ? u : null);

// ---------- storage (per-browser conveniences only; the collection lives on the server) ----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

const savedRarities = load('swu-opt-coll-r', null);
const state = {
  sets: [],
  set: null,
  settings: { ...DEFAULTS, ...load('swu-opt-settings', {}) },
  boxPrice: load('swu-opt-box', {}), // groupId -> user-entered price
  collection: { sets: {} },          // groupId -> { abbr, name, cards: { n: copies } }
  collectionError: null,
  owned: {},                          // the current set's cards: n -> copies
  skip: new Set(),                    // the current set's cards left out of the goal
  coll: {
    rarities: Array.isArray(savedRarities) ? savedRarities : ['R', 'L'],
    show: 'all',
    sort: load('swu-opt-coll-sort', 'n'),
    q: '',
  },
  undo: null,
  tab: location.hash === '#collection' ? 'collection' : 'plan',
  selectedB: null,
  showAll: false,
  view: null,
};

// ---------- tiny DOM helpers ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
// replaceChildren() would print a literal "null" for skipped optional pieces.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  if (text != null) el.textContent = text;
  return el;
}

// ---------- settings form ----------
const fields = [...document.querySelectorAll('[data-key]')];

function writeForm() {
  for (const el of fields) {
    const v = state.settings[el.dataset.key];
    if (el.dataset.kind === 'bool') el.checked = !!v;
    else if (el.dataset.kind === 'every') el.value = v > 0 ? +(1 / v).toFixed(2) : '';
    else el.value = v;
  }
}

function readForm() {
  for (const el of fields) {
    const key = el.dataset.key;
    if (el.dataset.kind === 'bool') state.settings[key] = el.checked;
    else if (el.dataset.kind === 'select') state.settings[key] = el.value;
    else {
      const n = parseFloat(el.value);
      if (!Number.isFinite(n) || n < 0) continue; // keep last good value while typing
      state.settings[key] = el.dataset.kind === 'every' ? (n >= 1 ? 1 / n : state.settings[key]) : n;
    }
  }
  save('swu-opt-settings', state.settings);
}

let timer;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(recompute, 120);
}

// Settings can change targets (copies wanted), so the collection view redraws too.
let collTimer;
function scheduleCollection() {
  clearTimeout(collTimer);
  collTimer = setTimeout(renderCollection, 120);
}

for (const el of fields) {
  el.addEventListener(el.dataset.kind === 'bool' || el.dataset.kind === 'select' ? 'change' : 'input', () => {
    readForm();
    schedule();
    scheduleCollection();
  });
}

$('#reset').addEventListener('click', () => {
  state.settings = { ...DEFAULTS };
  if (state.set) delete state.boxPrice[state.set.groupId];
  save('swu-opt-settings', state.settings);
  save('swu-opt-box', state.boxPrice);
  writeForm();
  renderBoxControls();
  state.selectedB = null;
  recompute();
  renderCollection();
});

// ---------- box price ----------
function sealedPrices() {
  const std = state.set?.sealed?.standard || {};
  const display = std.display?.price;
  const casePrice = std.case?.price?.m;
  const out = [];
  if (display?.m) out.push({ label: 'Market', value: display.m });
  if (display?.l) out.push({ label: 'Lowest listing', value: display.l });
  if (casePrice) out.push({ label: 'Case ÷ 6', value: casePrice / 6 });
  return out;
}

function boxPrice() {
  const custom = state.set && state.boxPrice[state.set.groupId];
  if (custom > 0) return custom;
  return sealedPrices()[0]?.value ?? 0;
}

function renderBoxControls() {
  const input = $('#boxPrice');
  const price = boxPrice();
  input.value = price ? price.toFixed(2) : '';
  const chips = $('#boxChips');
  chips.replaceChildren(...sealedPrices().map(opt => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': Math.abs(opt.value - price) < 0.005 ? 'true' : 'false',
    onclick: () => { state.boxPrice[state.set.groupId] = +opt.value.toFixed(2); save('swu-opt-box', state.boxPrice); renderBoxControls(); recompute(); },
  }, `${opt.label} ${cents(opt.value)}`)));
}

$('#boxPrice').addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (!state.set) return;
  if (Number.isFinite(v) && v > 0) state.boxPrice[state.set.groupId] = v;
  else delete state.boxPrice[state.set.groupId];
  save('swu-opt-box', state.boxPrice);
  for (const chip of document.querySelectorAll('#boxChips .chip')) chip.setAttribute('aria-pressed', 'false');
  schedule();
});

// ---------- data loading ----------
async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// Two ways to run:
//  - server: `npm start`. Prices proxied live from TCGCSV; your cards saved in data/collection.json.
//  - static: the GitHub Pages build (`npm run build`). Prices pre-fetched daily into data/*.json;
//    each visitor's cards saved in their own browser. Paths stay relative so it works under /<repo>/.
const STATIC = document.querySelector('meta[name="app-mode"]')?.content === 'static';
const LOCAL_COLLECTION = 'swu-opt-collection';

const source = STATIC ? {
  sets: () => api('data/sets.json'),
  set: groupId => api(`data/set-${groupId}.json`),
  collection: async () => load(LOCAL_COLLECTION, { sets: {} }),
  save: async () => {
    try { localStorage.setItem(LOCAL_COLLECTION, JSON.stringify({ sets: state.collection.sets })); }
    catch { throw new Error('this browser won’t store data (private window?)'); }
  },
} : {
  sets: refresh => api(`/api/sets${refresh ? '?refresh=1' : ''}`),
  set: (groupId, refresh) => api(`/api/set/${groupId}${refresh ? '?refresh=1' : ''}`),
  collection: () => api('/api/collection'),
  save: (groupId, keepalive = false) => api(`/api/collection/${groupId}`, {
    method: 'PUT', keepalive, headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(state.collection.sets[groupId] ?? { cards: {} }),
  }),
};

if (STATIC) {
  $('#refresh').hidden = true; // the site rebuilds with fresh prices every day
  for (const el of document.querySelectorAll('.static-only')) el.hidden = false;
}

function notice(...kids) {
  $('#notice').replaceChildren(...kids.filter(Boolean).map(k => h('div', { class: 'notice' }, k)));
}

async function loadSets(refresh = false) {
  const { sets } = await source.sets(refresh);
  const today = new Date().toISOString().slice(0, 10);
  state.sets = sets;
  const select = $('#set');
  select.replaceChildren(...sets.map(set => h('option', { value: set.groupId },
    `${set.name}${set.abbr ? ` (${set.abbr})` : ''}${set.publishedOn > today ? ' · upcoming' : ''}`)));
  const fromUrl = (new URLSearchParams(location.search).get('set') || '').toLowerCase();
  const remembered = load('swu-opt-set', null);
  const pick = sets.find(x => fromUrl && (x.abbr.toLowerCase() === fromUrl || String(x.groupId) === fromUrl))
    || sets.find(x => x.groupId === remembered) || sets.find(x => x.publishedOn <= today) || sets[0];
  if (pick) select.value = pick.groupId;
}

async function loadCollection() {
  try {
    const body = await source.collection();
    state.collection = { ...body, sets: body?.sets || {} };
  } catch (err) {
    state.collectionError = err.message;
  }
}

async function loadSet(refresh = false) {
  const groupId = Number($('#set').value);
  if (!groupId) return;
  document.body.classList.add('loading');
  try {
    state.set = await source.set(groupId, refresh);
    state.set.groupId = groupId;
    save('swu-opt-set', groupId);
    const abbr = setMeta()?.abbr;
    if (abbr) history.replaceState(null, '', `?set=${encodeURIComponent(abbr)}${location.hash}`);
    const asof = state.set.pricesAsOf ? new Date(state.set.pricesAsOf) : null;
    $('#asof').textContent = asof ? `TCGPlayer prices as of ${asof.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : '';
    state.owned = { ...(state.collection.sets[groupId]?.cards ?? {}) };
    state.skip = new Set(state.collection.sets[groupId]?.skip ?? []);
    state.undo = null;
    state.coll.q = '';
    $('#collSearch').value = '';
    $('#quickAdd').replaceChildren();
    $('#importResult').replaceChildren();
    state.selectedB = null;
    state.showAll = false;
    renderBoxControls();
    recompute();
    renderCollection();
    if (state.collectionError) saveStatus(`Couldn't load your saved collection: ${state.collectionError}`, true);
  } catch (err) {
    notice(h('span', {}, h('strong', {}, 'Couldn’t load this set. '), err.message));
    state.view = null;
    updateVisibility();
  } finally {
    document.body.classList.remove('loading');
  }
}

$('#set').addEventListener('change', () => loadSet());
$('#refresh').addEventListener('click', async () => {
  const btn = $('#refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try { await loadSet(true); } finally { btn.disabled = false; btn.textContent = 'Refresh prices'; }
});

const setMeta = () => state.sets.find(x => x.groupId === state.set?.groupId);
const setName = () => setMeta()?.name ?? 'this set';

// ---------- compute ----------
function recompute() {
  const set = state.set;
  if (!set) return;
  const st = state.settings;
  const rawBox = boxPrice();

  const warnings = [];
  if (set.stale) warnings.push(h('span', {}, h('strong', {}, 'Offline: '), 'showing cached prices (', set.staleReason, ').'));
  const ageDays = set.pricesAsOf ? (Date.now() - Date.parse(set.pricesAsOf)) / 86400000 : 0;
  if (ageDays > 3 && set.cards.length) { // a set with nothing listed has nothing to update
    warnings.push(h('span', {}, h('strong', {}, `These prices are ${Math.floor(ageDays)} days old. `),
      STATIC ? 'The daily price update may have stopped.' : 'TCGCSV may not be updating; try Refresh prices.'));
  }
  if (!set.cards.length) {
    // Announced sets show up before TCGPlayer lists their cards.
    warnings.push(h('span', {}, h('strong', {}, 'TCGPlayer hasn’t listed this set’s cards yet. '), 'Check back closer to release.'));
    notice(...warnings);
    state.view = null;
    updateVisibility();
    renderCollPlan();
    return;
  }
  if (set.missing?.length) {
    const most = set.printedSize && set.missing.length > set.printedSize / 4;
    warnings.push(most
      ? h('span', {}, h('strong', {}, `Only ${set.cards.length} of ${set.printedSize} cards are on TCGPlayer so far. `),
        'Treat this as a rough early look: the answer will change as the rest are listed.')
      : h('span', {}, h('strong', {}, `${plural(set.missing.length, 'card')} not on TCGPlayer yet `),
        `(#${compactRanges(set.missing)}). They're left out, so the totals are a little low.`));
  }
  const unknown = Object.entries(set.unknownRarities || {});
  if (unknown.length) {
    const count = unknown.reduce((a, [, c]) => a + c, 0);
    warnings.push(h('span', {}, h('strong', {}, `${plural(count, 'card')} with a rarity this app doesn’t know `),
      `(${unknown.map(([r]) => r).join(', ')}) are left out, along with their pull rates.`));
  }
  if (!(rawBox > 0)) {
    warnings.push(h('span', {}, h('strong', {}, 'No booster box price found for this set. '), 'Enter one on the left to get a recommendation.'));
    notice(...warnings);
    state.view = null;
    updateVisibility();
    renderCollPlan();
    return;
  }
  notice(...warnings);

  const sx = { ...st, boxPrice: Math.max(0, rawBox - (st.hitValue || 0)) };
  const prep = prepare(set.cards, sx, state.owned, state.skip);
  const ev = evaluate(prep, sx, MAX_BOXES);
  const maxShown = Math.min(MAX_BOXES, Math.max(10, ev.best * 2 + 4, state.selectedB ?? 0));

  const every = 1 / st.legendaryRate;
  const sens = [Math.max(2, every - 2), every + 2].map(e => {
    const alt = { ...sx, legendaryRate: 1 / e };
    return { every: e, best: evaluate(prepare(set.cards, alt, state.owned, state.skip), alt, MAX_BOXES).best };
  });

  const own = ownedStats(prep);
  let baseline = null; // the same plan as if you owned nothing
  if (own.copies) {
    const fresh = evaluate(prepare(set.cards, sx, {}, state.skip), sx, MAX_BOXES);
    baseline = { best: fresh.best, total: fresh.rows[fresh.best].total };
  }
  let noTrade = null; // the same plan if you never traded
  if (prep.trade) {
    const alt = { ...sx, tradePct: 0 };
    const plain = evaluate(prepare(set.cards, alt, state.owned, state.skip), alt, MAX_BOXES);
    noTrade = { best: plain.best, total: plain.rows[plain.best].total };
  }

  // The simulation is the slow part, so it waits until the Plan tab needs it.
  const goal = { wanted: prep.items.filter(it => it.target > 0).length, total: prep.items.length, picked: state.skip.size > 0 };
  let fullSet = null; // the same plan if you wanted every card
  if (goal.picked) {
    const whole = evaluate(prepare(set.cards, sx, state.owned), sx, MAX_BOXES);
    fullSet = { best: whole.best, total: whole.rows[whole.best].total };
  }
  state.view = { prep, ev, sx, rawBox, maxShown, bands: null, sens, own, baseline, noTrade, goal, fullSet };
  updateVisibility();
  render();
}

function ensureBands(v) {
  if (v.bands) return;
  const sims = simulateDetailed(v.prep, v.sx, v.maxShown, TRIALS, 20261010);
  v.bands = sims.totals.map((arr, b) => ({
    p10: quantile(arr, 0.1), p90: quantile(arr, 0.9),
    s10: quantile(sims.singles[b], 0.1), s90: quantile(sims.singles[b], 0.9),
  }));
}

function ownedStats(prep) {
  let copies = 0, target = 0, saves = 0;
  for (const it of prep.items) { copies += it.have; target += it.target; saves += it.have * it.buy; }
  return { copies, target, saves };
}

function compactRanges(nums) {
  const out = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    out.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return out.join(', ');
}

// ---------- tabs ----------
function syncTabs(focus = false) {
  for (const [sel, tab] of [['#tabPlan', 'plan'], ['#tabColl', 'collection']]) {
    const btn = $(sel);
    btn.setAttribute('aria-selected', String(tab === state.tab));
    btn.tabIndex = tab === state.tab ? 0 : -1;
    if (focus && tab === state.tab) btn.focus();
  }
  updateVisibility();
}

function updateVisibility() {
  $('#output').hidden = state.tab !== 'plan' || !state.view;
  $('#collection').hidden = state.tab !== 'collection' || !state.set;
}

function setTab(tab, focus = false) {
  state.tab = tab;
  history.replaceState(null, '', location.pathname + location.search + (tab === 'collection' ? '#collection' : ''));
  syncTabs(focus);
  if (tab === 'plan') render();
  else { renderCollection(); renderCollPlan(); }
}

$('#tabPlan').addEventListener('click', () => setTab('plan'));
$('#tabColl').addEventListener('click', () => setTab('collection'));
$('.tabs').addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  setTab(state.tab === 'plan' ? 'collection' : 'plan', true);
});

window.addEventListener('hashchange', () => {
  const tab = location.hash === '#collection' ? 'collection' : 'plan';
  if (tab !== state.tab) setTab(tab);
});

function goToCollection() {
  setTab('collection');
  $('.tabs').scrollIntoView({ block: 'nearest' });
}

// ---------- render: plan ----------
function render() {
  renderCollPlan();
  const v = state.view;
  if (!v || state.tab !== 'plan') return;
  ensureBands(v);
  const B = Math.min(state.selectedB ?? v.ev.best, v.maxShown);
  const d = detail(v.prep, v.sx, B);
  renderHero(v);
  renderWhatIf(v, B, d);
  renderTiles(v);
  renderLegend();
  renderChart(v, B);
  renderBoxTable(v, B);
  renderGroups(d, B, v.ev.rows[B].traded);
  renderCards(d, B, v.ev.rows[B].traded);
}

function renderHero(v) {
  const { ev, sx, sens, own, baseline, noTrade } = v;
  const best = ev.rows[ev.best];
  const net = netSingles(best);
  const owns = own.copies > 0;
  const n = owns ? moreBoxes : boxes;
  const headline = ev.best === 0
    ? h('div', { class: 'headline' }, 'Skip the boxes')
    : h('div', { class: 'headline' }, 'Open ', h('span', { class: 'accent' }, n(ev.best)));
  const trades = best.traded >= 0.5 ? `, after trading about ${money(best.traded)} of duplicates` : '';
  const sub = ev.best === 0
    ? h('div', { class: 'sub' }, `Buying ${owns ? 'the rest' : 'every card'} as singles is cheapest: about ${money(best.total)}${trades}.`)
    : h('div', { class: 'sub' }, `then buy about ${money(net)} in singles${trades}. Expected ${owns ? 'cost from here' : 'total'} ${money(best.total)}.`);
  const { goal: picks } = v;
  const edit = label => h('button', { class: 'linkish', type: 'button', onclick: goToCollection }, label);
  const ownedLine = owns || picks.picked
    ? h('div', { class: 'owned-line' },
      picks.picked ? `Your goal: playsets of ${picks.wanted} of ${picks.total} cards (whole set: ${boxes(v.fullSet.best)}, ${money(v.fullSet.total)}). ` : '',
      owns ? `Counting the ${plural(own.copies, 'copy', 'copies')} you already own (worth ${dollars(own.saves)} in singles). Without them: ${boxes(baseline.best)}, ${money(baseline.total)}. ` : '',
      edit('Edit your cards'))
    : h('div', { class: 'owned-line' }, 'Only need some of these cards, or already own some? ',
      edit('Pick your cards'), ' and the plan only covers what you’re missing.');
  const every = 1 / sx.legendaryRate;
  const sensLine = h('div', { class: 'sens' },
    'Pull-rate check: if legendaries were ',
    ...sens.flatMap((x, i) => [i ? ' or ' : '', h('strong', {}, `1 in ${+x.every.toFixed(1)}`), ` packs → ${boxes(x.best)}`]),
    ` (you're using 1 in ${+every.toFixed(1)}).`,
    noTrade && Math.abs(noTrade.total - best.total) >= 1 ? h('div', { class: 'sens-2' }, 'Trade check: with no trading → ', h('strong', {}, boxes(noTrade.best)), `, ${money(noTrade.total)}.`) : null);
  const goal = sx.copies === 3 ? 'a playset' : `${sx.copies} copies`;
  const which = picks.picked ? `your ${picks.wanted} chosen cards` : 'every card';
  const eyebrow = `Cheapest ${owns ? 'way to finish' : 'path to'} ${goal} of ${which} · ${setName()}`;
  $('#hero').replaceChildren(h('div', {}, h('div', { class: 'eyebrow' }, eyebrow), headline, sub, ownedLine), sensLine);
}

function renderTiles(v) {
  const { ev, bands, sx, rawBox, own } = v;
  const best = ev.rows[ev.best];
  const allSingles = ev.rows[0].total;
  const band = bands[ev.best];
  const next = ev.rows[ev.best + 1];
  const owns = own.copies > 0;
  const tile = (label, value, note) => h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), note && h('div', { class: 'note' }, note));
  $('#tiles').replaceChildren(
    tile(owns ? 'Still to spend' : 'Expected total', money(best.total), band && ev.best > 0 ? `80% of openings: ${money(band.p10)}–${money(band.p90)}` : 'No luck involved'),
    tile(owns ? 'Rest as singles, no boxes' : 'All singles, no boxes', money(allSingles), `${money(allSingles - best.total)} more than the best plan`),
    tile('Box price used', cents(sx.boxPrice), sx.hitValue > 0 ? `${cents(rawBox)} minus ${cents(sx.hitValue)} chase resale` : 'Edit on the left'),
    tile(`Box #${ev.best + 1} would save`, next ? money(next.marginal) : '—', next ? `in singles, but costs ${money(sx.boxPrice)}` : ''),
  );
}

const SERIES = [
  { key: 'total', label: 'Expected total', color: 'var(--series-total)' },
  { key: 'boxCost', label: 'Box spend', color: 'var(--series-box)' },
  { key: 'net', label: 'Singles (after trades & resale)', color: 'var(--series-singles)' },
];

function renderLegend() {
  $('#legend').replaceChildren(
    ...SERIES.map(x => h('span', { class: 'key' }, h('span', { class: 'line', style: `background:${x.color}` }), x.label)),
    h('span', { class: 'key' }, h('span', { class: 'band', style: 'background:rgba(57,135,229,0.18)' }), '80% of simulated openings'),
  );
}

function niceTicks(lo, hi, count = 5) {
  const span = hi - lo || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(st => st >= raw);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let t = min; t <= max + step / 2; t += step) ticks.push(+t.toFixed(6));
  return { ticks, min, max };
}

const axisMoney = v => (Math.abs(v) >= 1000 ? `$${+(v / 1000).toFixed(1)}K` : `$${Math.round(v)}`);

function renderChart(v, B) {
  const host = $('#chart');
  const { ev, bands, maxShown } = v;
  const rows = ev.rows.slice(0, maxShown + 1).map(r => ({ ...r, net: netSingles(r) }));
  const W = Math.max(280, host.clientWidth);
  const H = W < 560 ? 240 : 300;
  const m = { l: 52, r: 18, t: 22, b: 34 };
  const values = rows.flatMap(r => [r.total, r.boxCost, r.net]).concat(bands.flatMap(b => [b.p10, b.p90]));
  const { ticks, min: yMin, max: yMax } = niceTicks(Math.min(0, ...values), Math.max(...values));
  const x = b => m.l + (b / maxShown) * (W - m.l - m.r);
  const y = val => m.t + (1 - (val - yMin) / (yMax - yMin)) * (H - m.t - m.b);

  const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, tabindex: 0, role: 'img',
    'aria-label': `Expected total cost for 0 to ${maxShown} boxes. Lowest at ${boxes(ev.best)}: ${money(rows[ev.best].total)}. Use left and right arrow keys to read values; the Box by box table has every number.` });

  for (const t of ticks) {
    svg.append(s('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), stroke: t === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }));
    svg.append(s('text', { x: m.l - 8, y: y(t) + 4, 'text-anchor': 'end' }, axisMoney(t)));
  }
  const xStep = maxShown <= 12 ? 1 : maxShown <= 30 ? 2 : 5;
  for (let b = 0; b <= maxShown; b += xStep) svg.append(s('text', { x: x(b), y: H - m.b + 18, 'text-anchor': 'middle' }, b));
  svg.append(s('text', { x: W - m.r, y: H - 2, 'text-anchor': 'end' }, 'booster boxes opened'));

  const bandPts = bands.slice(0, maxShown + 1);
  const bandPath = bandPts.map((b, i) => `${i ? 'L' : 'M'}${x(i)},${y(b.p90)}`).join('') +
    bandPts.map((b, i) => [i, b]).reverse().map(([i, b]) => `L${x(i)},${y(b.p10)}`).join('') + 'Z';
  svg.append(s('path', { d: bandPath, fill: 'var(--series-total)', 'fill-opacity': 0.14, stroke: 'none' }));

  for (const ser of [...SERIES].reverse()) {
    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.B)},${y(r[ser.key])}`).join('');
    svg.append(s('path', { d, fill: 'none', stroke: ser.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }

  if (B !== ev.best) svg.append(s('line', { x1: x(B), x2: x(B), y1: m.t, y2: H - m.b, stroke: 'var(--muted)', 'stroke-width': 1 }));

  const bx = x(ev.best), by = y(rows[ev.best].total);
  svg.append(s('circle', { cx: bx, cy: by, r: 5, fill: 'var(--series-total)', stroke: 'var(--surface)', 'stroke-width': 2 }));
  const label = `Best: ${boxes(ev.best)} · ${money(rows[ev.best].total)}`;
  const anchor = bx < W * 0.2 ? 'start' : bx > W * 0.8 ? 'end' : 'middle';
  svg.append(s('text', { class: 'best-label', x: bx, y: Math.max(14, by - 12), 'text-anchor': anchor }, label));

  const cross = s('line', { y1: m.t, y2: H - m.b, stroke: 'var(--ink-2)', 'stroke-width': 1, visibility: 'hidden' });
  const overlay = s('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: 'transparent', style: 'cursor:crosshair' });
  svg.append(cross, overlay);

  const tip = h('div', { class: 'tooltip', hidden: true });
  let focusB = B;
  const show = b => {
    focusB = b;
    const r = rows[b], band = bands[b];
    cross.setAttribute('x1', x(b)); cross.setAttribute('x2', x(b)); cross.setAttribute('visibility', 'visible');
    const row = (color, value, label) => h('div', { class: 'tt-row' }, h('span', { class: 'line', style: color ? `background:${color}` : 'visibility:hidden' }), h('strong', {}, value), h('span', {}, label));
    fill(tip,
      h('div', { class: 'tt-head' }, boxes(b) + (b === ev.best ? ' · best' : '')),
      row(SERIES[0].color, money(r.total), 'expected total'),
      band && b > 0 ? row(null, `${money(band.p10)}–${money(band.p90)}`, '80% range') : null,
      row(SERIES[1].color, money(r.boxCost), 'box spend'),
      row(SERIES[2].color, money(r.net), 'singles'),
    );
    tip.hidden = false;
    const px = x(b);
    const left = px + 14 + 200 > W ? px - 14 - 200 : px + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${m.t}px`;
  };
  const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  const nearest = evt => {
    const rect = svg.getBoundingClientRect();
    const px = (evt.clientX - rect.left) * (W / rect.width);
    return Math.max(0, Math.min(maxShown, Math.round(((px - m.l) / (W - m.l - m.r)) * maxShown)));
  };
  overlay.addEventListener('pointermove', e => show(nearest(e)));
  overlay.addEventListener('pointerleave', hide);
  overlay.addEventListener('click', e => select(nearest(e)));
  svg.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      show(Math.max(0, Math.min(maxShown, focusB + (e.key === 'ArrowRight' ? 1 : -1))));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(focusB);
    }
  });
  svg.addEventListener('blur', hide);

  host.replaceChildren(svg, tip);
}

function select(b) {
  state.selectedB = b;
  state.showAll = false;
  if (state.view && b > state.view.maxShown) recompute(); // simulate further out first
  else render();
}

// ---------- what if I open X boxes? ----------
const currentB = () => Math.min(state.selectedB ?? state.view.ev.best, state.view.maxShown);

function renderWhatIf(v, B, d) {
  const { ev, bands, maxShown } = v;
  const r = ev.rows[B];
  const num = $('#whatIfNum'), range = $('#whatIfRange');
  range.max = maxShown;
  range.value = B;
  if (document.activeElement !== num) num.value = B;
  $('#whatIfUnit').textContent = B === 1 ? 'box?' : 'boxes?';
  const bestBtn = $('#whatIfBest');
  bestBtn.hidden = B === ev.best;
  bestBtn.textContent = `Back to the best (${ev.best})`;

  const band = bands[B];
  const copies = d.groups.reduce((a, g) => a + g.toBuy, 0);
  const top = d.groups.filter(g => g.cost >= 0.5).sort((a, b) => b.cost - a.cost).slice(0, 3);
  const diff = r.total - ev.rows[ev.best].total;
  const stat = (label, value) => h('div', {}, h('dt', {}, label), h('dd', {}, value));
  const notes = [
    B && band ? `80% of openings: ${money(band.s10)}–${money(band.s90)}` : 'Exact: no pulls involved',
    r.traded >= 0.5 ? `after trading about ${money(r.traded)} of duplicates` : null,
    r.resale >= 0.5 ? `about ${money(r.resale)} back from selling extras` : null,
  ].filter(Boolean);
  fill($('#whatIfOut'),
    h('div', { class: 'whatif-main' },
      h('div', { class: 'label' }, B ? `Singles to finish after ${boxes(B)}` : 'Singles to buy with no boxes'),
      h('div', { class: 'big' }, money(r.singles - r.traded)),
      h('div', { class: 'note' }, notes.join(' · '))),
    h('dl', { class: 'whatif-stats' },
      stat('Box spend', money(r.boxCost)),
      stat('Copies missing', B ? `~${Math.round(copies)}` : String(Math.round(copies))),
      stat('Total', money(r.total)),
      stat('vs. best plan', B === ev.best ? 'best' : `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))}`)),
    top.length ? h('div', { class: 'whatif-mix' }, 'Biggest chunks: ',
      ...top.flatMap((g, i) => [i ? ', ' : '', h('strong', {}, g.group), ` ${money(g.cost)}`]),
      '. Full breakdown below.') : null,
  );
}

const pickBoxes = b => { if (state.view) select(Math.max(0, Math.min(MAX_BOXES, Math.round(b)))); };
$('#whatIfRange').addEventListener('input', e => pickBoxes(Number(e.target.value)));
$('#whatIfNum').addEventListener('input', e => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) pickBoxes(v); });
$('#whatIfNum').addEventListener('blur', e => { if (state.view) e.target.value = currentB(); });
$('#whatIfMinus').addEventListener('click', () => state.view && pickBoxes(currentB() - 1));
$('#whatIfPlus').addEventListener('click', () => state.view && pickBoxes(currentB() + 1));
$('#whatIfBest').addEventListener('click', () => { state.selectedB = null; state.showAll = false; render(); });

function renderBoxTable(v, B) {
  const { ev, bands, maxShown, sx } = v;
  const last = Math.min(maxShown, Math.max(ev.best + 5, 8, B));
  const rows = ev.rows.slice(0, last + 1);
  const trades = rows.some(r => r.traded >= 0.5);
  const head = h('thead', {}, h('tr', {},
    h('th', {}, 'Boxes'), h('th', { class: 'n' }, 'Box spend'),
    trades ? h('th', { class: 'n', title: 'Missing rares/legendaries covered by trading duplicates' }, 'Traded') : null,
    h('th', { class: 'n' }, 'Singles'),
    h('th', { class: 'n' }, 'Expected total'), h('th', { class: 'n' }, '80% range'), h('th', { class: 'n', title: 'How much this box cuts the singles bill (incl. trades and resale)' }, 'This box saves')));
  const body = h('tbody', {}, rows.map(r => {
    const band = bands[r.B];
    const cls = ['clickable', r.B === ev.best && 'best', r.B === B && 'selected'].filter(Boolean).join(' ');
    return h('tr', { class: cls, tabindex: 0, onclick: () => select(r.B), onkeydown: e => { if (e.key === 'Enter') select(r.B); } },
      h('td', {}, r.B, r.B === ev.best ? h('span', { class: 'badge' }, 'best') : null),
      h('td', { class: 'n' }, money(r.boxCost)),
      trades ? h('td', { class: 'n' }, r.traded >= 0.5 ? money(r.traded) : '—') : null,
      h('td', { class: 'n' }, money(netSingles(r))),
      h('td', { class: 'n' }, money(r.total)),
      h('td', { class: 'n' }, band && r.B > 0 ? `${money(band.p10)}–${money(band.p90)}` : '—'),
      h('td', { class: 'n' }, r.marginal == null ? '—' : `${money(r.marginal)} ${r.marginal >= sx.boxPrice ? '✓' : '✗'}`));
  }));
  $('#boxTable').replaceChildren(head, body);
}

function renderGroups(d, B, traded) {
  $('#groupTitle').textContent = `Where the singles money goes · ${boxes(B)}`;
  const owns = d.groups.some(g => g.have > 0);
  const fmt = v => v.toFixed(B ? 1 : 0);
  const head = h('thead', {}, h('tr', {},
    h('th', {}, 'Cards'), h('th', { class: 'n' }, 'Copies wanted'), owns ? h('th', { class: 'n' }, 'You have') : null,
    h('th', { class: 'n' }, 'From boxes'), h('th', { class: 'n' }, 'To buy'), h('th', { class: 'n' }, 'Singles cost')));
  const body = h('tbody', {}, d.groups.map(g => h('tr', {},
    h('td', {}, `${g.group} `, h('span', { class: 'sub' }, g.wanted < g.cards ? `(${g.wanted} of ${g.cards})` : `(${g.cards})`), !g.inPacks ? h('div', { class: 'sub' }, 'not in boosters') : null),
    h('td', { class: 'n' }, Math.round(g.target)),
    owns ? h('td', { class: 'n' }, g.have) : null,
    h('td', { class: 'n' }, fmt(g.fromBoxes)),
    h('td', { class: 'n' }, fmt(g.toBuy)),
    h('td', { class: 'n' }, money(g.cost)))));
  const tot = d.groups.reduce((a, g) => ({ target: a.target + g.target, have: a.have + g.have, fromBoxes: a.fromBoxes + g.fromBoxes, toBuy: a.toBuy + g.toBuy, cost: a.cost + g.cost }),
    { target: 0, have: 0, fromBoxes: 0, toBuy: 0, cost: 0 });
  const foot = h('tfoot', {}, h('tr', {},
    h('td', {}, 'Total'), h('td', { class: 'n' }, Math.round(tot.target)), owns ? h('td', { class: 'n' }, tot.have) : null,
    h('td', { class: 'n' }, fmt(tot.fromBoxes)), h('td', { class: 'n' }, fmt(tot.toBuy)), h('td', { class: 'n' }, money(tot.cost))));
  if (traded >= 0.5) {
    const span = owns ? 5 : 4;
    foot.append(
      h('tr', { class: 'trade-row' }, h('td', { colspan: span }, 'Covered by trading duplicates'), h('td', { class: 'n' }, `−${money(traded)}`)),
      h('tr', {}, h('td', { colspan: span }, 'Cash on singles'), h('td', { class: 'n' }, money(tot.cost - traded))));
  }
  $('#groupTable').replaceChildren(head, body, foot);
}

function renderCards(d, B, traded) {
  $('#cardTitle').textContent = B === 0 ? 'Singles to buy · no boxes' : `Singles you'll most likely buy · ${boxes(B)}`;
  $('#cardNote').textContent = traded >= 0.5
    ? `Before trades: about ${money(traded)} of the rares and legendaries here get covered by trading duplicates.`
    : B ? 'Your real list depends on what you pull.' : 'Exactly what you’re missing.';
  const list = d.cards.filter(c => c.short > 0.005);
  const shown = state.showAll ? list : list.slice(0, 25);
  const head = h('thead', {}, h('tr', {},
    h('th', { class: 'n' }, '#'), h('th', {}, 'Card'), h('th', {}, 'Rarity'), h('th', { class: 'n' }, 'Each'),
    h('th', { class: 'n', title: 'Chance you end up short at least one copy' }, 'Need any'),
    h('th', { class: 'n' }, 'Copies'), h('th', { class: 'n' }, 'Expected cost')));
  const body = h('tbody', {}, shown.map(c => {
    const url = safeUrl(c.card.url);
    const kind = c.group === 'Special' ? 'Special · singles only' : c.card.t;
    return h('tr', {},
      h('td', { class: 'n' }, c.card.n),
      h('td', { class: 'name' }, url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, c.card.name) : c.card.name,
        h('div', { class: 'sub' }, c.have ? `${kind} · you have ${c.have}` : kind)),
      h('td', {}, h('span', { class: 'rarity', title: RARITY_NAME[c.card.r] }, c.card.r)),
      h('td', { class: 'n' }, cents(c.buy), c.estimated ? h('div', { class: 'sub' }, 'est.') : null),
      h('td', { class: 'n' }, pct(c.pShort)),
      h('td', { class: 'n' }, B ? c.short.toFixed(2) : c.short.toFixed(0)),
      h('td', { class: 'n' }, cents(c.cost)));
  }));
  $('#cardTable').replaceChildren(head, body);
  const btn = $('#showAll');
  btn.hidden = list.length <= 25;
  btn.textContent = state.showAll ? 'Show top 25' : `Show all ${list.length} cards`;
}

$('#showAll').addEventListener('click', () => { state.showAll = !state.showAll; render(); });

let chartWidth = 0;
new ResizeObserver(([entry]) => {
  const w = Math.round(entry.contentRect.width);
  if (w === chartWidth) return;
  chartWidth = w;
  if (state.view?.bands && !$('#output').hidden) renderChart(state.view, Math.min(state.selectedB ?? state.view.ev.best, state.view.maxShown));
}).observe($('#chart'));

// ---------- collection: saving ----------
const dirty = new Set();
let saveTimer;

function saveStatus(text, error = false) {
  const el = $('#saveStatus');
  el.textContent = text;
  el.classList.toggle('error', error);
}

function markDirty() {
  const g = state.set.groupId;
  const meta = setMeta();
  const cards = Object.fromEntries(Object.entries(state.owned).filter(([, c]) => c > 0));
  const skip = [...state.skip].sort((a, b) => a - b);
  if (Object.keys(cards).length || skip.length) state.collection.sets[g] = { abbr: meta?.abbr, name: meta?.name, cards, skip };
  else delete state.collection.sets[g];
  dirty.add(g);
  saveStatus('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 500);
}

async function flushSaves() {
  const groups = [...dirty];
  dirty.clear();
  try {
    for (const g of groups) await source.save(g);
    if (!dirty.size) saveStatus(STATIC ? 'Saved in this browser' : 'Saved');
  } catch (err) {
    for (const g of groups) dirty.add(g);
    saveStatus(`Not saved: ${err.message}. Retrying…`, true);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSaves, 5000);
  }
}

// Leaving within the save delay: send what's pending (a static save is synchronous anyway).
window.addEventListener('pagehide', () => { for (const g of dirty) source.save(g, true).catch(() => {}); });

// ---------- collection: editing ----------
const have = card => state.owned[card.n] || 0;
const wanted = card => !state.skip.has(card.n);
const baseTarget = card => targetFor(card, state.settings);
const target = card => (wanted(card) ? baseTarget(card) : 0);
const snapshot = label => ({ label, owned: { ...state.owned }, skip: new Set(state.skip) });
const shownPrice = card => { const p = card.p.normal; return p ? p[state.settings.priceField] ?? p.m ?? p.l ?? null : null; };

function changed() {
  markDirty();
  renderCollProgress();
  renderUndo();
  schedule();
}

function setOwned(n, value) {
  const v = Math.max(0, Math.min(99, Math.floor(value)));
  if ((state.owned[n] || 0) === v) return;
  if (v) state.owned[n] = v; else delete state.owned[n];
  changed();
  refreshRow(n);
}

function setWanted(n, on) {
  if (on === !state.skip.has(n)) return;
  if (on) state.skip.delete(n); else state.skip.add(n);
  changed();
  refreshRow(n);
  syncWantAll();
}

function refreshRow(n) {
  const row = document.querySelector(`#collTable tr[data-n="${n}"]`);
  const card = state.set.cards.find(c => c.n === n);
  if (!row || !card) return;
  const active = row.contains(document.activeElement) ? document.activeElement : null;
  const refocus = active?.closest('.seg') ? '.seg [aria-checked="true"]' : active?.matches('.want-box') ? '.want-box' : null;
  const fresh = collRow(card);
  row.replaceWith(fresh);
  if (refocus) fresh.querySelector(refocus)?.focus();
}

// The header checkbox: checked when every shown card is wanted, mixed when some are.
function syncWantAll() {
  const box = $('#wantAll');
  if (!box) return;
  const list = collList();
  const on = list.filter(wanted).length;
  box.checked = list.length > 0 && on === list.length;
  box.indeterminate = on > 0 && on < list.length;
  box.disabled = !list.length;
}

function collList() {
  const { rarities, show, sort } = state.coll;
  const q = state.coll.q.trim();
  let list;
  if (q) {
    const num = /^#?\d+$/.test(q) ? parseInt(q.replace('#', ''), 10) : null;
    const nq = norm(q);
    list = state.set.cards.filter(c => c.n === num || (num == null && nq && norm(c.name).includes(nq)));
  } else {
    list = state.set.cards.filter(c => rarities.includes(c.r));
  }
  if (show === 'missing') list = list.filter(c => have(c) < target(c));
  else if (show === 'owned') list = list.filter(c => have(c) > 0);
  else if (show === 'wanted') list = list.filter(wanted);
  else if (show === 'unwanted') list = list.filter(c => !wanted(c));
  const price = c => shownPrice(c) ?? -1;
  return [...list].sort(sort === 'price' ? (a, b) => price(b) - price(a) || a.n - b.n : (a, b) => a.n - b.n);
}

function stepper(card) {
  // Unwanted cards keep their stepper: copies you own are still trade bait.
  const t = baseTarget(card);
  const hv = have(card);
  if (t === 0) return h('span', { class: 'muted small' }, 'not in your goal');
  const current = Math.min(hv, t);
  const group = h('div', { class: `seg${hv >= t && wanted(card) ? ' full' : ''}`, role: 'radiogroup', 'aria-label': `Copies of ${card.name} you own` });
  for (let v = 0; v <= t; v++) {
    const more = v === t && hv > t;
    group.append(h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(v === current), tabindex: v === current ? 0 : -1, 'data-v': v,
      'aria-label': more ? `${hv} (more than ${t})` : String(v), title: more ? `You have ${hv}` : null,
      onclick: () => setOwned(card.n, v),
    }, more ? `${t}+` : String(v)));
  }
  group.addEventListener('keydown', e => {
    let v = Math.min(have(card), t);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = Math.min(t, v + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = Math.max(0, v - 1);
    else if (e.key === 'Home') v = 0;
    else if (e.key === 'End') v = t;
    else if (/^[0-9]$/.test(e.key)) v = Math.min(t, Number(e.key));
    else return;
    e.preventDefault();
    setOwned(card.n, v);
  });
  return group;
}

function collRow(card) {
  const url = safeUrl(card.url);
  const t = target(card), hv = have(card);
  const price = shownPrice(card);
  const want = wanted(card);
  return h('tr', { 'data-n': card.n, class: [t > 0 && hv >= t && 'complete', !want && 'unwanted'].filter(Boolean).join(' ') || null },
    h('td', { class: 'want' }, h('input', {
      type: 'checkbox', class: 'want-box', checked: want, 'aria-label': `Want a playset of ${card.name}`,
      title: want ? 'In your goal. Uncheck if you don’t need this card.' : 'Not in your goal: any copies you pull are trade bait.',
      onchange: e => setWanted(card.n, e.target.checked),
    })),
    h('td', { class: 'n' }, card.n),
    h('td', { class: 'name' }, url ? h('a', { href: url, target: '_blank', rel: 'noopener' }, card.name) : card.name,
      h('div', { class: 'sub' }, `${RARITY_NAME[card.r]} · ${card.t}`, price != null ? h('span', { class: 'show-sm' }, ` · ${cents(price)}`) : null)),
    h('td', { class: 'n hide-sm' }, price != null ? cents(price) : '—'),
    h('td', { class: 'have' }, stepper(card)));
}

function renderRarityChips() {
  const present = RARITY_ORDER.filter(r => state.set.cards.some(c => c.r === r));
  const searching = !!state.coll.q.trim();
  $('#collRarity').replaceChildren(...present.map(r => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(state.coll.rarities.includes(r)), disabled: searching,
    title: searching ? 'Searching all rarities' : null,
    onclick: () => {
      const on = new Set(state.coll.rarities);
      if (on.has(r)) on.delete(r); else on.add(r);
      state.coll.rarities = RARITY_ORDER.filter(x => on.has(x));
      save('swu-opt-coll-r', state.coll.rarities);
      renderCollection();
    },
  }, RARITY_NAME[r])));
}

function renderCollection() {
  if (!state.set) return;
  renderCollProgress();
  renderUndo();
  if (state.tab !== 'collection') return;
  renderRarityChips();
  $('#collShow').value = state.coll.show;
  $('#collSort').value = state.coll.sort;

  const list = collList();
  const q = state.coll.q.trim();
  $('#collShown').textContent = q
    ? `${plural(list.length, 'match', 'matches')} across all rarities`
    : !state.coll.rarities.length ? 'Pick a rarity to show' : `${plural(list.length, 'card')} shown`;
  const fillable = list.filter(c => have(c) < target(c)).length;
  const clearable = list.filter(c => have(c) > 0).length;
  $('#bulkFull').textContent = `Mark ${fillable === list.length ? 'all ' : ''}${fillable} complete`;
  $('#bulkFull').disabled = !fillable;
  $('#bulkClear').textContent = `Clear ${clearable}`;
  $('#bulkClear').disabled = !clearable;

  const wantAll = h('input', {
    type: 'checkbox', id: 'wantAll', 'aria-label': 'Want every card shown',
    onchange: e => {
      const on = e.target.checked;
      bulk(on ? 'want all' : 'want none', c => { if (on) state.skip.delete(c.n); else state.skip.add(c.n); });
    },
  });
  const head = h('thead', {}, h('tr', {},
    h('th', { class: 'want', title: 'Cards you want playsets of' }, h('label', { class: 'want-head' }, wantAll, h('span', {}, 'Want'))),
    h('th', { class: 'n' }, '#'), h('th', {}, 'Card'), h('th', { class: 'n hide-sm' }, 'Price'), h('th', {}, 'You have')));
  const body = h('tbody', {}, list.length ? list.map(collRow)
    : h('tr', {}, h('td', { colspan: 5, class: 'empty' }, q ? 'No cards match that search.' : 'Nothing to show with these filters.')));
  $('#collTable').replaceChildren(head, body);
  syncWantAll();
}

function renderCollProgress() {
  if (!state.set) return;
  const items = prepare(state.set.cards, state.settings, state.owned, state.skip).items;
  const byR = {};
  let copies = 0, wanted = 0, saves = 0;
  for (const it of items) {
    if (!it.target) continue;
    copies += it.have; wanted += it.target; saves += it.have * it.buy;
    const r = (byR[it.card.r] ??= { have: 0, target: 0 });
    r.have += it.have; r.target += it.target;
  }
  const share = wanted ? copies / wanted : 0;
  const goalCards = items.filter(it => it.target > 0).length;
  fill($('#collProgress'),
    h('div', { class: 'eyebrow' }, `Your cards · ${setName()}`),
    state.skip.size ? h('div', { class: 'goal-line' }, 'Goal: playsets of ', h('strong', {}, `${goalCards} of ${items.length}`), ' cards') : null,
    h('div', { class: 'big' }, String(copies), h('span', { class: 'of' }, ` of ${wanted} copies`)),
    h('div', { class: 'bar', role: 'progressbar', 'aria-label': 'Playset progress', 'aria-valuemin': 0, 'aria-valuemax': wanted, 'aria-valuenow': copies },
      h('span', { style: `width:${(share * 100).toFixed(1)}%` })),
    h('div', { class: 'sub' }, copies
      ? `${pct(share)} of the way to your goal · worth about ${dollars(saves)} in singles.`
      : 'Uncheck cards you don’t need, and enter the ones you already own. Rares and legendaries decide most of the answer.'),
    h('div', { class: 'rarity-stats' }, RARITY_ORDER.filter(r => byR[r]).map(r =>
      h('span', {}, `${RARITY_NAME[r]} `, h('strong', {}, `${byR[r].have}/${byR[r].target}`)))),
  );
  const count = $('#ownedCount');
  count.textContent = copies;
  count.hidden = !copies;
}

function renderCollPlan() {
  const host = $('#collPlan');
  const v = state.view;
  if (!v) {
    host.replaceChildren(h('div', { class: 'muted' }, state.set && !state.set.cards.length
      ? 'This set’s cards aren’t listed on TCGPlayer yet, so there’s no plan to show.'
      : 'Enter a booster box price on the left to get a plan.'));
    return;
  }
  const best = v.ev.rows[v.ev.best];
  const owns = v.own.copies > 0;
  const compare = (label, alt) => h('div', { class: 'muted small' }, `${label}: ${boxes(alt.best)}, ${money(alt.total)}`);
  fill(host,
    h('div', { class: 'eyebrow' }, v.goal.picked ? `Cheapest plan for your ${v.goal.wanted} cards` : owns ? 'With these, your cheapest finish' : 'Cheapest plan'),
    h('div', { class: 'headline-sm' }, v.ev.best ? ['Open ', h('span', { class: 'accent' }, (owns ? moreBoxes : boxes)(v.ev.best))] : 'Skip the boxes'),
    h('div', { class: 'sub' }, v.ev.best
      ? `then about ${money(netSingles(best))} in singles · ${money(best.total)} expected`
      : `buy ${owns ? 'the rest' : 'them'} as singles · about ${money(best.total)}`),
    v.fullSet ? compare('Whole set instead', v.fullSet) : null,
    v.baseline ? compare('Without your collection', v.baseline) : null,
    v.noTrade && Math.abs(v.noTrade.total - best.total) >= 1 ? compare('With no trading', v.noTrade) : null,
    h('button', { class: 'ghost small', type: 'button', onclick: () => setTab('plan') }, 'See the full plan →'),
  );
}

function renderUndo() {
  const btn = $('#undo');
  btn.hidden = !state.undo;
  btn.textContent = state.undo ? `Undo ${state.undo.label}` : '';
}

function bulk(label, apply) {
  const list = collList();
  if (!list.length) return;
  state.undo = snapshot(label);
  for (const card of list) apply(card);
  changed();
  renderCollection();
}

$('#bulkFull').addEventListener('click', () => bulk('mark complete', c => { if (have(c) < target(c)) state.owned[c.n] = target(c); }));
$('#bulkClear').addEventListener('click', () => bulk('clear', c => { delete state.owned[c.n]; }));
$('#undo').addEventListener('click', () => {
  if (!state.undo) return;
  state.owned = state.undo.owned;
  state.skip = state.undo.skip;
  state.undo = null;
  changed();
  renderCollection();
});

let searchTimer;
$('#collSearch').addEventListener('input', e => {
  state.coll.q = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderCollection, 80);
});

function quickAdd(message, error = false) {
  $('#quickAdd').replaceChildren(h('span', { class: error ? 'error' : null }, message));
}

// Type a collector number (or narrow a search to one card) and press Enter: +1 copy.
$('#collSearch').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const q = e.target.value.trim();
  if (!q) return;
  const num = /^#?\d+$/.test(q) ? parseInt(q.replace('#', ''), 10) : null;
  let card = num != null ? state.set.cards.find(c => c.n === num) : null;
  if (num == null) {
    state.coll.q = q;
    const matches = collList();
    if (matches.length === 1) card = matches[0];
  }
  if (!card) {
    quickAdd(num != null ? `There's no card #${num} in this set.` : 'Narrow the search to one card, or type its number, then press Enter.', true);
    return;
  }
  const next = have(card) + 1;
  state.coll.q = q;
  renderCollection();
  setOwned(card.n, next);
  quickAdd(`+1 ${card.name} (#${card.n}). You have ${next}${next >= target(card) && target(card) ? ', a full playset' : ''}.`);
  e.target.select();
});

$('#collShow').addEventListener('change', e => { state.coll.show = e.target.value; renderCollection(); });
$('#collSort').addEventListener('change', e => { state.coll.sort = e.target.value; save('swu-opt-coll-sort', e.target.value); renderCollection(); });

$('#importBtn').addEventListener('click', () => {
  const text = $('#importText').value;
  const meta = setMeta();
  const r = parseList(text, state.set.cards, { abbr: meta?.abbr, name: meta?.name, codes: state.sets.map(x => x.abbr).filter(Boolean) });
  const entries = Object.entries(r.counts);
  const add = $('#importAdd').checked;
  if (entries.length || r.skip) {
    state.undo = snapshot('import');
    for (const [n, count] of entries) {
      const v = Math.min(99, add ? (state.owned[n] || 0) + count : count);
      if (v > 0) state.owned[n] = v; else delete state.owned[n];
    }
    if (r.skip) state.skip = new Set(add ? [...state.skip, ...r.skip] : r.skip);
    changed();
    renderCollection();
  }
  fill($('#importResult'),
    h('p', {},
      entries.length ? `Updated ${plural(entries.length, 'card')} from ${plural(r.matched, 'line')}.` : r.skip ? '' : 'Nothing matched a card in this set.',
      r.skip ? ` Want list: ${plural(r.skip.length, 'card')} not wanted.` : '',
      r.otherSet ? ` Skipped ${plural(r.otherSet, 'line')} for other sets.` : ''),
    r.unmatched.length ? h('div', { class: 'unmatched' },
      h('strong', {}, `Couldn’t match ${plural(r.unmatched.length, 'line')}:`),
      h('ul', {}, r.unmatched.slice(0, 25).map(u => h('li', {}, h('code', {}, u.line), ` · ${u.reason}`))),
      r.unmatched.length > 25 ? h('p', {}, `…and ${r.unmatched.length - 25} more.`) : null) : null,
  );
});

$('#exportBtn').addEventListener('click', async () => {
  const text = formatList(state.owned, state.set.cards, setMeta()?.abbr, state.skip);
  const box = $('#importText');
  box.value = text;
  box.select();
  const count = Object.values(state.owned).filter(c => c > 0).length;
  let copied = false;
  try { await navigator.clipboard.writeText(text); copied = true; } catch { /* clipboard blocked; the text is still in the box */ }
  const what = [count ? plural(count, 'card') : null, state.skip.size ? 'your want list' : null].filter(Boolean).join(' and ');
  $('#importResult').replaceChildren(h('p', {}, what
    ? `${what[0].toUpperCase()}${what.slice(1)} in the box above${copied ? ' and copied to your clipboard' : ''}. Paste it back here (Import list) any time to restore.`
    : 'You haven’t entered any cards or unchecked any for this set yet.'));
});

// ---------- boot ----------
writeForm();
syncTabs();
Promise.all([loadSets(), loadCollection()])
  .then(() => loadSet())
  .catch(err => notice(h('span', {}, h('strong', {}, STATIC ? 'Couldn’t load prices. ' : 'Couldn’t reach the price server. '), err.message)));
