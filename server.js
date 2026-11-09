'use strict';
/*
 * Reverb — self-hosted server (Press, Archive and Radio for music journalists and radio staff).
 * Zero npm dependencies: Node's built-in http, crypto and node:sqlite only.
 *
 * Env vars (all optional):
 *   PORT           port to listen on inside the container   (default 8080)
 *   DATA_DIR       where the SQLite database lives          (default ./data)
 *   ALLOW_SIGNUP   "false" to stop new accounts being made  (default true)
 *   SETLISTFM_API_KEY    optional: Setlist.fm key for setlist lookups
 *   BANDSINTOWN_APP_ID   optional: Bandsintown app id for tour-date lookups
 *   COOKIE_SECURE  "true" when served over HTTPS            (default false)
 *   TRUST_PROXY    "true" to read client IP from X-Forwarded-For (default false)
 *
 * CLI (run inside the container):
 *   node server.js list-users
 *   node server.js reset-password <username> <new-password>
 *   node server.js delete-user <username>
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const scrypt = promisify(crypto.scrypt);

const PORT = parseInt(process.env.PORT || '8080', 10);
const SETLISTFM_KEY = process.env.SETLISTFM_API_KEY || '';
const BANDSINTOWN_ID = process.env.BANDSINTOWN_APP_ID || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ALLOW_SIGNUP = (process.env.ALLOW_SIGNUP || 'true').toLowerCase() !== 'false';
const COOKIE_SECURE = (process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
const TRUST_PROXY = (process.env.TRUST_PROXY || 'false').toLowerCase() === 'true';
const SESSION_DAYS = 30;
const SESSION_COOKIE = 'rv_session';
const MAX_BODY_BYTES = 200 * 1024 * 1024; // the whole library is saved in one request

/* ---------- database ---------- */

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'reverb.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS user_state (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const q = {
  userByName: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username FROM users WHERE id = ?'),
  insertUser: db.prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
  listUsers: db.prepare('SELECT username, created_at FROM users ORDER BY created_at'),
  insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)'),
  sessionUser: db.prepare(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  deleteUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  getData: db.prepare('SELECT data FROM user_state WHERE user_id = ?'),
  putData: db.prepare(
    `INSERT INTO user_state (user_id, data, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ),
};

/* ---------- passwords & sessions ---------- */

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 86400 * 1000;
  q.insertSession.run(sha256(token), userId, expires);
  return { token, expires };
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function sessionFromReq(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const row = q.sessionUser.get(sha256(token), Date.now());
  return row ? { user: row, tokenHash: sha256(token) } : null;
}

function cookieHeader(token, expires) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Expires=${new Date(expires).toUTCString()}`,
  ];
  if (COOKIE_SECURE) parts.push('Secure');
  return parts.join('; ');
}

/* ---------- small helpers ---------- */

const attempts = new Map(); // ip -> { n, reset }
function rateLimited(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.reset < now) { attempts.set(ip, { n: 1, reset: now + 15 * 60 * 1000 }); return false; }
  rec.n += 1;
  return rec.n > 20;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (rec.reset < now) attempts.delete(ip);
  q.purgeSessions.run(now);
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function sendJson(res, status, body, extraHeaders) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Block cross-site writes: if the browser sent an Origin, it must match our Host.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (e) { return false; }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function serveFile(res, filePath, headOnly) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    res.end(headOnly ? undefined : data);
  });
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: https: http:",
    "connect-src 'self'",
    "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
  ].join('; '));
}

/* ---------- API ---------- */

const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;

