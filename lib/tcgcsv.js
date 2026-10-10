// TCGCSV.com client + normalizer. TCGCSV mirrors TCGPlayer's catalog and prices
// once a day (~20:00 UTC). SWU is TCGPlayer category 79.

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://tcgcsv.com/tcgplayer/79';
const TTL_MS = 6 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

// A group is a booster set when TCGPlayer lists booster packs or displays for it.
// Names aren't reliable ("Icons 2027 Edition" has boosters; "Twin Suns" is a box of
// decks), so new sets are picked up from their products. Promo groups are skipped by
// name only to save requests; they never carry boosters.
const BOOSTER_PRODUCT = /Booster (Pack|Display|Box)$/i;
const PROMO_GROUP = /promos?\b|weekly play|judge/i;

const RARITY = { Common: 'C', Uncommon: 'U', Rare: 'R', Legendary: 'L', Special: 'S' };

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'swu-playset-optimizer (personal use)' } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.json();
  return { results: body.results ?? body, lastModified: res.headers.get('last-modified') };
}

async function cached(cacheDir, name, force, load) {
  const file = path.join(cacheDir, name);
  if (!force) {
    try {
      const stat = await fs.stat(file);
      if (Date.now() - stat.mtimeMs < TTL_MS) return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { /* cache miss */ }
  }
  try {
    const data = await load();
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(data));
    return data;
  } catch (err) {
    // Network trouble: fall back to a stale cache rather than failing outright.
    try {
      const stale = JSON.parse(await fs.readFile(file, 'utf8'));
      return { ...stale, stale: true, staleReason: err.message };
    } catch {
      throw err;
    }
  }
}

export const hasBoosters = products => products.some(p => !ext(p, 'Rarity') && BOOSTER_PRODUCT.test(p.name));

/**
 * Which groups are booster sets, remembered in cache/group-kinds.json. A "yes" is
 * permanent. A "no" is re-checked daily while the group is new or upcoming, since
 * TCGPlayer often lists a set's displays after the group itself appears.
 */
async function boosterGroups(cacheDir, groups, force) {
  const file = path.join(cacheDir, 'group-kinds.json');
  let known = {};
  try { known = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* first run */ }
  const now = Date.now();
  const isRecent = g => !g.publishedOn || Date.parse(g.publishedOn) > now - 120 * DAY_MS;
  let changed = false;
  const out = [];
  for (const g of groups) {
    if (PROMO_GROUP.test(g.name)) continue;
    let kind = known[g.groupId];
    const recheck = !kind || (!kind.booster && isRecent(g) && (force || now - kind.checkedAt > DAY_MS));
    if (recheck) {
      try {
        const { results } = await getJson(`${BASE}/${g.groupId}/products`);
        kind = { booster: hasBoosters(results), name: g.name, checkedAt: now };
        known[g.groupId] = kind;
        changed = true;
      } catch (err) {
        if (!kind) throw err; // offline and never seen: can't tell
      }
    }
    if (kind.booster) out.push(g);
  }
  if (changed) {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(known, null, 1));
  }
  return out;
}

export async function listSets(cacheDir, force = false) {
  return cached(cacheDir, 'sets.json', force, async () => {
    const { results } = await getJson(`${BASE}/groups`);
    const sets = (await boosterGroups(cacheDir, results, force))
      .map(g => ({ groupId: g.groupId, abbr: (g.abbreviation || '').trim(), name: g.name, publishedOn: g.publishedOn?.slice(0, 10) }))
      .sort((a, b) => (b.publishedOn || '').localeCompare(a.publishedOn || ''));
    return { sets };
  });
}

export async function loadSet(cacheDir, groupId, force = false) {
  return cached(cacheDir, `set-${groupId}.json`, force, async () => {
    const [products, prices] = await Promise.all([
      getJson(`${BASE}/${groupId}/products`),
      getJson(`${BASE}/${groupId}/prices`),
    ]);
    return { ...normalizeSet(products.results, prices.results), groupId, pricesAsOf: prices.lastModified, fetchedAt: new Date().toISOString() };
  });
}

function ext(product, key) {
  return product.extendedData?.find(e => e.name === key)?.value ?? null;
}

function priceTriple(p) {
  if (!p) return null;
  const t = { m: p.marketPrice, l: p.lowPrice, mid: p.midPrice };
  return t.m == null && t.l == null && t.mid == null ? null : t;
}

