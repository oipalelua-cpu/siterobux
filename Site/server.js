// server.js — pareamento para a extensão CLARENCIO
// Node 18+, zero deps. Roda: node server.js
// Rotas: POST /api/register · GET /api/poll/:code · POST /api/command/:code · GET /api/status/:code

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');
const POLL_TTL_MS = 45_000;

const sessions = new Map(); // code -> { secret, lastPoll, createdAt }
const inbox = new Map();    // code -> { commands: [], nextId }

const rand = (n = 16) => crypto.randomBytes(n).toString('hex');
const now = () => Date.now();

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Device-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(data);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- api handlers

function handleRegister(req, res) {
  let code;
  do { code = rand(4).toUpperCase().slice(0, 8); } while (sessions.has(code));
  const secret = rand(32);

  sessions.set(code, { secret, lastPoll: now(), createdAt: now() });
  inbox.set(code, { commands: [], nextId: 1 });

  setTimeout(() => {
    const s = sessions.get(code);
    if (s && now() - s.lastPoll > POLL_TTL_MS) {
      sessions.delete(code);
      inbox.delete(code);
    }
  }, POLL_TTL_MS + 5000);

  json(res, 200, { code, secret });
}

function handlePoll(req, res, code, query) {
  const session = sessions.get(code);
  if (!session) return json(res, 404, { error: 'code not found' });

  const secret = req.headers['x-device-secret'];
  if (secret !== session.secret) return json(res, 403, { error: 'bad secret' });

  session.lastPoll = now();
  const since = Number(query.get('since') || 0);
  const box = inbox.get(code);
  if (!box) return json(res, 404, { error: 'inbox missing' });

  const commands = box.commands.filter((c) => c.id > since);
  json(res, 200, { commands });
}

async function handleCommand(req, res, code) {
  const session = sessions.get(code);
  if (!session) return json(res, 404, { error: 'code not found' });
  if (now() - session.lastPoll > POLL_TTL_MS)
    return json(res, 410, { error: 'extension offline' });

  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch (_) { return json(res, 400, { error: 'invalid json' }); }

  const box = inbox.get(code);
  if (!box) return json(res, 404, { error: 'inbox missing' });

  const command = { id: box.nextId++, ...payload, at: now() };
  box.commands.push(command);
  if (box.commands.length > 500) box.commands.splice(0, box.commands.length - 500);

  json(res, 200, { ok: true, id: command.id });
}

function handleStatus(res, code) {
  const session = sessions.get(code);
  if (!session) return json(res, 200, { online: false });
  const ageMs = now() - session.lastPoll;
  json(res, 200, { online: ageMs < POLL_TTL_MS, lastPoll: session.lastPoll, ageMs });
}

// ---------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });

  fs.readFile(file, (err, data) => {
    if (err) return json(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;
  const method = req.method.toUpperCase();

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Device-Secret',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    });
    return res.end();
  }

  try {
    if (pathname === '/api/register' && method === 'POST') return handleRegister(req, res);

    let m = pathname.match(/^\/api\/poll\/([A-Z0-9]+)$/);
    if (m && method === 'GET') return handlePoll(req, res, m[1], searchParams);

    m = pathname.match(/^\/api\/command\/([A-Z0-9]+)$/);
    if (m && method === 'POST') return handleCommand(req, res, m[1]);

    m = pathname.match(/^\/api\/status\/([A-Z0-9]+)$/);
    if (m && method === 'GET') return handleStatus(res, m[1]);

    if (pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown endpoint' });
    return serveStatic(res, pathname);
  } catch (err) {
    json(res, 500, { error: String(err.message || err) });
  }
});

setInterval(() => {
  for (const [code, s] of sessions) {
    if (now() - s.lastPoll > POLL_TTL_MS * 4) {
      sessions.delete(code);
      inbox.delete(code);
    }
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  console.log(`CLARENCIO Connect ouvindo em http://${HOST}:${PORT}`);
});