async function handleApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;

  if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) {
    return sendJson(res, 403, { error: 'Cross-site request blocked.' });
  }

  if (route === '/api/auth/config' && method === 'GET') {
    return sendJson(res, 200, { allowSignup: ALLOW_SIGNUP });
  }

  if (route === '/api/auth/me' && method === 'GET') {
    const s = sessionFromReq(req);
    return s ? sendJson(res, 200, { user: s.user }) : sendJson(res, 401, { error: 'Not signed in.' });
  }

  if (route === '/api/auth/register' && method === 'POST') {
    if (!ALLOW_SIGNUP) return sendJson(res, 403, { error: 'New sign-ups are turned off on this server.' });
    if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!USERNAME_RE.test(username)) return sendJson(res, 400, { error: 'Username must be 3–32 characters: letters, numbers, dot, dash or underscore.' });
    if (password.length < 8 || password.length > 200) return sendJson(res, 400, { error: 'Password must be at least 8 characters.' });
    if (q.userByName.get(username)) return sendJson(res, 409, { error: 'That username is taken.' });
    const id = crypto.randomUUID();
    q.insertUser.run(id, username, await hashPassword(password));
    const { token, expires } = createSession(id);
    return sendJson(res, 201, { user: { id, username } }, { 'Set-Cookie': cookieHeader(token, expires) });
  }

  if (route === '/api/auth/login' && method === 'POST') {
    if (rateLimited(clientIp(req))) return sendJson(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readJson(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const row = q.userByName.get(username);
    // Always run a hash so response time doesn't reveal whether the user exists.
    const ok = row
      ? await verifyPassword(password, row.password_hash)
      : (await verifyPassword(password, 'scrypt$00$00'), false);
    if (!ok) return sendJson(res, 401, { error: 'Incorrect username or password.' });
    const { token, expires } = createSession(row.id);
    return sendJson(res, 200, { user: { id: row.id, username: row.username } }, { 'Set-Cookie': cookieHeader(token, expires) });
  }

  if (route === '/api/auth/logout' && method === 'POST') {
    const s = sessionFromReq(req);
    if (s) q.deleteSession.run(s.tokenHash);
    return sendJson(res, 200, { ok: true }, {
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`,
    });
  }

  if (route === '/api/state' && (method === 'GET' || method === 'PUT')) {
    const s = sessionFromReq(req);
    if (!s) return sendJson(res, 401, { error: 'Not signed in.' });
    if (method === 'GET') {
      const row = q.getData.get(s.user.id);
      return sendJson(res, 200, { state: row ? JSON.parse(row.data) : null });
    }
    const body = await readJson(req);
    if (!body || typeof body !== 'object' || !Array.isArray(body.artists) || !Array.isArray(body.songs)) {
      return sendJson(res, 400, { error: 'That does not look like Reverb data.' });
    }
    q.putData.run(s.user.id, JSON.stringify(body));
    return sendJson(res, 200, { ok: true });
  }

  if (route === '/api/lookup/setlist' && method === 'GET') {
    if (!sessionFromReq(req)) return sendJson(res, 401, { error: 'Not signed in.' });
    const key = SETLISTFM_KEY || String(req.headers['x-setlistfm-key'] || '');
    if (!key) return sendJson(res, 400, { error: 'Add a Setlist.fm API key in Settings (or set SETLISTFM_API_KEY) to look up setlists.' });
    const artist = url.searchParams.get('artist') || '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(url.searchParams.get('date') || '');
    if (!artist || !m) return sendJson(res, 400, { error: 'An artist and a date are needed.' });
    const r = await fetch('https://api.setlist.fm/rest/1.0/search/setlists?artistName=' + encodeURIComponent(artist) + '&date=' + `${m[3]}-${m[2]}-${m[1]}`,
      { headers: { 'x-api-key': key, Accept: 'application/json', 'Accept-Language': 'en' } });
    if (r.status === 404) return sendJson(res, 200, { songs: [] });
    if (!r.ok) return sendJson(res, 502, { error: 'Setlist.fm said ' + r.status + (r.status === 401 || r.status === 403 ? ' — check your API key.' : '.') });
    const j = await r.json();
    const sl = (j.setlist || []).find((x) => x.sets && x.sets.set && x.sets.set.some((st) => (st.song || []).length));
    const songs = sl ? sl.sets.set.flatMap((st) => (st.song || []).map((x) => x.name).filter(Boolean)) : [];
    return sendJson(res, 200, { songs });
  }

  if (route === '/api/lookup/tour-dates' && method === 'GET') {
    if (!sessionFromReq(req)) return sendJson(res, 401, { error: 'Not signed in.' });
    const id = BANDSINTOWN_ID || String(req.headers['x-bandsintown-id'] || '');
    if (!id) return sendJson(res, 400, { error: 'Add a Bandsintown app ID in Settings (or set BANDSINTOWN_APP_ID) to find tour dates.' });
    const artist = url.searchParams.get('artist') || '';
    if (!artist) return sendJson(res, 400, { error: 'An artist is needed.' });
    const r = await fetch('https://rest.bandsintown.com/artists/' + encodeURIComponent(artist) + '/events?app_id=' + encodeURIComponent(id));
    if (r.status === 404) return sendJson(res, 200, { events: [] });
    if (r.status === 401 || r.status === 403) return sendJson(res, 502, { error: 'Bandsintown rejected the app ID.' });
    if (!r.ok) return sendJson(res, 200, { events: [] });
    const j = await r.json().catch(() => []);
    const events = (Array.isArray(j) ? j : []).map((e) => ({
      date: String(e.datetime || '').slice(0, 10),
      venue: e.venue && e.venue.name || '',
      city: e.venue && [e.venue.city, e.venue.country].filter(Boolean).join(', ') || '',
      url: ((e.offers || [])[0] || {}).url || e.url || '',
    })).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date));
    return sendJson(res, 200, { events });
  }

  return sendJson(res, 404, { error: 'Not found.' });
}

/* ---------- server ---------- */

const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    const head = req.method === 'HEAD';

    // The app itself requires a session; everything else is public static content.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!sessionFromReq(req)) { res.writeHead(302, { Location: '/login.html' }); return res.end(); }
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'), head);
    }

    if (url.pathname === '/state.js') {
      const sess = sessionFromReq(req);
      const row = sess && q.getData.get(sess.user.id);
      const body = 'window.__STATE=' + (row ? row.data : 'null') + ';window.__USER=' + JSON.stringify(sess ? sess.user.username : null) + ';';
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(head ? undefined : body);
    }

    const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(PUBLIC_DIR, rel);
    if (!filePath.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    return serveFile(res, filePath, head);
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: status === 500 ? 'Server error.' : err.message });
    else res.end();
  }
});

/* ---------- CLI ---------- */

async function cli(args) {
  const [cmd, username, password] = args;
  if (cmd === 'list-users') {
    const rows = q.listUsers.all();
    console.log(rows.length ? rows.map((r) => `${r.username}  (created ${r.created_at})`).join('\n') : 'No users yet.');
    return 0;
  }
  if (cmd === 'reset-password') {
    if (!username || !password) { console.error('Usage: node server.js reset-password <username> <new-password>'); return 1; }
    if (password.length < 8) { console.error('Password must be at least 8 characters.'); return 1; }
    const row = q.userByName.get(username);
    if (!row) { console.error(`No such user: ${username}`); return 1; }
    q.setPassword.run(await hashPassword(password), row.id);
    q.deleteUserSessions.run(row.id);
    console.log(`Password updated for ${row.username}. Existing sessions were signed out.`);
    return 0;
  }
  if (cmd === 'delete-user') {
    if (!username) { console.error('Usage: node server.js delete-user <username>'); return 1; }
    const row = q.userByName.get(username);
    if (!row) { console.error(`No such user: ${username}`); return 1; }
    q.deleteUser.run(row.id);
    console.log(`Deleted ${row.username} and all of their Reverb data.`);
    return 0;
  }
  console.error('Commands: list-users | reset-password <username> <new-password> | delete-user <username>');
  return 1;
}

if (process.argv.length > 2) {
  cli(process.argv.slice(2)).then((code) => { db.close(); process.exit(code); });
} else {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Reverb listening on :${PORT} (data: ${DATA_DIR}, signups ${ALLOW_SIGNUP ? 'on' : 'off'})`);
  });
  const shutdown = () => { server.close(() => { try { db.close(); } catch (e) {} process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
