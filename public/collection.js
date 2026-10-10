// Parse a pasted card list into { collector number -> copies } for one set.
// Pure, shared by the browser UI and the Node tests.
//
// Accepts one card per line in whatever shape people tend to have lying around:
//   3 017                 2x Darth Vader - Commanding the First Legion
//   1 HMW 245             Grogu x2          Luke Skywalker (Hyperspace) (1)
// plus CSV/TSV exports with a header row (Count/Quantity + Number and/or Name, optional Set).

export const norm = text => String(text).toLowerCase().normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const VARIANT = /\s*\((?:hyperspace|foil|showcase|prestige|serialized|gold|alternate|alt art|promo|[^)]*foil[^)]*)\)\s*$/i;

function matcher(cards) {
  const byN = new Map(cards.map(c => [c.n, c]));
  const byName = new Map();
  const byTitle = new Map(); // "Darth Vader" without the " - subtitle"; null when ambiguous
  for (const c of cards) {
    byName.set(norm(c.name), c);
    const title = norm(c.name.split(' - ')[0]);
    byTitle.set(title, byTitle.has(title) ? null : c);
  }
  return { byN, byName, byTitle, cards };
}

function findByName(m, text) {
  const q = norm(text.replace(/\s*\/\/.*$/, '').replace(VARIANT, ''));
  if (!q) return { reason: 'no card name or number' };
  if (m.byName.has(q)) return { card: m.byName.get(q) };
  const title = m.byTitle.get(q);
  if (title) return { card: title };
  const hits = m.cards.filter(c => norm(c.name).startsWith(q));
  if (hits.length === 1) return { card: hits[0] };
  if (hits.length > 1 || title === null) return { reason: `matches ${Math.max(hits.length, 2)} cards; add the subtitle or use the number` };
  return { reason: 'no card by that name in this set' };
}

