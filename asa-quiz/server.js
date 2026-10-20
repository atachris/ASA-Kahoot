'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QUESTIONS = require('./questions');

const PORT = process.env.PORT || 3000;
const QUESTION_SECONDS = Number(process.env.QUESTION_SECONDS) || 20;
const MAX_PLAYERS = 300;
const GAME_TTL_MS = 6 * 60 * 60 * 1000;
const LATE_GRACE_MS = 600;

const games = new Map();

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newCode() {
  let code;
  do { code = String(crypto.randomInt(1000, 10000)); } while (games.has(code));
  return code;
}

function createGame() {
  const game = {
    code: newCode(),
    token: crypto.randomBytes(16).toString('hex'),
    created: Date.now(),
    phase: 'lobby',            // lobby | question | reveal | final
    players: new Map(),        // pid -> player
    order: [],                 // shuffled question indexes for this game
    qIndex: -1,
    startedAt: 0,
    endsAt: 0,
    answers: new Map(),        // pid -> { choice, at }
    timer: null,
    hostClients: new Set(),
    playerClients: new Map()   // pid -> Set(res)
  };
  games.set(game.code, game);
  return game;
}

function ranking(game) {
  return [...game.players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
}

function currentQuestion(game) {
  return QUESTIONS[game.order[game.qIndex]];
}

function publicQuestion(game) {
  const q = currentQuestion(game);
  return { number: game.qIndex + 1, total: game.order.length, text: q.text, options: q.options };
}

function hostView(game, ranks) {
  const v = {
    role: 'host',
    phase: game.phase,
    code: game.code,
    serverNow: Date.now(),
    duration: QUESTION_SECONDS * 1000,
    maxQuestions: QUESTIONS.length,
    players: [...game.players.values()].map(p => p.name),
    playerCount: game.players.size
  };
  if (game.phase === 'question' || game.phase === 'reveal') {
    v.question = publicQuestion(game);
    v.endsAt = game.endsAt;
    v.answered = game.answers.size;
  }
  if (game.phase === 'reveal') {
    const q = currentQuestion(game);
    const counts = q.options.map(() => 0);
    game.answers.forEach(a => { counts[a.choice]++; });
    v.reveal = {
      correct: q.correct,
      counts,
      top: ranks.slice(0, 5).map(p => ({ name: p.name, score: p.score, gain: p.gain }))
    };
  }
  if (game.phase === 'final') {
    v.final = { top: ranks.slice(0, 10).map(p => ({ name: p.name, score: p.score })) };
  }
  return v;
}

function playerView(game, p, ranks) {
  const v = {
    role: 'player',
    phase: game.phase,
    code: game.code,
    name: p.name,
    score: p.score,
    serverNow: Date.now(),
    duration: QUESTION_SECONDS * 1000
  };
  const rank = ranks.indexOf(p) + 1;
  if (game.phase === 'question' || game.phase === 'reveal') {
    v.question = publicQuestion(game);
    v.endsAt = game.endsAt;
    const a = game.answers.get(p.id);
    v.answered = !!a;
    v.choice = a ? a.choice : null;
  }
  if (game.phase === 'reveal') {
    const q = currentQuestion(game);
    const a = game.answers.get(p.id);
    v.result = {
      answered: !!a,
      correct: !!a && a.choice === q.correct,
      gain: p.gain,
      correctIndex: q.correct,
      rank,
      total: game.players.size
    };
  }
  if (game.phase === 'final') {
    v.final = { rank, total: game.players.size, score: p.score };
  }
  return v;
}

function send(res, obj) {
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) { /* client gone */ }
}

function sendHost(game) {
  if (!game.hostClients.size) return;
  const v = hostView(game, ranking(game));
  game.hostClients.forEach(res => send(res, v));
}

function sendPlayer(game, p, ranks) {
  const set = game.playerClients.get(p.id);
  if (!set || !set.size) return;
  const v = playerView(game, p, ranks || ranking(game));
  set.forEach(res => send(res, v));
}

function broadcast(game) {
  const ranks = ranking(game);
  const hv = hostView(game, ranks);
  game.hostClients.forEach(res => send(res, hv));
  game.players.forEach(p => sendPlayer(game, p, ranks));
}

function startQuestion(game) {
  game.qIndex++;
  if (game.qIndex >= game.order.length) {
    game.phase = 'final';
    broadcast(game);
    return;
  }
  game.phase = 'question';
  game.startedAt = Date.now();
  game.endsAt = game.startedAt + QUESTION_SECONDS * 1000;
  game.answers = new Map();
  game.players.forEach(p => { p.gain = 0; });
  clearTimeout(game.timer);
  game.timer = setTimeout(() => reveal(game), QUESTION_SECONDS * 1000 + LATE_GRACE_MS);
  broadcast(game);
}

function reveal(game) {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  const q = currentQuestion(game);
  const dur = QUESTION_SECONDS * 1000;
  game.answers.forEach((a, pid) => {
    const p = game.players.get(pid);
    if (!p || a.choice !== q.correct) return;
    const elapsed = Math.min(Math.max(a.at - game.startedAt, 0), dur);
    p.gain = Math.round(1000 * (1 - (elapsed / dur) / 2));
    p.score += p.gain;
  });
  game.phase = 'reveal';
  broadcast(game);
}

