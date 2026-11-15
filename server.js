'use strict';
/*
 * 烬冠竞技场 — 联机对战服务器
 * 权威服务器：所有移动、命中、伤害、击杀都在这里结算，客户端只发送输入并负责绘制。
 * 每个房间最多 8 人，自由混战；先到 KILL_TARGET 次击杀或时间结束时击杀最多者获胜。
 *
 *   npm start                 # 默认 3000 端口
 *   PORT=8100 npm start       # 换端口
 *   BOT_FILL=0 npm start      # 关闭电脑对手（默认把房间补到 4 人）
 *   KILL_TARGET=20 ROUND_TIME=300 npm start   # 获胜击杀数 / 每局秒数
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3001;
const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'telemetry.db');
const SEC_LOG = process.env.SEC_LOG || path.join(DATA_DIR, 'security.log');
const DEBUG_ON = process.env.DEBUG === '1' || process.env.LOG_LEVEL === 'debug';
const ENV_DEMO_PASS = String(process.env.DEMO_PASS || '').trim();
const DEMO_PASS_AUTO = !ENV_DEMO_PASS;
const DEMO_PASS = ENV_DEMO_PASS || crypto.randomBytes(9).toString('base64url');
const PASS_HASH = crypto.createHash('sha256').update(DEMO_PASS).digest();
const SESSION_KEY = crypto.randomBytes(32);
const SESSION_TTL_MS = 24 * 3600 * 1000;
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const ADMIN_HASH = ADMIN_TOKEN ? crypto.createHash('sha256').update(ADMIN_TOKEN).digest() : null;
const MAX_PLAYERS = 8;
const BOT_FILL = envInt('BOT_FILL', 4, 0, MAX_PLAYERS);
const MAX_CONNECTIONS = 256;
const MAX_ROOMS = 64;
const MAX_CONN_PER_IP = 16;

const TICK = 30, DT = 1 / TICK;
const KILL_TARGET = envInt('KILL_TARGET', 15, 1, 99), ROUND_TIME = envInt('ROUND_TIME', 240, 30, 3600), END_TIME = 9, RESPAWN = 3, SPAWN_PROT = 1.5;
const R = 24, PR = 0.5, TAU = Math.PI * 2;
const PILLARS = [0, 1, 2, 3].map(k => { const a = k * Math.PI / 2 + Math.PI / 4; return { x: Math.sin(a) * 12, z: Math.cos(a) * 12, r: 1.4 }; });
const ROLL = { cd: 2.8, dur: 0.26, sp: 22, inv: 0.34 };
const CHARGE = { dur: 0.28, sp: 30, maxDist: 18, maxGap: 20 };
const JUMP = { v: 8.6, g: 24 };                        // 起跳速度 / 重力：滞空约 0.72 秒，跳高约 1.5
const SLOW_K = 0.55;
// 5 号位移技能：骑士冲锋、游侠翻滚、法师闪现
const MOVE = { knight: { k: 'charge', cd: 5 }, ranger: { k: 'roll', cd: ROLL.cd }, mage: { k: 'blink', cd: 6.5, dist: 7.2 } };
const RES_MAX = 100;
const CLS_IDS = ['knight', 'ranger', 'mage'];
// q / e / u：2、3、4 号技能的冷却；cast / range：4 号大招的读条时间和施法距离；cost：[普攻, 2 号, 3 号, 4 号] 的资源消耗
const CLS = {
  knight: { hp: 215, speed: 6.8, atkCd: 0.41, armor: 0.74, q: 5.2, e: 7.5, u: 20, cast: 0.95, range: 15, res: 'rage', cost: [0, 0, 20, 35] },
  ranger: { hp: 140, speed: 7.1, atkCd: 0.37, armor: 0.90, q: 6.5, e: 8.5, u: 21, cast: 1.05, range: 19, res: 'energy', cost: [0, 25, 30, 45] },
  mage: { hp: 136, speed: 6.6, atkCd: 0.46, armor: 0.90, q: 7.5, e: 9.2, u: 24, cast: 1.25, range: 19, res: 'mana', cost: [0, 20, 30, 45] },
};
// 怒气：造成 / 受到伤害时获得，脱战后衰减；能量、法力：随时间恢复
const RES = {
  rage: { start: 20, regen: 0, decay: 2, calm: 6.5, hit: 12, hurt: 0.65, charge: 25, bash: 15 },
  energy: { start: 100, regen: 9.0 },
  mana: { start: 100, regen: 6.5 },
};
// 4 号大招：读条完成后在选定位置生成的区域
const ULT = {
  knight: { k: 'blade', zone: { r: 5, delay: 0.45, dmg: 78, stun: 1.2 } },
  ranger: { k: 'storm', zone: { r: 6, delay: 0.4, ticks: 8, iv: 0.3, dmg: 13, slow: 1.3 } },
  mage: { k: 'inferno', zone: { r: 6.2, delay: 0.5, ticks: 3, iv: 0.45, dmg: 46, kb: 7 } },
};
const BOT_NAMES = ['波林', '艾瑞克', '莉雅', '凯尔', '薇拉', '索恩', '米拉', '卡隆', '芬恩', '伊索德'];
const PLAYER_NAMES = ['赤焰', '苍风', '铁壁', '星矢', '孤狼', '寒霜', '烈阳', '影刃', '破晓', '雷鸣', '磐石', '逐影'];
const BOT_DIFF = {
  easy:   { id: 'easy',   name: '简单', dmg: 0.55, spd: 0.78, dtMin: 0.65, dtVar: 0.45, err: 0.95, turn: 3.6, gcd: 1.05, fire: 0.42, q: 0.12, e: 0.08, u: 0.05, roll: 0.04 },
  normal: { id: 'normal', name: '普通', dmg: 0.74, spd: 0.88, dtMin: 0.45, dtVar: 0.35, err: 0.55, turn: 5.4, gcd: 0.65, fire: 0.58, q: 0.20, e: 0.16, u: 0.10, roll: 0.08 },
  hard:   { id: 'hard',   name: '困难', dmg: 0.88, spd: 0.93, dtMin: 0.34, dtVar: 0.25, err: 0.34, turn: 7.2, gcd: 0.45, fire: 0.68, q: 0.28, e: 0.24, u: 0.16, roll: 0.14 },
};

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function envInt(key, def, min, max) { const v = Number(process.env[key]); return process.env[key] !== undefined && Number.isFinite(v) ? clamp(Math.floor(v), min, max) : def; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function r2(v) { return Math.round(v * 100) / 100; }
function angDiff(a, b) { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
function cleanText(v, max) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : ''; }
function cleanRoomCode(v) { return typeof v === 'string' ? v.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12) : ''; }
function checkSecret(v, hash) {
  if (!hash || typeof v !== 'string') return false;
  const h = crypto.createHash('sha256').update(v.trim()).digest();
  return crypto.timingSafeEqual(h, hash);
}
const checkPass = v => checkSecret(v, PASS_HASH);
const checkAdmin = v => checkSecret(v, ADMIN_HASH);
function issueSessionToken() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const sig = crypto.createHmac('sha256', SESSION_KEY).update(exp).digest('base64url');
  return exp + '.' + sig;
}
function verifySessionToken(tok) {
  if (typeof tok !== 'string') return false;
  const dot = tok.indexOf('.');
  if (dot <= 0) return false;
  const exp = tok.slice(0, dot), sig = tok.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) <= Date.now()) return false;
  const expected = crypto.createHmac('sha256', SESSION_KEY).update(exp).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const authFailures = new Map();
function clientIp(req) {
  let raw = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (TRUST_PROXY && req.headers) {
    const xff = req.headers['x-forwarded-for'];
    const parts = typeof xff === 'string' ? xff.split(',').map(s => s.trim()).filter(Boolean) : [];
    raw = (parts.length && parts[parts.length - 1]) || req.headers['x-real-ip'] || raw;
  }
  return String(raw).replace(/^::ffff:/, '').slice(0, 64);
}
function clientUa(req) { return cleanText(req.headers && req.headers['user-agent'], 180); }

/* ---------------- SQLite telemetry & debug logger ---------------- */
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
try { fs.closeSync(fs.openSync(SEC_LOG, 'a')); } catch (e) {}
const INIT_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS access_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ip TEXT NOT NULL,
    event TEXT NOT NULL,
    method TEXT,
    path TEXT,
    status INTEGER,
    ua TEXT,
    room TEXT,
    player_name TEXT,
    cls TEXT,
    detail TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_access_ts ON access_logs(ts);
  CREATE INDEX IF NOT EXISTS idx_access_ip ON access_logs(ip);

  CREATE TABLE IF NOT EXISTS load_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    rss_mb REAL,
    heap_mb REAL,
    cpu_pct REAL,
    load_1m REAL,
    tick_avg_ms REAL,
    tick_max_ms REAL,
    ws_conns INTEGER,
    rooms INTEGER,
    humans INTEGER,
    bots INTEGER,
    msg_per_sec REAL
  );
  CREATE INDEX IF NOT EXISTS idx_load_ts ON load_metrics(ts);

  CREATE TABLE IF NOT EXISTS debug_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    tag TEXT NOT NULL,
    msg TEXT NOT NULL,
    meta TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_debug_ts ON debug_logs(ts);
