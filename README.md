# SWU Playset Optimizer

How many Star Wars: Unlimited booster boxes should you open before buying the rest of a
playset (3× every card) as singles? This app answers that for any set, using live
TCGPlayer prices for both boxes and singles.

## Run it

Needs Node 20+ (no `npm install`; there are no dependencies).

```
npm start          # starts http://localhost:3002 and opens the browser
```

…or double-click `start.cmd`. `npm test` runs the model tests.

Deep-link a set with `?set=<code>`, e.g. `http://localhost:3002/?set=LAW`
(add `#collection` to open the collection tab).

## Publish it (GitHub Pages)

The same UI also builds as a static site: no server, prices pre-fetched once a day,
and each visitor's cards and want list saved in their own browser.

```
npm run build       # → dist/ (UI + data/sets.json + data/set-<id>.json); add -- --fresh to skip the cache
npm run preview     # → http://localhost:3003/swu-playset-optimizer/, served the way Pages will
```

`.github/workflows/pages.yml` runs the tests, builds and deploys on every push to
`main`, daily at 21:30 UTC (after TCGCSV's ~20:00 UTC update), and on demand from
the Actions tab ("Run workflow"). If TCGCSV can't be reached the build fails and
Pages keeps serving the previous day's prices.

One-time setup: create the GitHub repo, then **Settings → Pages → Source: GitHub
Actions**. Note that GitHub pauses scheduled workflows in a public repo after 60
days with no commits; re-enable it from the Actions tab (or push anything).

## What it does

- **Plan**: the cheapest number of boxes, and a *What if I open X boxes?* slider
  showing the singles bill (with its 80% range) for any box count.
- **My cards**: two things per card.
  - *Want*: uncheck cards you don't need playsets of (the header checkbox does every
    card shown, e.g. all rares + legendaries). Unwanted cards still turn up in packs;
    those pulls are extras, i.e. trade bait. The panel at the top shows the plan for
    your picks next to the whole-set and no-trading answers.
  - *You have*: click 0–3, type a card number and press Enter (+1 copy), bulk
    "mark complete", or paste a list or CSV. The plan then only covers what you're
    missing ("open 2 *more* boxes").

  Saved to `data/collection.json` (per set; unwanted cards as a `skip` list, so new
  cards default to wanted). "Put my collection in the box" exports owned counts as
  text you can paste back later.
- **Trading**: duplicate rares/legendaries are traded for rares/legendaries you're
  missing at a % of market you choose (default 80%), capped at what you're missing.

## How the answer is computed

For each box count *B* = 0, 1, 2, …:

```
expected cost(B) = B × box price
                 + Σ cards  price × E[copies still missing after B boxes]
                 − Σ cards  resale × E[extra copies beyond the playset]
```

The recommendation is the *B* with the lowest expected cost.

Each pack is modeled slot by slot: 1 leader (common, or rare ~1 in 6), 1 common base,
9 commons, 3 uncommons, 1 rare-or-legendary (legendary ~1 in 8) and 1 foil of any rarity.
Over *P* packs a card's copy count is a sum of binomials, so the chance of pulling
0, 1 or 2 copies, and from that the expected shortfall, is computed exactly. A
pack-by-pack Monte Carlo (400 openings) supplies the 80% range shown on the chart and
cross-checks the exact math (`test/model.test.js`).

Cards you own come off each card's target first (`need = target − owned`); copies
beyond the target are extras from the start.

Trading is the one non-linear piece: the credit is E[min(duplicate value, missing
R/L value)]. Each card's contribution has an exact mean and variance, and the
difference of the two sums is treated as normal. On Homeworlds that lands within
~0.4% of a 6,000-opening simulation that settles every trade exactly, and both pick
the same box count. The trade credit only kicks in once you'd pull 4+ copies of
rares, so it mostly matters for brand-new sets with pricey legendaries.

Special-rarity cards come from Spotlight/starter decks, not boosters, so they're
always bought as singles (toggleable). Rare bases ride the rare slot. Hyperspace
copies that replace a normal card count toward your playset.

## Assumptions you should know about

- **Pull rates are estimates.** FFG doesn't publish exact odds. The legendary rate
  matters most, and the hero card shows how the answer moves if it's off. All odds
  are editable under *Pack odds*.
- **Trading at 80% is an assumption about you.** It stands in for haggling and trades
  you can't find. The hero card's "Trade check" shows the answer with no trading.
- **Singles price** defaults to TCGPlayer market price with a $0.10 floor. Shipping
  isn't modeled unless you set "extra per card".
- **Chase cards aren't valued automatically.** If you'd sell hyperspace foils,
  Prestige or Showcase pulls, enter their expected value per box and it's netted off
  the box price.
- Carbonite Edition boxes (a different pack layout) aren't modeled.

## Layout

```
.github/workflows/  daily build + deploy to GitHub Pages
scripts/build.js    static build into dist/ (pre-fetched prices, browser-saved collection)
scripts/preview.js  serve dist/ under /swu-playset-optimizer/ like Pages does
server.js           zero-dependency HTTP server: UI, /api proxy to TCGCSV, collection store
lib/tcgcsv.js       fetch, 6h disk cache (./cache), normalize products → cards + sealed prices
public/model.js     the math (pure; shared by browser and tests)
public/collection.js  paste-a-list parser / exporter (pure)
public/app.js       UI: controls, chart, tables, collection editor
data/               your collection (collection.json); not part of the code
test/               node --test suite
```

API: `GET /api/sets`, `GET /api/set/:groupId`, `GET /api/collection`,
`PUT /api/collection/:groupId` (JSON `{abbr, name, cards: {number: copies}, skip: [number, …]}`).

Data comes from [TCGCSV](https://tcgcsv.com), a free daily mirror of TCGPlayer's
catalog and prices (SWU = category 79). It sends no CORS headers, which is why the
small server proxies it.
