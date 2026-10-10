// Serve ./dist the way GitHub Pages will: under /<repo>/, static files only, no API.
//   npm run preview   ->  http://localhost:3003/swu-playset-optimizer/

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const BASE = `/${process.env.BASE || 'swu-playset-optimizer'}/`;
const PORT = Number(process.env.PORT) || 3003;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === BASE.slice(0, -1)) { res.writeHead(301, { Location: BASE }); return res.end(); }
  if (!pathname.startsWith(BASE)) { res.writeHead(404); return res.end('not found (the site lives under ' + BASE + ')'); }
  const rel = decodeURIComponent(pathname.slice(BASE.length)) || 'index.html';
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST + path.sep)) { res.writeHead(403); return res.end(); }
  const body = await fs.readFile(file).catch(() => null);
  if (!body) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(body);
}).listen(PORT, () => console.log(`Preview of the static build at http://localhost:${PORT}${BASE}`));
