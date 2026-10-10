// Build the static site for GitHub Pages into ./dist:
//   - the UI from ./public, switched to static mode
//   - data/sets.json and data/set-<groupId>.json, pre-fetched from TCGCSV
//
//   npm run build            uses ./cache when it's fresh (< 6h), like the dev server
//   npm run build -- --fresh always re-downloads (CI does this, since CI=true)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSets, loadSet } from '../lib/tcgcsv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const CACHE = path.join(ROOT, 'cache');
const fresh = process.argv.includes('--fresh') || process.env.CI === 'true';

await fs.rm(OUT, { recursive: true, force: true });
await fs.cp(path.join(ROOT, 'public'), OUT, { recursive: true });

const indexFile = path.join(OUT, 'index.html');
const html = await fs.readFile(indexFile, 'utf8');
const SERVER = '<meta name="app-mode" content="server">';
if (!html.includes(SERVER)) throw new Error('index.html is missing the app-mode meta tag');
await fs.writeFile(indexFile, html.replace(SERVER, '<meta name="app-mode" content="static">'));
await fs.writeFile(path.join(OUT, '.nojekyll'), ''); // serve files as-is, no Jekyll

// Never publish stale or partial prices: any failure fails the build, and Pages keeps
// serving the previous deploy.
const { sets, stale } = await listSets(CACHE, fresh);
if (stale) throw new Error('could not reach TCGCSV for the set list');
await fs.mkdir(path.join(OUT, 'data'));

// On GitHub Actions, flag anything a new set might need a human for, and write a
// summary table onto the run's page.
const CI = !!process.env.GITHUB_ACTIONS;
const warn = (set, message) => {
  console.log(CI ? `::warning title=${set.abbr || set.name}::${set.name}: ${message}` : `  ! ${message}`);
};
const today = new Date().toISOString().slice(0, 10);
const rows = [];
let bytes = 0;
for (const set of sets) {
  const data = await loadSet(CACHE, set.groupId, fresh);
  if (data.stale) throw new Error(`could not reach TCGCSV for ${set.name}: ${data.staleReason}`);
  const body = JSON.stringify({ ...data, groupId: set.groupId });
  bytes += body.length;
  await fs.writeFile(path.join(OUT, 'data', `set-${set.groupId}.json`), body);

  const upcoming = set.publishedOn > today;
  const box = data.sealed?.standard?.display?.price?.m;
  const byRarity = {};
  for (const c of data.cards) byRarity[c.r] = (byRarity[c.r] || 0) + 1;
  console.log(`${(set.abbr || '?').padEnd(5)} ${set.name.padEnd(28)} ${String(data.cards.length).padStart(4)} cards${upcoming ? '  (upcoming)' : ''}`);
  if (!data.cards.length) { if (!upcoming) warn(set, 'released, but no cards are listed on TCGPlayer yet'); }
  else if (data.missing?.length) console.log(`      ${data.missing.length} of ${data.printedSize} cards not listed yet`);
  const unknown = Object.keys(data.unknownRarities || {});
  if (unknown.length) warn(set, `unknown rarity ${unknown.join(', ')}: those cards are left out until the app learns it`);
  if (data.cards.length > 50 && (!byRarity.C || !byRarity.L)) warn(set, `unusual rarity mix (${JSON.stringify(byRarity)}): the standard pack model may not fit`);
  if (!box && !upcoming) warn(set, 'no booster display price on TCGPlayer, so visitors must enter one');
  rows.push(`| ${set.abbr || '—'} | ${set.name}${upcoming ? ' (upcoming)' : ''} | ${set.publishedOn ?? ''} | ${data.cards.length}${data.missing?.length ? ` (${data.missing.length} missing)` : ''} | ${box ? `$${box.toFixed(2)}` : '—'} |`);
}
await fs.writeFile(path.join(OUT, 'data', 'sets.json'), JSON.stringify({ sets, builtAt: new Date().toISOString() }));
console.log(`\nBuilt ${sets.length} sets (${(bytes / 1024).toFixed(0)} KB of price data) into dist/`);

if (process.env.GITHUB_STEP_SUMMARY) {
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, [
    `### Built ${sets.length} sets with prices as of ${today}`, '',
    '| Set | Name | Release | Cards | Box (market) |', '|---|---|---|---|---|', ...rows, '',
  ].join('\n'));
}