function resetToLobby(game) {
  clearTimeout(game.timer);
  game.phase = 'lobby';
  game.order = [];
  game.qIndex = -1;
  game.answers = new Map();
  game.players.forEach(p => { p.score = 0; p.gain = 0; });
  broadcast(game);
}

// ---------- HTTP helpers ----------
function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 10 * 1024) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
}

function handleEvents(req, res, url) {
  const game = games.get(url.searchParams.get('code'));
  const role = url.searchParams.get('role');
  if (!game) { res.writeHead(404).end(); return; }

  if (role === 'host') {
    if (url.searchParams.get('token') !== game.token) { res.writeHead(403).end(); return; }
    sseHeaders(res);
    game.hostClients.add(res);
    send(res, hostView(game, ranking(game)));
    req.on('close', () => game.hostClients.delete(res));
    return;
  }
  if (role === 'player') {
    const p = game.players.get(url.searchParams.get('pid'));
    if (!p) { res.writeHead(404).end(); return; }
    sseHeaders(res);
    if (!game.playerClients.has(p.id)) game.playerClients.set(p.id, new Set());
    game.playerClients.get(p.id).add(res);
    send(res, playerView(game, p, ranking(game)));
    req.on('close', () => {
      const set = game.playerClients.get(p.id);
      if (set) set.delete(res);
    });
    return;
  }
  res.writeHead(400).end();
}

async function handleApi(req, res, url) {
  let body;
  try { body = await readJson(req); } catch (_) { return json(res, 400, { error: 'Bad request' }); }

  if (url.pathname === '/api/create') {
    const game = createGame();
    return json(res, 200, { code: game.code, token: game.token });
  }

  const game = games.get(String(body.code || ''));
  if (!game) return json(res, 404, { error: 'No game with that code.' });

  if (url.pathname === '/api/join') {
    const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 16);
    if (!name) return json(res, 400, { error: 'Enter a name.' });
    if (game.players.size >= MAX_PLAYERS) return json(res, 400, { error: 'This game is full.' });
    const lower = name.toLowerCase();
    for (const p of game.players.values()) {
      if (p.name.toLowerCase() === lower) return json(res, 400, { error: 'That name is taken. Try another.' });
    }
    const p = { id: crypto.randomBytes(8).toString('hex'), name, score: 0, gain: 0, joinedAt: Date.now() };
    game.players.set(p.id, p);
    sendHost(game);
    return json(res, 200, { pid: p.id, name: p.name });
  }

  if (url.pathname === '/api/rejoin') {
    const p = game.players.get(String(body.pid || ''));
    if (!p) return json(res, 404, { error: 'Not in this game.' });
    return json(res, 200, { pid: p.id, name: p.name });
  }

  if (url.pathname === '/api/answer') {
    const p = game.players.get(String(body.pid || ''));
    if (!p) return json(res, 404, { error: 'Not in this game.' });
    const now = Date.now();
    if (game.phase !== 'question' || now > game.endsAt + LATE_GRACE_MS) return json(res, 400, { error: 'Too late.' });
    const choice = Number(body.choice);
    const q = currentQuestion(game);
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return json(res, 400, { error: 'Bad choice.' });
    if (game.answers.has(p.id)) return json(res, 200, { ok: true });
    game.answers.set(p.id, { choice, at: now });
    sendPlayer(game, p);
    if (game.answers.size >= game.players.size) reveal(game);
    else sendHost(game);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/api/host') {
    if (body.token !== game.token) return json(res, 403, { error: 'Not the host.' });
    switch (body.action) {
      case 'ping':
        return json(res, 200, { ok: true });
      case 'start': {
        if (game.phase !== 'lobby') return json(res, 400, { error: 'Already started.' });
        if (game.players.size < 1) return json(res, 400, { error: 'Wait for at least one player.' });
        const count = Math.min(Math.max(parseInt(body.count, 10) || QUESTIONS.length, 1), QUESTIONS.length);
        game.order = shuffle(QUESTIONS.map((_, i) => i)).slice(0, count);
        game.qIndex = -1;
        startQuestion(game);
        return json(res, 200, { ok: true });
      }
      case 'skip':
        if (game.phase === 'question') reveal(game);
        return json(res, 200, { ok: true });
      case 'next':
        if (game.phase === 'reveal') startQuestion(game);
        return json(res, 200, { ok: true });
      case 'restart':
        if (game.phase === 'final') resetToLobby(game);
        return json(res, 200, { ok: true });
      default:
        return json(res, 400, { error: 'Unknown action.' });
    }
  }

  return json(res, 404, { error: 'Not found.' });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};
const PUBLIC = path.join(__dirname, 'public');

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  if (p === '/host') p = '/host.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/events') return handleEvents(req, res, url);
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET') return serveStatic(req, res, url);
    res.writeHead(405).end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

// keep proxies from closing idle streams
setInterval(() => {
  games.forEach(g => {
    g.hostClients.forEach(r => { try { r.write(': ping\n\n'); } catch (_) {} });
    g.playerClients.forEach(set => set.forEach(r => { try { r.write(': ping\n\n'); } catch (_) {} }));
  });
}, 20000).unref();

// drop old games
setInterval(() => {
  const now = Date.now();
  games.forEach((g, code) => {
    if (now - g.created > GAME_TTL_MS) { clearTimeout(g.timer); games.delete(code); }
  });
}, 30 * 60 * 1000).unref();

server.listen(PORT, () => {
  console.log(`Quiz server running. Host screen: http://localhost:${PORT}/host`);
});
