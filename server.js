'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT) || 4173;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY = 2 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

function normaliseState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!Array.isArray(input.zones) || !input.nodes || typeof input.nodes !== 'object' || Array.isArray(input.nodes)) return null;
  if (!Array.isArray(input.edges)) return null;

  return {
    zones: input.zones,
    nodes: input.nodes,
    edges: input.edges,
    checks: Array.isArray(input.checks) ? input.checks : [],
    dutyNote: typeof input.dutyNote === 'string' ? input.dutyNote.slice(0, 10000) : '',
  };
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('body-too-large');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readState() {
  const raw = await fsp.readFile(STATE_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeState(state) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tempFile = path.join(DATA_DIR, `state.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  await fsp.writeFile(tempFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fsp.rename(tempFile, STATE_FILE);
}

function coordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function proxyRoute(url, res) {
  const from = String(url.searchParams.get('from') || '').split(',').map(coordinate);
  const to = String(url.searchParams.get('to') || '').split(',').map(coordinate);
  if (from.length !== 2 || to.length !== 2 || from.some(v => v === null) || to.some(v => v === null)) {
    sendJson(res, 400, { error: 'from and to must be lng,lat coordinates' });
    return;
  }

  const target = new URL(`https://router.project-osrm.org/route/v1/driving/${from[0]},${from[1]};${to[0]},${to[1]}`);
  target.search = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    steps: 'true',
  }).toString();

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': 'DROS/1.0 disaster-response-operations-system' },
    });
    const text = await upstream.text();
    send(res, upstream.status, text, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    });
  } catch (error) {
    sendJson(res, 502, { error: 'Road routing service is unavailable' });
  }
}

async function serveStatic(requestPath, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    send(res, 400, 'Bad request');
    return;
  }

  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relativePath);
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    send(res, 403, 'Forbidden');
    return;
  }

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not-file');
    const extension = path.extname(filePath).toLowerCase();
    send(res, 200, await fsp.readFile(filePath), {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
    });
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'dros-api' });
      return;
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      try {
        sendJson(res, 200, await readState());
      } catch (error) {
        if (error.code === 'ENOENT') sendJson(res, 404, { error: 'No saved state' });
        else sendJson(res, 500, { error: 'Could not read saved state' });
      }
      return;
    }

    if (url.pathname === '/api/state' && req.method === 'PUT') {
      try {
        const state = normaliseState(await readBody(req));
        if (!state) {
          sendJson(res, 400, { error: 'Invalid state payload' });
          return;
        }
        await writeState(state);
        sendJson(res, 200, { ok: true, savedAt: new Date().toISOString() });
      } catch (error) {
        sendJson(res, error.message === 'body-too-large' ? 413 : 400, { error: 'Invalid JSON state payload' });
      }
      return;
    }

    if (url.pathname === '/api/state' && req.method === 'DELETE') {
      try { await fsp.unlink(STATE_FILE); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === '/api/route' && req.method === 'GET') {
      await proxyRoute(url, res);
      return;
    }

    // Keep clean URLs for the two frontend pages while serving the shared app shell.
    if (req.method === 'GET' && /^\/(overview|workspace)\/?$/.test(url.pathname)) {
      await serveStatic('/', res);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(url.pathname, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`DROS server listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