// Set code at the front ("HMW 017", "hmw-17") or in brackets at the end ("... [HMW]").
// Only known set codes count, so a name like "BB-8" isn't mistaken for one.
function splitSetCode(text, set) {
  let code = null;
  let rest = text.replace(/\s*\[([^\]]+)\]\s*$/, (_, c) => { if (set.isCode(c)) code = c; return ''; });
  const lead = rest.match(/^([A-Za-z]{2,4})[\s\-#:]+(?=#?\d)/);
  if (lead && set.isCode(lead[1])) { code = lead[1]; rest = rest.slice(lead[0].length); }
  return { code, rest: rest.trim() };
}

function identify(m, text, set) {
  const { code, rest } = splitSetCode(text, set);
  if (code && !set.isThisSet(code)) return { otherSet: true };
  const num = rest.match(/^#?0*(\d{1,4})(?:\s*\/\s*\d+)?(?:\s+(.*))?$/);
  if (num) {
    const card = m.byN.get(Number(num[1]));
    if (card) return { card };
    if (!num[2]) return { reason: `no card #${num[1]} in this set` };
  }
  return findByName(m, rest);
}

function splitCsv(line, delim) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

const HEAD = {
  count: /^(count|qty|quantity|owned|have|copies|amount|total|quantity owned)$/,
  number: /^(card number|card no|card num|number|no|collector number|card)$/,
  name: /^(card name|name|title|product name)$/,
  set: /^(set|set code|set name|expansion|edition)$/,
};

function parseCsv(lines, m, set) {
  const delim = ['\t', ',', ';'].find(d => lines[0].includes(d));
  if (!delim) return null;
  const header = splitCsv(lines[0], delim).map(norm);
  const col = {};
  for (const [key, re] of Object.entries(HEAD)) {
    const i = header.findIndex(h => re.test(h) && !Object.values(col).includes(header.indexOf(h)));
    if (i >= 0) col[key] = i;
  }
  if (col.number === undefined && col.name === undefined) return null;
  if (col.number !== undefined && header[col.number] === 'card' && col.name === undefined) { col.name = col.number; delete col.number; }
  return lines.slice(1).map(line => {
    const cells = splitCsv(line, delim);
    const count = col.count === undefined ? 1 : parseInt(cells[col.count], 10);
    if (!Number.isFinite(count)) return { line, reason: 'no count' };
    const setCell = col.set === undefined ? '' : cells[col.set];
    if (setCell && !set.isThisSet(setCell)) return { line, otherSet: true };
    let found = { reason: 'no card name or number' };
    if (col.number !== undefined && cells[col.number]) found = identify(m, cells[col.number], set);
    if (!found.card && col.name !== undefined && cells[col.name]) found = findByName(m, cells[col.name]);
    return { line, count, ...found };
  });
}

function parseLine(line, m, set) {
  let count = 1, rest = line;
  let mm = rest.match(/^(\d{1,3})\s*[x×]?\s+(.+)$/i); // "3 017", "2x Darth Vader"
  if (mm) { count = +mm[1]; rest = mm[2]; } else if ((mm = rest.match(/^(.+?)(?:\s[x×]\s*(\d{1,3})|\s*\((\d{1,3})\)|\s*[,;\t]\s*(\d{1,3}))\s*$/i))) {
    count = +(mm[2] ?? mm[3] ?? mm[4]); // "Grogu x2", "Grogu (2)", "Grogu, 2"
    rest = mm[1];
  }
  return { line, count, ...identify(m, rest.trim(), set) };
}

/**
 * @param {string} text   pasted list
 * @param {Array} cards   set cards ({n, name})
 * @param {{abbr?: string, name?: string, codes?: string[]}} setInfo  current set (and every
 *        set code, so rows for other sets are skipped rather than mismatched)
 * @returns {{counts: Object<number, number>, matched: number, unmatched: {line, reason}[], otherSet: number}}
 */
export function parseList(text, cards, setInfo = {}) {
  const m = matcher(cards);
  const mine = [setInfo.abbr, setInfo.name].filter(Boolean).map(norm);
  const codes = new Set((setInfo.codes || []).map(norm));
  const isThisSet = code => {
    const c = norm(code);
    return !mine.length || mine.some(x => c === x || c.split(' ').includes(x) || (x.length > 4 && c.includes(x)));
  };
  const set = { isThisSet, isCode: code => isThisSet(code) || codes.has(norm(code)) };
  let lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('//'));
  // "Not wanted: 1-4, 17" (written by formatList) carries the want list.
  let skip = null;
  lines = lines.filter(line => {
    const wants = line.match(/^not wanted\s*:\s*(.*)$/i);
    if (!wants) return true;
    skip ??= [];
    for (const part of wants[1].split(/[\s,]+/).filter(Boolean)) {
      const [a, b] = part.split(/[-–]/).map(x => parseInt(x, 10));
      if (!Number.isFinite(a)) continue;
      for (let n = a; n <= (Number.isFinite(b) ? Math.min(b, a + 999) : a); n++) if (m.byN.has(n)) skip.push(n);
    }
    return false;
  });
  if (!lines.length) return { counts: {}, matched: 0, unmatched: [], otherSet: 0, skip };
  const looksLikeHeader = !/^\d/.test(lines[0]) && splitCsv(lines[0], ['\t', ',', ';'].find(d => lines[0].includes(d)) ?? '\u0000')
    .some(cell => Object.values(HEAD).some(re => re.test(norm(cell))));
  const rows = (looksLikeHeader && parseCsv(lines, m, set)) || lines.map(line => parseLine(line, m, set));

  const counts = {};
  const out = { counts, matched: 0, unmatched: [], otherSet: 0, skip };
  for (const row of rows) {
    if (row.otherSet) out.otherSet++;
    else if (row.card) {
      out.matched++;
      counts[row.card.n] = Math.min(99, (counts[row.card.n] || 0) + Math.max(0, row.count));
    } else out.unmatched.push({ line: row.line, reason: row.reason });
  }
  return out;
}

/** Collector numbers as "1-4, 17". */
export function compactNumbers(nums) {
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return out.join(', ');
}

/** The inverse of parseList: "3 HMW 017 Name" lines in collector-number order, plus the want list. */
export function formatList(owned, cards, abbr = '', skip = []) {
  const prefix = abbr ? `${abbr} ` : '';
  const lines = cards.filter(c => owned[c.n] > 0)
    .sort((a, b) => a.n - b.n)
    .map(c => `${owned[c.n]} ${prefix}${String(c.n).padStart(3, '0')} ${c.name}`);
  const known = [...skip].filter(n => cards.some(c => c.n === n));
  if (known.length) lines.push(`Not wanted: ${compactNumbers(known)}`);
  return lines.join('\n');
}