// Keep the cheaper of two price records, field by field (used when one card is
// listed as several products, e.g. bases printed with different token backs).
function cheaper(a, b) {
  if (!a) return b;
  if (!b) return a;
  const pick = k => (a[k] == null ? b[k] : b[k] == null ? a[k] : Math.min(a[k], b[k]));
  return { m: pick('m'), l: pick('l'), mid: pick('mid') };
}

// "Name (Hyperspace Foil)" -> "Hyperspace Foil"; null when there's no trailing parenthetical.
const parenOf = name => name.match(/\(([^)]*)\)\s*$/)?.[1].trim() ?? null;
// Variant words we already know. Unknown ones (a future "(Starlight)") are still caught
// structurally: same name as a base card plus a parenthetical.
const KNOWN_VARIANT = /hyperspace|showcase|prestige|serialized|foil|gold|exclusive|promo|alternate/i;

// "Remote Village // Shield (Hyperspace)" -> "Remote Village"
function baseName(name) {
  return name.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*\/\/.*$/, '').trim();
}

export function normalizeSet(products, prices) {
  const priceOf = new Map(prices.map(p => [`${p.productId}|${p.subTypeName}`, p]));
  const cards = new Map();
  const sealed = {};
  const setSizes = new Map();
  const unknownRarities = {};
  const printings = [];

  for (const prod of products) {
    const rarityName = ext(prod, 'Rarity');
    const normal = priceTriple(priceOf.get(`${prod.productId}|Normal`));
    const foil = priceTriple(priceOf.get(`${prod.productId}|Foil`));

    if (!rarityName) {
      const name = prod.name;
      const kind = /carbonite/i.test(name) ? 'carbonite' : 'standard';
      let slot = null;
      if (/Booster (Display|Box)$/i.test(name)) slot = 'display';
      else if (/Booster Case$/i.test(name)) slot = 'case';
      else if (/(?<!Sleeved )Booster Pack$/i.test(name)) slot = 'pack';
      if (slot) (sealed[kind] ??= {})[slot] = { name, price: normal, url: prod.url };
      continue;
    }

    const numberText = ext(prod, 'Number') || '';
    const type = ext(prod, 'CardType') || 'Other';
    const numMatch = numberText.match(/^\s*(\d+)/);
    if (!numMatch || type === 'Token') continue;
    const r = RARITY[rarityName];
    if (!r) { unknownRarities[rarityName] = (unknownRarities[rarityName] || 0) + 1; continue; }
    printings.push({ prod, r, type, numberText, n: Number(numMatch[1]), paren: parenOf(prod.name), base: baseName(prod.name), normal, foil });
  }

  // Variant printings (Hyperspace etc.) carry their own collector numbers, so they're
  // matched back to the base card by name: a parenthetical name whose base name is a
  // plain card in this set is a variant, whatever the word in the parentheses.
  const plainNames = new Set(printings.filter(x => !x.paren).map(x => x.base));
  const variants = [];
  for (const x of printings) {
    if (x.paren && (plainNames.has(x.base) || KNOWN_VARIANT.test(x.paren))) {
      if (/hyperspace/i.test(x.paren) && !/foil/i.test(x.paren)) variants.push({ name: x.base, price: x.normal });
      continue;
    }
    const total = x.numberText.match(/^\s*\d+\s*\/\s*(\d+)/);
    if (total) setSizes.set(total[1], (setSizes.get(total[1]) || 0) + 1);

    let card = cards.get(x.n);
    if (!card) {
      // A parenthetical that isn't a variant is part of the card's real name.
      const name = x.paren ? x.prod.name.replace(/\s*\/\/.*$/, '').trim() : x.base;
      card = { n: x.n, name, r: x.r, t: x.type, url: x.prod.url, img: x.prod.imageUrl, p: { normal: null, foil: null, hs: null } };
      cards.set(x.n, card);
    }
    card.p.normal = cheaper(card.p.normal, x.normal);
    card.p.foil = cheaper(card.p.foil, x.foil);
  }

  const byName = new Map();
  for (const card of cards.values()) byName.set(card.name, byName.has(card.name) ? null : card);
  for (const v of variants) {
    const card = byName.get(v.name);
    if (card) card.p.hs = cheaper(card.p.hs, v.price);
  }

  const printedSize = Number([...setSizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]) || null;
  const list = [...cards.values()].sort((a, b) => a.n - b.n);
  const have = new Set(list.map(c => c.n));
  const missing = printedSize ? Array.from({ length: printedSize }, (_, i) => i + 1).filter(n => !have.has(n)) : [];

  return { cards: list, sealed, printedSize, missing, unknownRarities };
}
