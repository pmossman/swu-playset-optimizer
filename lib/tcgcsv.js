// TCGCSV.com client + normalizer. TCGCSV mirrors TCGPlayer's catalog and prices
// once a day (~20:00 UTC). SWU is TCGPlayer category 79.

import fs from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://tcgcsv.com/tcgplayer/79';
const TTL_MS = 6 * 60 * 60 * 1000;

// Groups that are promos / one-off products rather than booster sets.
const NON_BOOSTER_GROUP = /promo|convention|exclusive|gift box|championship|judge|gencon|weekly play|intro battle|icons|gamegenic|twin suns/i;

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

export async function listSets(cacheDir, force = false) {
  return cached(cacheDir, 'groups.json', force, async () => {
    const { results } = await getJson(`${BASE}/groups`);
    const sets = results
      .filter(g => !NON_BOOSTER_GROUP.test(g.name))
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

// "Name (Hyperspace Foil)" -> "Hyperspace Foil"; null for the base printing.
function variantOf(name) {
  const m = name.match(/\(([^)]*)\)\s*$/);
  if (!m) return null;
  return /hyperspace|showcase|prestige|serialized|foil|gold|exclusive|promo|alternate/i.test(m[1]) ? m[1].trim() : null;
}

// "Remote Village // Shield (Hyperspace)" -> "Remote Village"
function baseName(name) {
  return name.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s*\/\/.*$/, '').trim();
}

export function normalizeSet(products, prices) {
  const priceOf = new Map(prices.map(p => [`${p.productId}|${p.subTypeName}`, p]));
  const cards = new Map();
  const sealed = {};
  const setSizes = new Map();
  const variants = [];

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

    const r = RARITY[rarityName];
    const numberText = ext(prod, 'Number') || '';
    const type = ext(prod, 'CardType') || 'Other';
    const numMatch = numberText.match(/^\s*(\d+)/);
    if (!r || !numMatch || type === 'Token') continue;
    // Variant printings (Hyperspace etc.) carry their own collector numbers, so
    // they're matched back to the base card by name once all base cards are known.
    const variant = variantOf(prod.name);
    if (variant) {
      if (/^hyperspace$/i.test(variant)) variants.push({ name: baseName(prod.name), price: normal });
      continue;
    }

    const n = Number(numMatch[1]);
    const total = numberText.match(/^\s*\d+\s*\/\s*(\d+)/);
    if (total) setSizes.set(total[1], (setSizes.get(total[1]) || 0) + 1);

    let card = cards.get(n);
    if (!card) {
      card = { n, name: baseName(prod.name), r, t: type, url: prod.url, img: prod.imageUrl, p: { normal: null, foil: null, hs: null } };
      cards.set(n, card);
    }
    card.p.normal = cheaper(card.p.normal, normal);
    card.p.foil = cheaper(card.p.foil, foil);
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

  return { cards: list, sealed, printedSize, missing };
}
