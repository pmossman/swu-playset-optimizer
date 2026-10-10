// Tiny zero-dependency server: serves the UI from ./public, proxies TCGCSV
// (which sends no CORS headers, so the browser can't fetch it directly) and keeps
// the cards you already own in ./data/collection.json.
//
//   node server.js           -> http://localhost:3002
//   node server.js --open    -> same, and opens the browser

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { listSets, loadSet } from './lib/tcgcsv.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CACHE = path.join(ROOT, 'cache');
const COLLECTION = path.join(ROOT, 'data', 'collection.json');
const PORT = Number(process.env.PORT) || 3002;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// ---------- collection store ----------
async function readCollection() {
  try {
    return JSON.parse(await fs.readFile(COLLECTION, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return { sets: {} };
    throw err; // never silently replace a file we couldn't parse
  }
}

let writes = Promise.resolve();
function saveSetCollection(groupId, entry) {
  const run = writes.then(async () => {
    const all = await readCollection();
    all.sets ??= {};
    if (Object.keys(entry.cards).length || entry.skip) all.sets[groupId] = entry;
    else delete all.sets[groupId];
    await fs.mkdir(path.dirname(COLLECTION), { recursive: true });
    const tmp = `${COLLECTION}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 2));
    await fs.rename(tmp, COLLECTION);
  });
  writes = run.catch(() => {});
  return run;
}

function cleanEntry(body) {
  const cards = {};
  for (const [key, value] of Object.entries(body?.cards ?? {})) {
    const n = Number(key), count = Math.floor(Number(value));
    if (Number.isInteger(n) && n > 0 && n < 10000 && count > 0) cards[n] = Math.min(count, 99);
  }
  // Cards left out of the goal (the want list is stored as its exceptions, so new cards default to wanted).
  const skip = [...new Set((Array.isArray(body?.skip) ? body.skip : []).map(Number)
    .filter(n => Number.isInteger(n) && n > 0 && n < 10000))].sort((a, b) => a - b);
  const label = v => (typeof v === 'string' ? v.slice(0, 100) : undefined);
  return { abbr: label(body?.abbr), name: label(body?.name), updatedAt: new Date().toISOString(), cards, skip: skip.length ? skip : undefined };
}

async function readJsonBody(req, limit = 256 * 1024) {
  if (!/^application\/json\b/.test(req.headers['content-type'] || '')) throw httpError(415, 'expected JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw httpError(413, 'too large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw httpError(400, 'invalid JSON'); }
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const force = url.searchParams.get('refresh') === '1';
  try {
    if (url.pathname === '/api/sets') return send(res, 200, await listSets(CACHE, force));

    const setMatch = url.pathname.match(/^\/api\/set\/(\d+)$/);
    if (setMatch) return send(res, 200, await loadSet(CACHE, Number(setMatch[1]), force));

    if (url.pathname === '/api/collection' && req.method === 'GET') return send(res, 200, await readCollection());
    const collMatch = url.pathname.match(/^\/api\/collection\/(\d+)$/);
    if (collMatch && req.method === 'PUT') {
      const entry = cleanEntry(await readJsonBody(req));
      await saveSetCollection(collMatch[1], entry);
      return send(res, 200, { ok: true, cards: Object.keys(entry.cards).length, skip: entry.skip?.length ?? 0 });
    }

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: 'forbidden' });
    const body = await fs.readFile(file).catch(() => null);
    if (!body) return send(res, 404, { error: 'not found' });
    return send(res, 200, body, MIME[path.extname(file)] || 'application/octet-stream');
  } catch (err) {
    if (!err.status) console.error(err);
    return send(res, err.status || 502, { error: err.message });
  }
});

server.listen(PORT, () => {
  const where = `http://localhost:${PORT}`;
  console.log(`SWU Playset Optimizer running at ${where}  (Ctrl+C to stop)`);
  if (process.argv.includes('--open')) {
    const cmd = process.platform === 'win32' ? `start "" "${where}"` : process.platform === 'darwin' ? `open ${where}` : `xdg-open ${where}`;
    exec(cmd);
  }
});