`;
function sqlLit(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '0';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function openSqlite(dbPath) {
  try {
    const B = require('better-sqlite3');
    const inst = new B(dbPath);
    inst.exec(INIT_SQL);
    const sAcc = inst.prepare('INSERT INTO access_logs (ts, ip, event, method, path, status, ua, room, player_name, cls, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const sLd = inst.prepare('INSERT INTO load_metrics (ts, rss_mb, heap_mb, cpu_pct, load_1m, tick_avg_ms, tick_max_ms, ws_conns, rooms, humans, bots, msg_per_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const sDbg = inst.prepare('INSERT INTO debug_logs (ts, level, tag, msg, meta) VALUES (?, ?, ?, ?, ?)');
    return {
      insertAccess: a => sAcc.run(...a),
      insertLoad: a => sLd.run(...a),
      insertDebug: a => sDbg.run(...a),
      exec: sql => inst.exec(sql),
      query: sql => { try { return inst.prepare(sql).all(); } catch (e) { return []; } },
      close: () => inst.close(),
    };
  } catch (e1) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const inst = new DatabaseSync(dbPath);
      inst.exec(INIT_SQL);
      const sAcc = inst.prepare('INSERT INTO access_logs (ts, ip, event, method, path, status, ua, room, player_name, cls, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const sLd = inst.prepare('INSERT INTO load_metrics (ts, rss_mb, heap_mb, cpu_pct, load_1m, tick_avg_ms, tick_max_ms, ws_conns, rooms, humans, bots, msg_per_sec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const sDbg = inst.prepare('INSERT INTO debug_logs (ts, level, tag, msg, meta) VALUES (?, ?, ?, ?, ?)');
      return {
        insertAccess: a => sAcc.run(...a),
        insertLoad: a => sLd.run(...a),
        insertDebug: a => sDbg.run(...a),
        exec: sql => inst.exec(sql),
        query: sql => { try { return inst.prepare(sql).all(); } catch (e) { return []; } },
        close: () => inst.close(),
      };
    } catch (e2) {
      execFileSync('sqlite3', [dbPath, INIT_SQL]);
      const proc = spawn('sqlite3', [dbPath], { stdio: ['pipe', 'ignore', 'ignore'] });
      proc.stdin.on('error', () => {});
      const sendSql = sql => { if (proc.stdin.writable) proc.stdin.write(sql + ';\n'); };
      return {
        insertAccess: a => sendSql('INSERT INTO access_logs (ts, ip, event, method, path, status, ua, room, player_name, cls, detail) VALUES (' + a.map(sqlLit).join(',') + ')'),
        insertLoad: a => sendSql('INSERT INTO load_metrics (ts, rss_mb, heap_mb, cpu_pct, load_1m, tick_avg_ms, tick_max_ms, ws_conns, rooms, humans, bots, msg_per_sec) VALUES (' + a.map(sqlLit).join(',') + ')'),
        insertDebug: a => sendSql('INSERT INTO debug_logs (ts, level, tag, msg, meta) VALUES (' + a.map(sqlLit).join(',') + ')'),
        exec: sql => sendSql(sql),
        query: sql => { try { const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', timeout: 2000 }).trim(); return out ? JSON.parse(out) : []; } catch (e) { return []; } },
        close: () => { try { proc.stdin.end('.quit\n'); } catch (e) {} },
      };
    }
  }
}
const db = openSqlite(DB_PATH);

function logAccess(o) {
  const ts = new Date().toISOString(), ip = o.ip || 'unknown', ev = o.event || 'http';
  try {
    db.insertAccess([ts, ip, ev, o.method || null, o.path || null, o.status ?? null, o.ua || null, o.room || null, o.name || null, o.cls || null, o.detail ? JSON.stringify(o.detail) : null]);
  } catch (e) {}
  if (ev === 'auth_fail' || ev === 'ws_auth_fail' || ev === 'admin_denied' || ev === 'rooms_denied' || ev === 'rate_limit' || ev === 'honeypot_hit') {
    try { fs.appendFileSync(SEC_LOG, ts + ' [FAIL2BAN] EVENT=' + ev + ' HOST=' + ip + ' PATH=' + (o.path || '-') + '\n'); } catch (e) {}
  }
}
const HONEYPOT_RE = /^\/(?:\.env|\.git|\.svn|\.aws|\.ssh|\.DS_Store|wp-admin|wp-login(?:\.php)?|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|pma|myadmin|admin\.php|administrator|shell|cmd|eval-stdin|vendor\/phpunit|actuator|cgi-bin|solr|jenkins|manager\/html|config\.php|config\.json|backup|dump\.sql|db\.sql|id_rsa|etc\/passwd|proc\/self|trap-admin)(?:$|\/)/i;
function handleHoneypot(req, res, p, ip, ua) {
  for (let i = 0; i < 10; i++) recordAuthFail(ip);
  const h = req.headers || {};
  logAccess({ ip, ua, event: 'honeypot_hit', method: req.method, path: p, status: 403, detail: { host: cleanText(h.host, 120), ref: cleanText(h.referer, 180), xff: cleanText(h['x-forwarded-for'], 120) } });
  logDebug('WARN', 'honeypot', '蜜罐捕获可疑扫描请求', { ip, method: req.method, path: p, ua });
  setTimeout(() => {
    if (res.destroyed) return;
    if (p.startsWith('/.env')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('APP_ENV=production\nDB_HOST=10.0.14.88\nDB_USER=honeypot_canary\nDB_PASS=decoy_9f8a7b6c5d4e\n');
    } else {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('403 Forbidden\n');
    }
  }, 2500);
}
function logDebug(level, tag, msg, meta) {
  const ts = new Date().toISOString(), metaStr = meta !== undefined ? JSON.stringify(meta) : null;
  try { db.insertDebug([ts, level, tag, msg, metaStr]); } catch (e) {}
  if (level === 'ERROR' || level === 'WARN' || DEBUG_ON || level === 'INFO') {
    const line = '[' + ts + '] [' + level + ':' + tag + '] ' + msg + (metaStr ? ' ' + metaStr : '');
    if (level === 'ERROR') console.error(line); else console.log(line);
  }
}
let tickSumMs = 0, tickMaxMs = 0, tickCount = 0, totalWsMsgs = 0, lastCpu = process.cpuUsage(), lastSampleT = Date.now();
function sampleLoad() {
  const now = Date.now(), dtSec = Math.max(0.1, (now - lastSampleT) / 1000); lastSampleT = now;
  const cpu = process.cpuUsage(lastCpu); lastCpu = process.cpuUsage();
  const cpuPct = r2(((cpu.user + cpu.system) / 1e6 / dtSec) * 100);
  const mem = process.memoryUsage(), rssMb = r2(mem.rss / 1048576), heapMb = r2(mem.heapUsed / 1048576);
  const load1m = r2(os.loadavg()[0] || 0);
  const avgMs = tickCount ? r2(tickSumMs / tickCount) : 0, maxMs = r2(tickMaxMs);
  tickSumMs = 0; tickMaxMs = 0; tickCount = 0;
  const msgRate = r2(totalWsMsgs / dtSec); totalWsMsgs = 0;
  let hum = 0, botN = 0;
  for (const r of rooms.values()) { const h = humans(r); hum += h; botN += r.players.length - h; }
  let conns = 0; try { conns = wss.clients.size; } catch (e) {}
  const row = { ts: new Date().toISOString(), rssMb, heapMb, cpuPct, load1m, avgMs, maxMs, conns, rooms: rooms.size, hum, botN, msgRate };
  try { db.insertLoad([row.ts, row.rssMb, row.heapMb, row.cpuPct, row.load1m, row.avgMs, row.maxMs, row.conns, row.rooms, row.hum, row.botN, row.msgRate]); } catch (e) {}
  if (maxMs > 18) logDebug('WARN', 'tick', 'Tick 耗时偏高', { maxMs, avgMs, rooms: row.rooms, players: row.hum });
  return row;
}
function isRateLimited(ip) {
  const rec = authFailures.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { authFailures.delete(ip); return false; }
  return rec.count >= 10;
}
function recordAuthFail(ip) {
  const now = Date.now(), rec = authFailures.get(ip);
  if (!rec || now > rec.resetAt) authFailures.set(ip, { count: 1, resetAt: now + 60000 });
  else rec.count++;
}
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/* ---------------- static files ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.includes('\0')) { res.writeHead(400); return res.end(); }
  const ip = clientIp(req), ua = clientUa(req);
  if (HONEYPOT_RE.test(p)) return handleHoneypot(req, res, p, ip, ua);
  if (req.method === 'POST' && p === '/auth') {
    if (isRateLimited(ip)) {
      logAccess({ ip, ua, event: 'rate_limit', method: 'POST', path: '/auth', status: 429 });
      logDebug('WARN', 'auth', 'IP 触发口令频率限制', { ip });
      res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, msg: '尝试过于频繁，请 1 分钟后再试' }));
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 512) req.destroy(); });
    req.on('end', () => {
      let pass = '', tok = '';
      try { const j = JSON.parse(body); pass = String(j.pass || ''); tok = String(j.token || ''); } catch (e) {}
      const tokOk = tok ? verifySessionToken(tok) : false;
      const ok = tokOk || checkPass(pass);
      logAccess({ ip, ua, event: ok ? 'auth_ok' : 'auth_fail', method: 'POST', path: '/auth', status: ok ? 200 : 401 });
      if (!ok) { recordAuthFail(ip); logDebug('WARN', 'auth', '口令验证失败', { ip }); }
      else logDebug('INFO', 'auth', '口令验证通过', { ip });
      res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(ok ? { ok: true, token: tokOk ? tok : issueSessionToken() } : { ok: false, msg: '口令错误，请重试' }));
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (p === '/healthz') {
    let players = 0; for (const r of rooms.values()) players += r.players.filter(q => !q.bot).length;
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players }));
  }
  if (p === '/rooms') {                                // 对战大厅的房间列表（需口令或短期令牌校验）
    if (isRateLimited(ip) || (!verifySessionToken(req.headers['x-demo-token']) && !checkPass(req.headers['x-demo-pass']))) {
      if (!isRateLimited(ip)) recordAuthFail(ip);
      logAccess({ ip, ua, event: 'rooms_denied', method: req.method, path: '/rooms', status: 401 });
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify([]));
    }
    const list = [...rooms.values()].map(r => ({ code: r.code, n: humans(r), bots: r.players.length - humans(r), diff: r.diff || 'normal', max: MAX_PLAYERS, ph: r.phase === 'end' ? 1 : 0,
      rt: Math.max(0, Math.ceil(r.phase === 'end' ? r.phaseT : r.roundT)), top: r.players.reduce((m, q) => Math.max(m, q.kills), 0) })).sort((a, b) => b.n - a.n || (a.code < b.code ? -1 : 1));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(list));
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    if (p === '/index.html' && req.method === 'GET') {
      logAccess({ ip, ua, event: 'http_visit', method: 'GET', path: '/', status: 200 });
      logDebug('DEBUG', 'http', '访问首页', { ip, ua });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': st.size, 'ETag': etag, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
});

/* ---------------- rooms ---------------- */
const rooms = new Map();
function makeRoom(code, priv, botCount = Math.max(0, BOT_FILL - 1), diff = 'normal') {
  const dKey = BOT_DIFF[diff] ? diff : 'normal';
  const room = { code, priv, botCount: clamp(botCount, 0, MAX_PLAYERS - 1), diff: dKey, players: [], proj: [], zones: [], picks: [], ev: [], time: 0, phase: 'play', phaseT: 0, roundT: ROUND_TIME,
    nextId: 1, nextObj: 1, pickT: 6, botT: 0, rosterDirty: true, hasFb: false };
  rooms.set(code, room); return room;
}
function randomCode() { const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do { s = ''; for (let i = 0; i < 4; i++) s += abc[Math.random() * abc.length | 0]; } while (rooms.has(s)); return s; }
function humans(room) { let n = 0; for (const p of room.players) if (!p.bot) n++; return n; }

function makePlayer(room, name, cls, ws) {
  const p = { id: room.nextId++, name, cls, ws, bot: !ws, x: 0, z: 0, y: 0, vy: 0, air: false, jx: 0, jz: 0, face: 0, hp: CLS[cls].hp, res: 0, calm: 0, kx: 0, kz: 0,
    cd: { atk: 0, q: 0, e: 0, u: 0, dodge: 0 }, dashT: 0, dashX: 0, dashZ: 1, dashSp: 0, charging: false, rolling: false, chargeHit: null, chargeTarget: null, chargeTgId: 0, chargeDist: 0,
    cast: 0, castX: 0, castZ: 0, ux: 0, uz: 0,
    inv: 0, prot: 0, stun: 0, stunDR: 0, freeze: 0, slow: 0, dead: false, respawnT: 0, moving: false,
    mx: 0, mz: 0, a: 0, ax: 0, az: 0, pend: 0, seq: 0, kills: 0, deaths: 0, dmg: 0, streak: 0, maxStreak: 0, mk: 0, mkT: 0,
    ai: ws ? null : { t: 0, gcd: 0, err: 0, tx: 0, tz: 0, strafe: 1, fire: false, q: false, e: false, u: false, roll: false, jump: false, target: null } };
  room.players.push(p); respawn(room, p); room.rosterDirty = true;
  return p;
}
function removePlayer(room, p) {
  const i = room.players.indexOf(p); if (i < 0) return;
  room.players.splice(i, 1); room.rosterDirty = true;
  if (!humans(room)) rooms.delete(room.code);
}
function addBot(room) {
  const used = new Set(room.players.map(p => p.name)), free = BOT_NAMES.filter(n => !used.has(n));
  const counts = { knight: 0, ranger: 0, mage: 0 };
  for (const q of room.players) if (counts[q.cls] !== undefined) counts[q.cls]++;
  const minC = Math.min(counts.knight, counts.ranger, counts.mage);
  const pool = CLS_IDS.filter(c => counts[c] === minC);
  makePlayer(room, free.length ? free[Math.random() * free.length | 0] : '角斗士', pool[Math.random() * pool.length | 0], null);
}
function manageBots(room) {
  const h = humans(room), bots = room.players.length - h;
  const want = h ? Math.min(room.botCount, Math.max(0, MAX_PLAYERS - h)) : 0;
  if (bots < want && room.players.length < MAX_PLAYERS) addBot(room);
  else if (bots > want) removePlayer(room, room.players.find(p => p.bot));
}

function confine(e) {
  for (const p of PILLARS) {
    const dx = e.x - p.x, dz = e.z - p.z, d = Math.hypot(dx, dz), min = p.r + PR;
    if (d < min) { if (d > 0.001) { e.x = p.x + dx * min / d; e.z = p.z + dz * min / d; } else e.x = p.x + min; }
  }
  const d = Math.hypot(e.x, e.z), max = R - PR;
  if (d > max) { e.x *= max / d; e.z *= max / d; }
}
function respawn(room, p) {
  let best = null, bs = -1;
  for (let i = 0; i < 12; i++) {
    const a = i / 12 * TAU + Math.random() * 0.3, r = 15 + Math.random() * 5, x = Math.sin(a) * r, z = Math.cos(a) * r;
    let md = 60; for (const o of room.players) if (o !== p && !o.dead) md = Math.min(md, Math.hypot(o.x - x, o.z - z));
    md += Math.random() * 2; if (md > bs || !best) { bs = md; best = { x, z }; }
  }
  Object.assign(p, { x: best.x, z: best.z, y: 0, vy: 0, air: false, hp: CLS[p.cls].hp, res: RES[CLS[p.cls].res].start, calm: 0, dead: false, kx: 0, kz: 0,
    dashT: 0, charging: false, rolling: false, chargeTarget: null, chargeTgId: 0, chargeDist: 0, cast: 0, inv: 0, prot: SPAWN_PROT, stun: 0, stunDR: 0, freeze: 0, slow: 0 });
  p.cd.atk = p.cd.q = p.cd.e = p.cd.dodge = 0;       // 大招冷却不随阵亡重置
  p.face = p.a = Math.atan2(-p.x, -p.z);
  if (p.ai) { p.ai.t = 0; p.ai.gcd = 0.35; }
  room.ev.push({ e: 'spawn', id: p.id });
}

/* ---------------- combat ---------------- */
function gain(p, v) { p.res = clamp(p.res + v, 0, RES_MAX); }
function pay(p, i) { const c = CLS[p.cls].cost[i]; if (p.res < c) return false; p.res -= c; return true; }
function cancelCast(room, p) {
  if (p.cast <= 0) return;
  p.cast = 0; p.cd.u = Math.max(p.cd.u, 1); room.ev.push({ e: 'cc', id: p.id });
}
function startCast(room, p) {
  const c = CLS[p.cls], t = aimPoint(p, c.range, p.ux, p.uz);   // ux / uz：按下大招键那一刻鼠标选定的位置
  p.cast = c.cast; p.castX = t.x; p.castZ = t.z; p.prot = 0;
  if (Math.hypot(t.x - p.x, t.z - p.z) > 0.2) p.face = Math.atan2(t.x - p.x, t.z - p.z);
  room.ev.push({ e: 'cs', id: p.id, x: r2(t.x), z: r2(t.z), d: c.cast, r: ULT[p.cls].zone.r });
}
function finishCast(room, p) {
  const c = CLS[p.cls], u = ULT[p.cls];
  p.cast = 0; p.cd.u = c.u; p.res = Math.max(0, p.res - c.cost[3]);
  room.ev.push({ e: 'atk', id: p.id, k: 'ult', a: r2(p.face) });
  addZone(room, p, u.k, p.castX, p.castZ, u.zone);
}
function damage(room, t, amt, by, o) {
  if (t.dead || t.inv > 0 || t.prot > 0 || room.phase !== 'play') return false;
  const mul = by && by.bot ? (BOT_DIFF[room.diff] || BOT_DIFF.normal).dmg : 1;
  let v = amt * mul * (0.92 + Math.random() * 0.16);
  const crit = Math.random() < 0.08; if (crit) v *= 1.6;
  v = Math.max(1, Math.round(v * CLS[t.cls].armor));
  t.hp -= v;
  if (by && by !== t) by.dmg = (by.dmg || 0) + v;
  if (by && by !== t && by.cls === 'knight') { gain(by, RES.rage.hit); by.calm = RES.rage.calm; }
  if (t.cls === 'knight') { gain(t, v * RES.rage.hurt); t.calm = RES.rage.calm; }
  if (o && o.kb) { const dx = t.x - o.fx, dz = t.z - o.fz, d = Math.hypot(dx, dz) || 1, kb = o.kb * (t.cls === 'knight' ? 0.6 : 1); t.kx += dx / d * kb; t.kz += dz / d * kb; }
  if (o && o.slow) t.slow = Math.max(t.slow, o.slow);
  if (o && (o.stun || o.freeze)) {
    if (o.stun) { const s = t.stunDR > 0 ? o.stun * 0.5 : o.stun; t.stun = Math.max(t.stun, s); t.stunDR = 3.5; }
    else t.freeze = Math.max(t.freeze, o.freeze);
    t.dashT = 0; t.charging = t.rolling = false; t.chargeTarget = null; cancelCast(room, t);      // 被控制会打断读条
  }
  room.ev.push({ e: 'hit', id: t.id, by: by ? by.id : 0, d: v, c: crit ? 1 : 0, s: o && o.sk ? 1 : 0 });   // s：技能伤害（客户端显示成黄字）
  if (t.hp <= 0) kill(room, t, by);
  return true;
}
function kill(room, t, by) {
  const prevSt = t.streak || 0;
  t.hp = 0; t.dead = true; t.respawnT = RESPAWN; t.deaths++; t.streak = 0; t.mk = 0; t.mkT = 0; t.dashT = 0; t.charging = t.rolling = false; t.cast = 0;
  const credit = by && by !== t && room.players.includes(by);
  let st = 0, mk = 0, fb = 0, sd = 0;
  if (credit) {
    if (!room.hasFb) { room.hasFb = true; fb = 1; }
    if (prevSt >= 3) sd = prevSt;
    by.kills++; by.streak = (by.streak || 0) + 1; st = by.streak;
    if (st > (by.maxStreak || 0)) by.maxStreak = st;
    by.mk = (by.mkT > 0 ? (by.mk || 0) : 0) + 1; by.mkT = 10; mk = by.mk;
    if (!by.dead) { const max = CLS[by.cls].hp, got = Math.min(30, max - by.hp); if (got > 0) { by.hp += got; room.ev.push({ e: 'heal', id: by.id, v: Math.round(got) }); } }
  }
  const ev = { e: 'kill', id: t.id, by: credit ? by.id : 0 };
  if (st >= 2) ev.st = st;
  if (mk >= 2) ev.mk = mk;
  if (fb) ev.fb = 1;
  if (sd) ev.sd = sd;
  room.ev.push(ev);
  room.rosterDirty = true;
  if (credit && by.kills >= KILL_TARGET) endRound(room);
}
function shoot(room, p, kind, a, o) {
  const pr = Object.assign({ id: room.nextObj++, kind, o: p, x: p.x + Math.sin(a) * 0.7, z: p.z + Math.cos(a) * 0.7,
    vx: Math.sin(a) * o.speed, vz: Math.cos(a) * o.speed, pierce: 0, splash: 0, grp: null, hit: new Set() }, o);
  room.proj.push(pr);
  room.ev.push({ e: 'p+', id: pr.id, k: kind, o: p.id, x: r2(pr.x), z: r2(pr.z), a: r2(a), sp: o.speed, l: o.life });
}
function aimPoint(p, maxR, ax = p.ax, az = p.az) {
  const dx = ax - p.x, dz = az - p.z, d = Math.hypot(dx, dz) || 1, k = Math.min(1, maxR / d);
  let x = p.x + dx * k, z = p.z + dz * k; const dd = Math.hypot(x, z);
  if (dd > R - 0.5) { x *= (R - 0.5) / dd; z *= (R - 0.5) / dd; }
  return { x, z };
}
function addZone(room, p, k, x, z, o) {
  room.zones.push(Object.assign({ k, o: p, x, z, t: 0, done: 0, next: 0, ticks: 1, iv: 0, slow: 0, kb: 0 }, o));
  room.ev.push({ e: 'z', k, o: p.id, x: r2(x), z: r2(z), r: o.r, d: o.delay, n: o.ticks || 1, iv: o.iv || 0 });
}
function foes(room, p) { return room.players.filter(o => o !== p && !o.dead); }

function attack(room, p) {
  const a = p.face; p.cd.atk = CLS[p.cls].atkCd; p.prot = 0;
  if (p.cls === 'knight') {
    room.ev.push({ e: 'atk', id: p.id, k: 'slash', a: r2(a) });
    for (const o of foes(room, p)) {
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
      if (d < 3.3 + PR && (d < 1.35 || Math.abs(angDiff(Math.atan2(dx, dz), a)) < 1.15)) damage(room, o, 24, p, { kb: 2.5, fx: p.x, fz: p.z });
    }
  } else if (p.cls === 'ranger') {
    room.ev.push({ e: 'atk', id: p.id, k: 'shoot', a: r2(a) });
    shoot(room, p, 'arrow', a, { speed: 30, dmg: 14, life: 1.0, pierce: 1 });
  } else {
    room.ev.push({ e: 'atk', id: p.id, k: 'cast', a: r2(a) });
    shoot(room, p, 'fire', a, { speed: 24.5, dmg: 23, life: 1.25, splash: 2.35 });
  }
}
function skill(room, p, slot) {
  const c = CLS[p.cls], a = p.face; if (slot < 2) p.cd[slot ? 'e' : 'q'] = slot ? c.e : c.q; p.prot = 0;
  if (p.cls === 'knight' && !slot) {                   // 盾牌猛击：面前扇形，击晕
    room.ev.push({ e: 'atk', id: p.id, k: 'bash', a: r2(a) }); gain(p, RES.rage.bash); p.calm = RES.rage.calm;
    for (const o of foes(room, p)) {
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
      if (d < 3.1 + PR && (d < 1.35 || Math.abs(angDiff(Math.atan2(dx, dz), a)) < 1.05)) damage(room, o, 28, p, { kb: 4, fx: p.x, fz: p.z, stun: 0.95, sk: 1 });
    }
  } else if (slot === 2) {                             // 冲锋（骑士的 5 号位移技能）
    const tg = p.chargeTgId ? foes(room, p).find(o => o.id === p.chargeTgId && Math.hypot(o.x - p.x, o.z - p.z) <= CHARGE.maxDist) : null;
    const ca = tg ? Math.atan2(tg.x - p.x, tg.z - p.z) : a;
    p.chargeTarget = tg; p.chargeTgId = 0; p.chargeDist = 0;
    p.dashT = tg ? 0.6 : CHARGE.dur; p.dashSp = CHARGE.sp; p.dashX = Math.sin(ca); p.dashZ = Math.cos(ca); p.charging = true; p.rolling = false; p.chargeHit = new Set(); p.inv = Math.max(p.inv, 0.45);
    gain(p, RES.rage.charge); p.calm = RES.rage.calm;                       // 冲锋不耗怒气，反而攒怒气
    room.ev.push({ e: 'atk', id: p.id, k: 'charge', a: r2(ca), ...(tg ? { tg: tg.id, dur: 0.6 } : {}) });
  } else if (p.cls === 'knight') {
    room.ev.push({ e: 'atk', id: p.id, k: 'spin', a: r2(a) });
    let hits = 0;
    for (const o of foes(room, p)) if (Math.hypot(o.x - p.x, o.z - p.z) < 4.4 + PR) { if (damage(room, o, 48, p, { kb: 6, fx: p.x, fz: p.z, sk: 1 })) hits++; }
    if (hits && !p.dead) { const max = CLS.knight.hp, got = Math.min(27, hits * 9, max - p.hp); if (got > 0) { p.hp += got; room.ev.push({ e: 'heal', id: p.id, v: Math.round(got) }); } }
  } else if (p.cls === 'ranger' && !slot) {
    room.ev.push({ e: 'atk', id: p.id, k: 'shoot', a: r2(a) });
    const grp = new Map();
    for (let i = -2; i <= 2; i++) shoot(room, p, 'arrow', a + i * 0.14, { speed: 30, dmg: 14, life: 1.0, pierce: 1, grp, slow: 1.8, sk: 1 });
  } else if (p.cls === 'ranger') {
    const t = aimPoint(p, 15);
    room.ev.push({ e: 'atk', id: p.id, k: 'shoot', a: r2(a) });
    addZone(room, p, 'rain', t.x, t.z, { r: 4.5, delay: 0.35, ticks: 6, iv: 0.3, dmg: 13, slow: 1.2 });
  } else if (!slot) {
    room.ev.push({ e: 'atk', id: p.id, k: 'nova', a: r2(a) });
    for (const o of foes(room, p)) if (Math.hypot(o.x - p.x, o.z - p.z) < 5.8 + PR) damage(room, o, 26, p, { freeze: 1.45, sk: 1 });
  } else {
    const t = aimPoint(p, 17);
    room.ev.push({ e: 'atk', id: p.id, k: 'call', a: r2(a) });
    addZone(room, p, 'meteor', t.x, t.z, { r: 4.6, delay: 0.58, dmg: 76, kb: 9 });
  }
}

function updatePlayer(room, p) {
  if (p.bot) botThink(room, p);
  const b = p.pend; p.pend = 0;
  if (p.dead) { p.respawnT -= DT; if (p.respawnT <= 0) respawn(room, p); return; }
  const c = CLS[p.cls], rs = RES[c.res], cd = p.cd; cd.atk -= DT; cd.q -= DT; cd.e -= DT; cd.u -= DT; cd.dodge -= DT;
  if (p.inv > 0) p.inv -= DT; if (p.prot > 0) p.prot -= DT; if (p.slow > 0) p.slow -= DT; if (p.stunDR > 0) p.stunDR -= DT; if (p.mkT > 0) p.mkT -= DT;
  if (rs.regen) p.res = Math.min(RES_MAX, p.res + rs.regen * DT);
  else if ((p.calm -= DT) <= 0) p.res = Math.max(0, p.res - rs.decay * DT);
  p.x += p.kx * DT; p.z += p.kz * DT; const damp = Math.exp(-9 * DT); p.kx *= damp; p.kz *= damp;
  if (p.air) { p.vy -= JUMP.g * DT; p.y += p.vy * DT; if (p.y <= 0) { p.y = 0; p.vy = 0; p.air = false; } }
  p.moving = false;
  const mv = MOVE[p.cls];
  if ((b & 8) && cd.dodge <= 0 && !p.dead && mv.k === 'blink' && (p.stun > 0 || p.freeze > 0)) {
    p.stun = p.freeze = p.slow = 0;                    // 法师闪现可解晕/解冻脱困
  }
  if (p.freeze > 0) p.freeze -= DT;
  else if (p.stun > 0) p.stun -= DT;
  else if (p.dashT > 0) {
    if (p.charging && p.chargeTarget) {
      const tg = p.chargeTarget;
      if (tg.dead || !room.players.includes(tg)) p.chargeTarget = null;
      else {
        const dx = tg.x - p.x, dz = tg.z - p.z, dist = Math.hypot(dx, dz);
        if (dist > CHARGE.maxGap) p.chargeTarget = null;
        else if (dist > 0.05) { p.dashX = dx / dist; p.dashZ = dz / dist; }
      }
    }
    const step = p.dashSp * DT;
    p.dashT -= DT; p.x += p.dashX * step; p.z += p.dashZ * step;
    if (p.charging) {
      p.chargeDist += step;
      p.face = Math.atan2(p.dashX, p.dashZ);
      for (const o of foes(room, p)) if (!p.chargeHit.has(o) && Math.hypot(o.x - p.x, o.z - p.z) < PR * 2 + 0.95) {
        p.chargeHit.add(o); damage(room, o, 28, p, { kb: 10, fx: p.x - p.dashX, fz: p.z - p.dashZ, stun: 0.85, sk: 1 });
        if (o === p.chargeTarget) { p.dashT = 0; break; }
      }
      if (p.chargeDist >= CHARGE.maxDist || (!p.chargeTarget && p.chargeDist >= CHARGE.dur * CHARGE.sp)) p.dashT = 0;
    }
    if (p.dashT <= 0) { if (p.charging) p.inv = Math.min(p.inv, 0.08); p.charging = p.rolling = false; p.chargeTarget = null; }
  } else {
    const ml = Math.hypot(p.mx, p.mz), sp = c.speed * (p.slow > 0 ? SLOW_K : 1) * (p.bot ? (BOT_DIFF[room.diff] || BOT_DIFF.normal).spd : 1);
    if (p.cast > 0) {                                  // 读条：必须站定，移动 / 跳跃 / 翻滚 / 主动取消都会打断
      if (ml > 0.15 || (b & 88)) cancelCast(room, p);
      else if ((p.cast -= DT) <= 0) finishCast(room, p);
    }
    if (p.cast > 0) { confine(p); return; }
    if (p.air) { p.x += p.jx * DT; p.z += p.jz * DT; }  // 空中保持起跳时的水平速度，不能变向
    else { p.x += p.mx * sp * DT; p.z += p.mz * sp * DT; p.moving = ml > 0.15; }
    p.face = p.a;
    if ((b & 16) && !p.air) {
      p.air = true; p.vy = JUMP.v; p.jx = p.mx * sp; p.jz = p.mz * sp; p.moving = false;
      room.ev.push({ e: 'atk', id: p.id, k: 'jump', a: r2(p.face) });
    }
    if ((b & 1) && cd.atk <= 0 && pay(p, 0)) attack(room, p);
    if ((b & 2) && cd.q <= 0 && !p.dead && pay(p, 1)) skill(room, p, 0);
    if ((b & 4) && cd.e <= 0 && !p.dead && pay(p, 2)) skill(room, p, 1);
    if ((b & 32) && cd.u <= 0 && !p.dead && !p.air && ml <= 0.15 && p.res >= c.cost[3]) startCast(room, p);
    if ((b & 8) && cd.dodge <= 0 && p.dashT <= 0 && !p.dead && mv.k !== 'roll') {
      cd.dodge = mv.cd; p.prot = 0;
      if (mv.k === 'charge') skill(room, p, 2);
      else {                                           // 闪现：朝移动方向（没在移动就朝面向）瞬移，并解除减速
        const dx = ml > 0.15 ? p.mx / ml : Math.sin(p.face), dz = ml > 0.15 ? p.mz / ml : Math.cos(p.face), fx = p.x, fz = p.z;
        p.x += dx * mv.dist; p.z += dz * mv.dist; confine(p); p.kx = p.kz = 0; p.slow = 0; p.inv = Math.max(p.inv, 0.35);
        room.ev.push({ e: 'atk', id: p.id, k: 'blink', a: r2(Math.atan2(dx, dz)), x: r2(fx), z: r2(fz), tx: r2(p.x), tz: r2(p.z) });
      }
    } else if ((b & 8) && cd.dodge <= 0 && p.dashT <= 0 && !p.dead) {
      cd.dodge = ROLL.cd; p.dashT = ROLL.dur; p.dashSp = ROLL.sp; p.rolling = true; p.charging = false; p.slow = 0;
      if (p.moving) { p.dashX = p.mx / ml; p.dashZ = p.mz / ml; } else { p.dashX = Math.sin(p.face); p.dashZ = Math.cos(p.face); }
      p.inv = Math.max(p.inv, ROLL.inv);
      room.ev.push({ e: 'atk', id: p.id, k: 'roll', a: r2(Math.atan2(p.dashX, p.dashZ)) });
    }
  }
  confine(p);
}
function separate(room) {
  const ps = room.players;
  for (let i = 0; i < ps.length; i++) for (let j = 0; j < i; j++) {
    const a = ps[i], b = ps[j]; if (a.dead || b.dead || a.dashT > 0 || b.dashT > 0) continue;
    const dx = a.x - b.x, dz = a.z - b.z, d = Math.hypot(dx, dz), min = PR * 2 - 0.1;
    if (d < min && d > 0.001) { const k = (min - d) / d * 0.5; a.x += dx * k; a.z += dz * k; b.x -= dx * k; b.z -= dz * k; confine(a); confine(b); }
  }
}
function updateProj(room) {
  const ps = room.proj;
  for (let i = ps.length - 1; i >= 0; i--) {
    const pr = ps[i]; let gone = false, hit = 0;
    for (let s = 0; s < 2 && !gone; s++) {
      pr.x += pr.vx * DT / 2; pr.z += pr.vz * DT / 2;
      if (Math.hypot(pr.x, pr.z) > R + 0.4) gone = true;
      for (const c of PILLARS) if (Math.hypot(pr.x - c.x, pr.z - c.z) < c.r + 0.1) gone = true;
      if (gone) break;
      for (const t of room.players) {
        if (t === pr.o || t.dead || t.inv > 0 || pr.hit.has(t)) continue;
        if (Math.hypot(t.x - pr.x, t.z - pr.z) > 0.4 + PR) continue;
        pr.hit.add(t);
        if (pr.grp) { const n = pr.grp.get(t.id) || 0; if (n >= 2) continue; pr.grp.set(t.id, n + 1); }
        damage(room, t, pr.dmg, pr.o, { kb: 3.5, fx: pr.x - pr.vx, fz: pr.z - pr.vz, slow: pr.slow, sk: pr.sk });
        hit = 1;
        if (pr.splash || pr.pierce-- <= 0) gone = true;
        break;
      }
    }
    pr.life -= DT; if (pr.life <= 0) gone = true;
    if (gone) {
      if (pr.splash) for (const t of room.players) {
        if (t === pr.o || t.dead || pr.hit.has(t)) continue;
        if (Math.hypot(t.x - pr.x, t.z - pr.z) < pr.splash + PR) damage(room, t, pr.dmg * 0.6, pr.o, { kb: 4, fx: pr.x, fz: pr.z });
      }
      room.ev.push({ e: 'p-', id: pr.id, x: r2(pr.x), z: r2(pr.z), h: hit });
      ps.splice(i, 1);
    }
  }
}
function blast(room, z) {
  for (const t of room.players) {
    if (t === z.o || t.dead) continue;
    if (Math.hypot(t.x - z.x, t.z - z.z) < z.r + PR) damage(room, t, z.dmg, z.o, { kb: z.kb, fx: z.x, fz: z.z, slow: z.slow, stun: z.stun, sk: 1 });
  }
}
function updateZones(room) {
  const zs = room.zones;
  for (let i = zs.length - 1; i >= 0; i--) {
    const z = zs[i]; z.t += DT;
    if (z.done === 0) { if (z.t >= z.delay) { blast(room, z); z.done = 1; z.next = z.delay + z.iv; } }
    else if (z.done < z.ticks && z.t >= z.next) { blast(room, z); z.done++; z.next += z.iv; }
    if (z.done >= z.ticks) zs.splice(i, 1);
  }
}
function updatePicks(room) {
  room.pickT -= DT;
  if (room.pickT <= 0) {
    room.pickT = 7;
    if (room.picks.length < 4) {
      const k = { id: room.nextObj++, x: 0, z: 0 };
      for (let n = 0; n < 8; n++) {
        const a = Math.random() * TAU, d = 3 + Math.random() * 16; k.x = Math.sin(a) * d; k.z = Math.cos(a) * d;
        if (PILLARS.every(c => Math.hypot(k.x - c.x, k.z - c.z) > c.r + 1.2)) break;
      }
      room.picks.push(k);
    }
  }
  for (let i = room.picks.length - 1; i >= 0; i--) {
    const k = room.picks[i];
    for (const p of room.players) {
      const max = CLS[p.cls].hp;
      if (p.dead || p.hp >= max || Math.hypot(p.x - k.x, p.z - k.z) > 1.1) continue;
      const got = Math.min(max - p.hp, Math.round(max * 0.35)); p.hp += got;
      room.ev.push({ e: 'pk', id: p.id, v: got }); room.picks.splice(i, 1); break;
    }
  }
}

/* ---------------- bots ---------------- */
function botThink(room, p) {
  const ai = p.ai, df = BOT_DIFF[room.diff] || BOT_DIFF.normal;
  p.pend = 0; p.mx = p.mz = 0;
  if (p.dead || p.cast > 0) return;                    // 读条时站定不动
  if (ai.gcd > 0) ai.gcd -= DT;
  ai.t -= DT;
  if (ai.t <= 0) {
    ai.t = df.dtMin + Math.random() * df.dtVar; ai.err = (Math.random() - 0.5) * df.err;
    if (Math.random() < 0.3) ai.strafe = -ai.strafe;
    ai.fire = Math.random() < df.fire; ai.q = Math.random() < df.q; ai.e = Math.random() < df.e; ai.roll = Math.random() < df.roll;
    ai.u = Math.random() < df.u; ai.jump = Math.random() < 0.05;
    let best = null, bd = 1e9;
    for (const o of room.players) {
      if (o === p || o.dead) continue;
      const d = Math.hypot(o.x - p.x, o.z - p.z) - (o === ai.target ? 1.5 : 0) + Math.random() * 2.5;
      if (d < bd) { bd = d; best = o; }
    }
    ai.target = best;
    if (best) { ai.tx = best.x + (Math.random() - 0.5) * df.err * 3; ai.tz = best.z + (Math.random() - 0.5) * df.err * 3; }
  }
  const t = ai.target;
  if (!t || t.dead || !room.players.includes(t)) {
    ai.target = null; const d = Math.hypot(p.x, p.z);
    if (d > 6) { p.mx = -p.x / d * 0.6; p.mz = -p.z / d * 0.6; p.a = Math.atan2(-p.x, -p.z); }
    return;
  }
  ai.tx += (t.x - ai.tx) * 5.5 * DT; ai.tz += (t.z - ai.tz) * 5.5 * DT;
  let dx = t.x - p.x, dz = t.z - p.z; const d = Math.hypot(dx, dz) || 1; dx /= d; dz /= d;
  const melee = p.cls === 'knight', want = melee ? 1.5 : p.cls === 'ranger' ? 9.5 : 8.5;
  let mx, mz;
  if (d > want + 1.5) { mx = dx; mz = dz; }
  else if (!melee && d < want - 2.2) { mx = -dx + dz * ai.strafe * 0.45; mz = -dz - dx * ai.strafe * 0.45; }
  else { mx = dz * ai.strafe; mz = -dx * ai.strafe; if (melee) { mx = mx * 0.4 + dx * 0.7; mz = mz * 0.4 + dz * 0.7; } }
  if (p.hp < CLS[p.cls].hp * 0.35 && room.picks.length) {
    let bk = null, bd = 12; for (const k of room.picks) { const kd = Math.hypot(k.x - p.x, k.z - p.z); if (kd < bd) { bd = kd; bk = k; } }
    if (bk) { mx = (bk.x - p.x) / (bd || 1); mz = (bk.z - p.z) / (bd || 1); }
  }
  const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
  p.mx = mx; p.mz = mz;
  const wantA = Math.atan2(ai.tx - p.x, ai.tz - p.z) + ai.err * (melee ? 0.5 : 0.75);
  p.a += clamp(angDiff(wantA, p.a), -df.turn * DT, df.turn * DT);
  p.ax = ai.tx + ai.err * 2.5; p.az = ai.tz - ai.err * 2.5;
  const aimed = Math.abs(angDiff(wantA, p.a)) < 0.85;
  let b = 0;
  if (ai.fire && aimed && d < (melee ? 3.2 : 15.5)) b |= 1;
  if (ai.gcd <= 0 && aimed) {
    const c = CLS[p.cls];
    if (ai.u && p.cd.u <= 0 && !p.air && p.res >= c.cost[3] && d > 3.5 && d < c.range) {
      ai.u = false; ai.gcd = df.gcd + 0.4; p.mx = p.mz = 0; p.ux = p.ax; p.uz = p.az; b = 32;
    } else if (melee && d > 4.2 && d < 14 && ai.roll && p.cd.dodge <= 0) {
      ai.roll = false; ai.gcd = df.gcd; p.chargeTgId = t.id; b |= 8;
    } else if (!melee && p.cd.dodge <= 0 && ((ai.roll && d < 5.5) || d < 3.4 || p.stun > 0.2 || p.freeze > 0.2)) {
      ai.roll = false; ai.gcd = df.gcd; p.mx = -dx; p.mz = -dz; b |= 8;
    } else if (ai.q && p.cd.q <= 0 && (melee ? d < 3.0 : p.cls === 'ranger' ? d < 9.5 : d < 5.6)) {
      ai.q = false; ai.gcd = df.gcd; b |= 2;
    } else if (ai.e && p.cd.e <= 0 && (melee ? d < 3.8 : d < 14)) {
      ai.e = false; ai.gcd = df.gcd; b |= 4;
    }
  }
  if (ai.jump && ml > 0.3) { b |= 16; ai.jump = false; }
  p.pend = b;
}

/* ---------------- rounds & tick ---------------- */
function endRound(room) { if (room.phase !== 'play') return; room.phase = 'end'; room.phaseT = END_TIME; room.rosterDirty = true; }
function startRound(room) {
  room.phase = 'play'; room.roundT = ROUND_TIME; room.proj.length = room.zones.length = room.picks.length = 0; room.pickT = 6; room.hasFb = false;
  for (const p of room.players) { p.kills = p.deaths = p.dmg = p.streak = p.maxStreak = p.mk = p.mkT = 0; p.dead = false; p.cd.u = 0; }
  for (const p of room.players) respawn(room, p);
  room.rosterDirty = true;
}
function tickRoom(room) {
  const prev2s = Math.floor(room.time / 2);
  room.time += DT;
  if (Math.floor(room.time / 2) !== prev2s) room.rosterDirty = true;
  room.botT -= DT; if (room.botT <= 0) { room.botT = 1; manageBots(room); }
  if (room.phase === 'end') { room.phaseT -= DT; if (room.phaseT <= 0) startRound(room); }
  else {
    if (room.players.length >= 2) { room.roundT -= DT; if (room.roundT <= 0) endRound(room); }
    for (const p of room.players.slice()) updatePlayer(room, p);
    separate(room); updateProj(room); updateZones(room); updatePicks(room);
  }
  broadcast(room);
}
function send(ws, str) { if (ws.readyState === 1 && ws.bufferedAmount < 1 << 20) ws.send(str); }
function broadcast(room) {
  if (room.rosterDirty) {
    room.rosterDirty = false;
    const msg = JSON.stringify({ t: 'roster', list: room.players.map(p => ({ id: p.id, n: p.name, c: CLS_IDS.indexOf(p.cls), k: p.kills, d: p.deaths, dmg: Math.round(p.dmg || 0), st: p.maxStreak || 0, b: p.bot ? 1 : 0 })) });
    for (const p of room.players) if (p.ws) send(p.ws, msg);
  }
  const end = room.phase === 'end';
  const shared = JSON.stringify({
    ts: Math.round(room.time * 1000) / 1000, ph: end ? 1 : 0, rt: Math.max(0, Math.ceil(end ? room.phaseT : room.roundT)),
    p: room.players.map(p => [p.id, r2(p.x), r2(p.z), r2(p.face), Math.max(0, Math.round(p.hp)),
      (p.dead ? 1 : 0) | (p.inv > 0 ? 2 : 0) | (p.dashT > 0 && p.rolling ? 4 : 0) | (p.dashT > 0 && p.charging ? 8 : 0) | (p.freeze > 0 ? 16 : 0) |
      (p.stun > 0 ? 32 : 0) | (p.slow > 0 ? 64 : 0) | (p.prot > 0 ? 128 : 0) | (p.moving ? 256 : 0) | (p.air ? 512 : 0) | (p.cast > 0 ? 1024 : 0),
      CLS_IDS.indexOf(p.cls), r2(p.y)]),
    k: room.picks.map(k => [k.id, r2(k.x), r2(k.z)]), ev: room.ev,
  });
  room.ev = [];
  const cdv = v => v > 0 ? Math.round(v * 20) / 20 : 0;
  // 每个人自己的部分：冷却 [2 号, 3 号, 翻滚, 4 号, 普攻]、资源、读条剩余、重生倒计时
  for (const p of room.players) if (p.ws) send(p.ws, '{"t":"s","ack":' + p.seq + ',"cd":[' + cdv(p.cd.q) + ',' + cdv(p.cd.e) + ',' + cdv(p.cd.dodge) + ',' + cdv(p.cd.u) + ',' + cdv(p.cd.atk) +
    '],"res":' + Math.round(p.res) + ',"ct":' + cdv(p.cast) + ',"rs":' + cdv(p.dead ? p.respawnT : 0) + ',"w":' + shared + '}');
}
let lastT = process.hrtime.bigint(), acc = 0;
setInterval(() => {
  const now = process.hrtime.bigint(); acc += Number(now - lastT) / 1e9; lastT = now;
  if (acc > 0.25) acc = 0.25;
  while (acc >= DT) {
    acc -= DT;
    const t0 = process.hrtime.bigint();
    for (const room of [...rooms.values()]) {
      try { tickRoom(room); }
      catch (err) {                                   // 一个房间出错不能拖垮其他房间：记录、关闭这个房间
        logDebug('ERROR', 'room', '房间 ' + room.code + ' 出错，已关闭', { room: room.code, err: String(err && err.stack || err) });
        rooms.delete(room.code);
        for (const p of room.players) if (p.ws) { p.ws.room = p.ws.player = null; p.ws.close(1011); }
      }
    }
    const dtMs = Number(process.hrtime.bigint() - t0) / 1e6;
    tickSumMs += dtMs; if (dtMs > tickMaxMs) tickMaxMs = dtMs; tickCount++;
  }
}, 5);

/* ---------------- connections ---------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
const ipConns = new Map();
wss.on('connection', (ws, req) => {
  const ip = clientIp(req), ua = clientUa(req), curIp = ipConns.get(ip) || 0;
  if (wss.clients.size > MAX_CONNECTIONS || curIp >= MAX_CONN_PER_IP || isRateLimited(ip)) {
    logAccess({ ip, ua, event: 'ws_rejected', status: 1013, detail: { conns: wss.clients.size, curIp } });
    ws.close(1013);
    return;
  }
  ipConns.set(ip, curIp + 1);
  ws.alive = true; ws.player = null; ws.room = null; ws.msgN = 0; ws.joinAt = 0;
  const joinTimer = setTimeout(() => { if (!ws.player) ws.terminate(); }, 5000);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', err => { logDebug('WARN', 'ws', 'WebSocket 错误', { ip, err: String(err && err.message || err) }); });
  ws.on('close', () => {
    clearTimeout(joinTimer);
    const n = (ipConns.get(ip) || 1) - 1;
    if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n);
    if (ws.room && ws.player) {
      const p = ws.player, durSec = ws.joinAt ? Math.round((Date.now() - ws.joinAt) / 1000) : 0;
      logAccess({ ip, ua, event: 'ws_leave', room: ws.room.code, name: p.name, cls: p.cls, detail: { durSec, kills: p.kills, deaths: p.deaths } });
      logDebug('DEBUG', 'room', '玩家离开房间', { ip, room: ws.room.code, name: p.name, durSec, kills: p.kills, deaths: p.deaths });
      removePlayer(ws.room, ws.player);
    }
    ws.room = ws.player = null;
  });
  ws.on('message', data => {
    totalWsMsgs++;
    if (++ws.msgN > 150) return;                      // 每秒上限，在心跳里清零
    let m; try { m = JSON.parse(data); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (!ws.player && m.t !== 'join') { ws.close(1008); return; }
    if (m.t === 'in') {
      const p = ws.player; if (!p) return;
      const s = m.s | 0; if (s <= p.seq) return; p.seq = s;
      let mx = num(m.mx), mz = num(m.mz); const l = Math.hypot(mx, mz); if (l > 1) { mx /= l; mz /= l; }
      p.mx = mx; p.mz = mz; p.a = num(m.a) % TAU; p.ax = clamp(num(m.ax), -R, R); p.az = clamp(num(m.az), -R, R);
      const b = (m.b | 0) & 127;                        // 1 普攻 2/4 技能 8 翻滚 16 跳跃 32 大招读条 64 取消读条
      if (b & 32) { p.ux = p.ax; p.uz = p.az; }         // 记住选定的位置，免得被后面的输入包覆盖
      if (b & 8) p.chargeTgId = m.tg | 0;
      p.pend |= b;
    } else if (m.t === 'join' && !ws.player) {
      if (isRateLimited(ip) || (!verifySessionToken(m.token) && !checkPass(m.pass))) {
        recordAuthFail(ip);
        logAccess({ ip, ua, event: 'ws_auth_fail', status: 4001 });
        logDebug('WARN', 'ws', 'WebSocket join 口令错误', { ip });
        send(ws, JSON.stringify({ t: 'denied', msg: '访问口令错误或已失效' }));
        ws.close(4001);
        return;
      }
      const cls = CLS_IDS.includes(m.cls) ? m.cls : 'knight';
      const code = cleanRoomCode(m.room);
      const bots = Number.isFinite(Number(m.bots)) ? clamp(Math.floor(Number(m.bots)), 0, MAX_PLAYERS - 1) : Math.max(0, BOT_FILL - 1);
      const diff = typeof m.diff === 'string' && BOT_DIFF[m.diff] ? m.diff : 'normal';
      let room, created = false;
      if (m.create) {                                    // DEMO 禁止自定义房间号：创建房间一律由服务器随机生成 4 位房间号
        if (rooms.size >= MAX_ROOMS) { send(ws, '{"t":"full"}'); ws.close(1013); return; }
        room = makeRoom(randomCode(), false, bots, diff); created = true;
      } else if (code) {                                 // 仅允许加入已存在的房间，不允许通过自定义房间号新建房间
        room = rooms.get(code);
        if (!room) { send(ws, '{"t":"noroom","msg":"该房间不存在或已结束，请检查房间号"}'); ws.close(1000); return; }
      } else {
        for (const r of rooms.values()) if (!r.priv && r.diff === diff && humans(r) < MAX_PLAYERS && (!room || humans(r) > humans(room))) room = r;
        if (!room) {
          if (rooms.size >= MAX_ROOMS) { send(ws, '{"t":"full"}'); ws.close(1013); return; }
          room = makeRoom(randomCode(), false, bots, diff); created = true;
        }
      }
      if (room.players.length >= MAX_PLAYERS) {
        const bot = room.players.find(p => p.bot);
        if (!bot) { send(ws, '{"t":"full"}'); ws.close(1000); return; }
        removePlayer(room, bot);
        if (!rooms.has(room.code)) rooms.set(room.code, room);
      }
      clearTimeout(joinTimer);
      const used = new Set(room.players.map(q => q.name));
      const freeNames = PLAYER_NAMES.filter(n => !used.has(n));
      const autoName = freeNames.length ? freeNames[Math.random() * freeNames.length | 0] : ('勇士' + room.nextId);
      const p = makePlayer(room, autoName, cls, ws);
      ws.player = p; ws.room = room; ws.joinAt = Date.now();
      logAccess({ ip, ua, event: 'ws_join', room: room.code, name: p.name, cls: p.cls, detail: { created, bots: room.botCount, diff: room.diff, humans: humans(room) } });
      logDebug('INFO', 'room', (created ? '创建并加入房间 ' : '加入房间 ') + room.code, { ip, room: room.code, name: p.name, cls: p.cls, bots: room.botCount, diff: room.diff });
      send(ws, JSON.stringify({ t: 'welcome', id: p.id, name: p.name, cls: p.cls, room: room.code, diff: room.diff, x: r2(p.x), z: r2(p.z),
        cfg: { cls: CLS, res: RES, resMax: RES_MAX, ult: ULT, move: MOVE, rollCd: ROLL.cd, rollDur: ROLL.dur, rollSp: ROLL.sp, chargeDur: CHARGE.dur, chargeSp: CHARGE.sp,
          jumpV: JUMP.v, jumpG: JUMP.g, slowK: SLOW_K, target: KILL_TARGET, max: MAX_PLAYERS } }));
    }
  });
});
setInterval(() => {
  for (const ws of wss.clients) { ws.msgN = 0; }
}, 1000);
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of authFailures) if (now > rec.resetAt) authFailures.delete(ip);
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
}, 15000);
setInterval(() => { sampleLoad(); }, 30000);
setInterval(() => {
  try {
    db.exec(`
      DELETE FROM access_logs WHERE id NOT IN (SELECT id FROM access_logs ORDER BY id DESC LIMIT 50000);
      DELETE FROM load_metrics WHERE id NOT IN (SELECT id FROM load_metrics ORDER BY id DESC LIMIT 20000);
      DELETE FROM debug_logs WHERE id NOT IN (SELECT id FROM debug_logs ORDER BY id DESC LIMIT 20000);
    `);
  } catch (e) {}
}, 3600000);

server.headersTimeout = 10000;
server.requestTimeout = 10000;
server.keepAliveTimeout = 5000;

/* ---------------- dedicated admin server (ADMIN_PORT) ---------------- */
const adminServer = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { res.writeHead(400); return res.end(); }
  const p = u.pathname;
  const ip = clientIp(req), ua = clientUa(req);
  if (HONEYPOT_RE.test(p)) return handleHoneypot(req, res, p, ip, ua);
  if (p !== '/' && p !== '/admin' && p !== '/admin/stats') { res.writeHead(404); return res.end('404'); }
  const authHdr = req.headers.authorization || '';
  const bearer = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const token = req.headers['x-admin-token'] || bearer || '';
  if (isRateLimited(ip) || !checkAdmin(token)) {
    if (!isRateLimited(ip)) recordAuthFail(ip);
    logAccess({ ip, ua, event: 'admin_denied', method: req.method, path: p, status: 401 });
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: false, msg: '未授权' }));
  }
  logAccess({ ip, ua, event: 'admin_view', method: req.method, path: p, status: 200 });
  const mem = process.memoryUsage();
  const stats = {
    ok: true,
    uptime_sec: Math.round(process.uptime()),
    now: new Date().toISOString(),
    current: { rss_mb: r2(mem.rss / 1048576), heap_mb: r2(mem.heapUsed / 1048576), load_1m: r2(os.loadavg()[0] || 0), ws_conns: wss.clients.size, rooms: rooms.size },
    honeypot_hits: db.query("SELECT id, ts, ip, method, path, ua, detail FROM access_logs WHERE event='honeypot_hit' ORDER BY id DESC LIMIT 30"),
    visitor_ips: db.query("SELECT ip, COUNT(*) AS hits, MAX(ts) AS last_seen, SUM(CASE WHEN event='ws_join' THEN 1 ELSE 0 END) AS joins, SUM(CASE WHEN event='auth_fail' THEN 1 ELSE 0 END) AS auth_fails, SUM(CASE WHEN event='honeypot_hit' THEN 1 ELSE 0 END) AS honeypots FROM access_logs GROUP BY ip ORDER BY last_seen DESC LIMIT 50"),
    recent_access: db.query('SELECT * FROM access_logs ORDER BY id DESC LIMIT 40'),
    recent_load: db.query('SELECT * FROM load_metrics ORDER BY id DESC LIMIT 40'),
    recent_debug: db.query('SELECT * FROM debug_logs ORDER BY id DESC LIMIT 40'),
  };
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(stats, null, 2));
});
adminServer.headersTimeout = 10000;
adminServer.requestTimeout = 10000;
adminServer.keepAliveTimeout = 5000;
adminServer.on('error', err => logDebug('ERROR', 'server', '管理端口启动失败', { port: ADMIN_PORT, err: String(err && err.message || err) }));

server.listen(PORT, HOST, () => {
  sampleLoad();
  logDebug('INFO', 'server', '烬冠竞技场 DEMO 服务器已启动', { port: PORT, adminPort: (ADMIN_PORT > 0 && ADMIN_HASH) ? ADMIN_PORT : 0, adminHost: ADMIN_HOST, host: HOST, db: DB_PATH, maxPlayers: MAX_PLAYERS, botFill: BOT_FILL });
  if (DEMO_PASS_AUTO) logDebug('WARN', 'auth', '未配置 DEMO_PASS 环境变量，本次启动已生成临时随机口令: ' + DEMO_PASS);
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log('  局域网： http://' + i.address + ':' + PORT);
});
if (ADMIN_PORT > 0 && ADMIN_HASH) adminServer.listen(ADMIN_PORT, ADMIN_HOST);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  logDebug('INFO', 'server', '收到退出信号 ' + sig + '，正在关闭服务器');
  for (const ws of wss.clients) ws.close(1001);
  try { adminServer.close(); } catch (e) {}
  server.close(() => { try { db.close(); } catch (e) {} process.exit(0); });
  setTimeout(() => { try { db.close(); } catch (e) {} process.exit(0); }, 500);
});
