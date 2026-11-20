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
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3001;
const ADMIN_HOST = process.env.ADMIN_HOST || '127.0.0.1';
const CORS_RAW = String(process.env.CORS_ORIGIN || 'https://game.needcoffee.icu').trim();
const CORS_ORIGINS = CORS_RAW === '*' ? null : new Set(CORS_RAW.split(',').map(s => s.trim()).filter(Boolean));
const SSL_CERT = String(process.env.SSL_CERT || '').trim();
const SSL_KEY = String(process.env.SSL_KEY || '').trim();
const HTTP_REDIRECT_URL = String(process.env.HTTP_REDIRECT_URL || 'https://game.needcoffee.icu').trim().replace(/\/+$/, '');
// TRUST_PROXY=1：信任任何来源的 X-Forwarded-For；TRUST_PROXY=ip1,ip2：只信任来自这些反向代理的
const TP_RAW = String(process.env.TRUST_PROXY || '').trim();
const TRUST_PROXY = TP_RAW !== '' && TP_RAW !== '0';
const TRUSTED_PROXIES = TP_RAW === '1' ? null : new Set(TP_RAW.split(',').map(s => s.trim()).filter(Boolean));
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const APP_VERSION = (() => { try { return 'v' + String(JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version || '').replace(/^v/, ''); } catch { return 'unknown'; } })();
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'telemetry.db');
const SEC_LOG = process.env.SEC_LOG || path.join(DATA_DIR, 'security.log');
const DEBUG_ON = process.env.DEBUG === '1' || process.env.LOG_LEVEL === 'debug';
const DEMO_AUTH = process.env.DEMO_AUTH !== '0';
const ENV_DEMO_PASS = String(process.env.DEMO_PASS || '').trim();
const DEMO_PASS_AUTO = !ENV_DEMO_PASS;
const DEMO_PASS = ENV_DEMO_PASS || crypto.randomBytes(9).toString('base64url');
const PASS_HASH = crypto.createHash('sha256').update(DEMO_PASS).digest();
// 配置了口令时从口令派生签名密钥，重启后已登录的玩家不用重新输入
const SESSION_KEY = ENV_DEMO_PASS ? crypto.createHmac('sha256', ENV_DEMO_PASS).update('embercrown-session-v1').digest() : crypto.randomBytes(32);
const DEV_START_WAVE = envInt('DEV_START_WAVE', 0, 0, 99);   // 调试用：单人模式从第几波开始（与 DEBUG 日志开关无关）
const SESSION_TTL_MS = 24 * 3600 * 1000;
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const ADMIN_HASH = ADMIN_TOKEN ? crypto.createHash('sha256').update(ADMIN_TOKEN).digest() : null;
const MAX_PLAYERS = 8;
const BOT_FILL = envInt('BOT_FILL', 4, 0, MAX_PLAYERS);
const MAX_CONNECTIONS = 256;
const MAX_ROOMS = 64;
const MAX_CONN_PER_IP = 16;
const QUEUE_HUMANS = envInt('QUEUE_HUMANS', 12, 1, 256);
const QUEUE_LOAD = Number(process.env.QUEUE_LOAD) || 1.6;
const QUEUE_TICK_MS = Number(process.env.QUEUE_TICK_MS) || 18;
const QUEUE_FORCE = process.env.QUEUE_FORCE === '1';
const REALM_NAME = String(process.env.REALM_NAME || '无尽乌龟').trim();
// AFK：真人长时间没有任何有效输入就判定挂机。默认 300 秒，最后 60 秒推倒计时。
// 只认「有操作」的输入包（位移/按键/视角），单纯心跳式空包不续命。
const AFK_IDLE_SEC = envInt('AFK_IDLE_SEC', 300, 30, 7200);
const AFK_WARN_SEC = envInt('AFK_WARN_SEC', 60, 5, 600);
const AFK_IDLE_MS = AFK_IDLE_SEC * 1000;
// 房间回收：真人全部断线、或在场但没有有效输入超过这个时长，就整间关掉。
// 光靠「没人了就删」不够——移动端切后台时 WebSocket 能被协议层自动 pong 吊住，
// 人早走了、socket 却还在，房间就会带着 bot 自己一局接一局地打下去（WR8Y 空转 9.5 小时、446 局）。
const ROOM_IDLE_SEC = envInt('ROOM_IDLE_CLOSE_SEC', 600, 5, 86400);
const ROOM_IDLE_MS = ROOM_IDLE_SEC * 1000;
// 建房版本闸：低于这个版本的前端不允许创建新房间（加入已有房间不受限）
const MIN_CREATE_VER = String(process.env.MIN_CREATE_VER || '1.7.0patch2').trim().replace(/^v/, '');
// 版本号比较：1.7.0patch2 > 1.7.0patch1 > 1.7.0。无法解析返回 null（当作过旧处理）
function verNum(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:patch(\d+))?/i.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +m[3], +m[4] || 0] : null;
}
function verCmp(a, b) {
  const x = verNum(a), y = verNum(b);
  if (!x || !y) return null;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const TICK = 30, DT = 1 / TICK;
const KILL_TARGET = envInt('KILL_TARGET', 10, 1, 99), ROUND_TIME = envInt('ROUND_TIME', 150, 30, 3600), END_TIME = 9, RESPAWN = 3, SPAWN_PROT = 1.5;
const R = 24, PR = 0.5, TAU = Math.PI * 2;
const PILLARS = [0, 1, 2, 3].map(k => { const a = k * Math.PI / 2 + Math.PI / 4; return { x: Math.sin(a) * 12, z: Math.cos(a) * 12, r: 1.4 }; });
const { ROLL, CHARGE, MOVE, CLS_IDS, CLS, RES, ULT, MAGE_FIRE_DMG, MAGE_METEOR_DMG } = require('./src/sim/combat.js');
const JUMP = { v: 8.6, g: 24 };                        // 起跳速度 / 重力：滞空约 0.72 秒，跳高约 1.5
const SLOW_K = 0.55;
const RES_MAX = 100;
const BOT_NAMES = ['波林', '艾瑞克', '莉雅', '凯尔', '薇拉', '索恩', '米拉', '卡隆', '芬恩', '伊索德'];
const PLAYER_NAMES = ['赤焰', '苍风', '铁壁', '星矢', '孤狼', '寒霜', '烈阳', '影刃', '破晓', '雷鸣', '磐石', '逐影'];
const BOT_DIFF = {
  easy:   { id: 'easy',   name: '简单', dmg: 0.55, spd: 0.78, dtMin: 0.65, dtVar: 0.45, err: 0.95, turn: 3.6, gcd: 1.05, fire: 0.42, q: 0.12, e: 0.08, u: 0.05, roll: 0.04 },
  normal: { id: 'normal', name: '普通', dmg: 0.74, spd: 0.88, dtMin: 0.45, dtVar: 0.35, err: 0.55, turn: 5.4, gcd: 0.65, fire: 0.58, q: 0.20, e: 0.16, u: 0.10, roll: 0.08 },
  hard:   { id: 'hard',   name: '困难', dmg: 0.82, spd: 0.90, dtMin: 0.40, dtVar: 0.30, err: 0.44, turn: 6.2, gcd: 0.55, fire: 0.62, q: 0.24, e: 0.20, u: 0.12, roll: 0.10 },
};

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function envInt(key, def, min, max) { const v = Number(process.env[key]); return process.env[key] !== undefined && Number.isFinite(v) ? clamp(Math.floor(v), min, max) : def; }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function r2(v) { return Math.round(v * 100) / 100; }
function angDiff(a, b) { let d = (a - b) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; }
function cleanText(v, max) { return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max) : ''; }
function cleanRoomCode(v) { return typeof v === 'string' ? v.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12) : ''; }
function cleanRoomPwd(v) { return typeof v === 'string' ? v.replace(/\D/g, '').slice(0, 6) : ''; }
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
const AUTH_MSG = { bad: '口令错误，请重试', limited: '尝试过于频繁，请 1 分钟后再试', expired: '登录已失效，请重新输入口令' };
// 有效令牌永远放行（不受限流影响）；失效令牌不计入口令失败；只有错误口令才计数
function authState(ip, tok, pass) {
  if (!DEMO_AUTH) return 'ok';
  if (verifySessionToken(tok)) return 'ok';
  const hasPass = typeof pass === 'string' && pass.trim() !== '';
  if (!hasPass && typeof tok === 'string' && tok) return 'expired';
  if (isRateLimited(ip)) return 'limited';
  return hasPass && checkPass(pass) ? 'ok' : 'bad';
}
function clientIp(req) {
  const peer = String((req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
  let raw = peer;
  if (TRUST_PROXY && req.headers && (!TRUSTED_PROXIES || TRUSTED_PROXIES.has(peer))) {
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

  CREATE TABLE IF NOT EXISTS solo_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ip TEXT,
    build TEXT,
    cls TEXT,
    start_wave INTEGER,
    end_wave INTEGER,
    resumed INTEGER,
    reason TEXT,
    dur_sec REAL,
    kills INTEGER,
    dmg INTEGER,
    waves_n INTEGER,
    boons TEXT,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_solo_ts ON solo_runs(ts);
  CREATE INDEX IF NOT EXISTS idx_solo_cls ON solo_runs(cls, end_wave);
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
    const sSolo = inst.prepare('INSERT INTO solo_runs (ts, ip, build, cls, start_wave, end_wave, resumed, reason, dur_sec, kills, dmg, waves_n, boons, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    return {
      insertAccess: a => sAcc.run(...a),
      insertLoad: a => sLd.run(...a),
      insertDebug: a => sDbg.run(...a),
      insertSolo: a => sSolo.run(...a),
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
    const sSolo = inst.prepare('INSERT INTO solo_runs (ts, ip, build, cls, start_wave, end_wave, resumed, reason, dur_sec, kills, dmg, waves_n, boons, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      return {
        insertAccess: a => sAcc.run(...a),
        insertLoad: a => sLd.run(...a),
        insertDebug: a => sDbg.run(...a),
      insertSolo: a => sSolo.run(...a),
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
        insertSolo: a => sendSql('INSERT INTO solo_runs (ts, ip, build, cls, start_wave, end_wave, resumed, reason, dur_sec, kills, dmg, waves_n, boons, payload) VALUES (' + a.map(sqlLit).join(',') + ')'),
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
const HONEYPOT_RE = /^\/(?:\.env|\.git|\.svn|\.aws|\.ssh|\.DS_Store|wp-admin|wp-login(?:\.php)?|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|pma|myadmin|admin\.php|administrator|shell|cmd|eval-stdin|vendor\/phpunit|actuator|cgi-bin|solr|jenkins|manager\/html|config\.php|config\.json|backup|dump\.sql|db\.sql|id_rsa|etc\/passwd|proc\/self|trap-admin)(?:$|[\/.])/i;
function handleHoneypot(req, res, p, ip, ua) {
  // 蜜罐只记录和拖延，不再计入口令失败：否则别的网页用一个图片标签就能让访问者被限流
  const h = req.headers || {};
  const xsite = h['sec-fetch-site'] === 'cross-site';     // 浏览器被第三方页面诱导发出的请求，不写入 fail2ban 日志
  logAccess({ ip, ua, event: xsite ? 'honeypot_xsite' : 'honeypot_hit', method: req.method, path: p, status: 403, detail: { host: cleanText(h.host, 120), ref: cleanText(h.referer, 180), xff: cleanText(h['x-forwarded-for'], 120) } });
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
let tickSumMs = 0, tickMaxMs = 0, tickCount = 0, recentTickMs = 0, totalWsMsgs = 0, lastCpu = process.cpuUsage(), lastSampleT = Date.now();
const loginQueue = [];
function getLoadStatus() {
  let humansTotal = 0;
  for (const r of rooms.values()) humansTotal += humans(r);
  const load1m = r2(os.loadavg()[0] || 0);
  const tickMs = r2(recentTickMs);
  const overloaded = QUEUE_FORCE || humansTotal >= QUEUE_HUMANS || load1m >= QUEUE_LOAD || tickMs >= QUEUE_TICK_MS;
  return { humans: humansTotal, load1m, tickMs, overloaded, queue: loginQueue.length, realm: REALM_NAME };
}
function queueEtaSec(pos) { return Math.max(35, pos * 45); }
function sendQueueMsg(ws, pos) {
  send(ws, JSON.stringify({ t: 'queue', realm: REALM_NAME, pos, etaSec: queueEtaSec(pos) }));
}
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary' };
// 文本类静态文件 gzip 后缓存在内存里（按大小 + 修改时间失效），客户端页面和 Three.js 体积降到约四分之一
const GZ_TYPES = new Set(['.html', '.js', '.css', '.json', '.svg']);
const gzCache = new Map();
function gzipped(file, st, cb) {
  const tag = st.size + '-' + st.mtimeMs, hit = gzCache.get(file);
  if (hit && hit.tag === tag) return cb(null, hit.buf);
  fs.readFile(file, (err, raw) => {
    if (err) return cb(err);
    zlib.gzip(raw, { level: 9 }, (e2, buf) => { if (e2) return cb(e2); gzCache.set(file, { tag, buf }); cb(null, buf); });
  });
}
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (CORS_ORIGINS === null) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && CORS_ORIGINS.has(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Demo-Token, X-Demo-Pass');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------------- 单人难度遥测 ---------------- */
const soloRate = new Map();
const authOkRate = new Map();
function winAllow(map, ip, limit) {
  const now = Date.now(), hit = map.get(ip);
  if (!hit || now - hit.t > 60000) { if (map.size > 4000) map.clear(); map.set(ip, { t: now, n: 1 }); return true; }
  hit.n++;
  return hit.n <= limit;
}
function soloAllow(ip) { return winAllow(soloRate, ip, 60); }
function authOkAllow(ip) { return winAllow(authOkRate, ip, 60); }
function soloNum(v, lo, hi, d) { const n = +v; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; }
function soloStr(v, max) { return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, max || 64); }
function soloCounts(o) {
  const out = {};
  if (!o || typeof o !== 'object') return out;
  for (const k of Object.keys(o).slice(0, 40)) {
    if (!/^[a-z0-9*_-]{1,24}$/.test(k)) continue;
    out[k] = soloNum(o[k], 0, 100000, 0);
  }
  return out;
}
function sanitizeSolo(j, ip) {
  const waves = Array.isArray(j.waves) ? j.waves.slice(0, 80).map(w => ({
    n: soloNum(w && w.n, 0, 9999, 0), dur: soloNum(w && w.dur, 0, 86400, 0), k: soloNum(w && w.k, 0, 100000, 0),
    dmg: soloNum(w && w.dmg, 0, 1000000000, 0), hpEnd: soloNum(w && w.hpEnd, 0, 1000000000, 0), hpPct: soloNum(w && w.hpPct, 0, 100, 0),
    by: soloCounts(w && w.by),
    boss: w && w.boss && typeof w.boss === 'object' ? { t: soloStr(w.boss.t, 24), win: w.boss.win === 0 ? 0 : 1, ttk: soloNum(w.boss.ttk, 0, 86400, 0), hpMax: soloNum(w.boss.hpMax, 0, 1000000000, 0), hpLeft: soloNum(w.boss.hpLeft, 0, 1000000000, 0), mul: soloNum(w.boss.mul, 0, 1000000, 1) } : null,
  })) : [];
  const boons = Array.isArray(j.boons) ? j.boons.slice(0, 60).map(b => ({ r: soloStr(b && b.r, 8), n: soloStr(b && b.n, 24), c: soloNum(b && b.c, 0, 999, 0) })) : [];
  const clean = {
    v: 1, build: soloStr(j.build, 24), lang: soloStr(j.lang, 8), cls: soloStr(j.cls, 16), input: soloStr(j.input, 8), resumed: j.resumed ? 1 : 0,
    startWave: soloNum(j.startWave, 0, 9999, 1), endWave: soloNum(j.endWave, 0, 9999, 1), reason: soloStr(j.reason, 16),
    durSec: soloNum(j.durSec, 0, 86400, 0), kills: soloNum(j.kills, 0, 100000, 0), dmg: soloNum(j.dmg, 0, 1000000000, 0),
    bosses: soloNum(j.bosses, 0, 999, 0), left: soloNum(j.left, 0, 9999, 0), totalKills: soloCounts(j.by), waves, boons,
  };
  let payload = JSON.stringify(clean);
  if (payload.length > 60000) { clean.waves = clean.waves.slice(0, 30); payload = JSON.stringify(clean); }
  if (payload.length > 60000) { clean.waves = []; payload = JSON.stringify(clean); }
  const ts = new Date().toISOString();
  return {
    input: clean.input, cls: clean.cls, endWave: clean.endWave, reason: clean.reason, dur: clean.durSec, kills: clean.kills, resumed: clean.resumed,
    cols: [ts, String(ip || 'unknown'), clean.build, clean.cls, clean.startWave, clean.endWave, clean.resumed, clean.reason,
      clean.durSec, clean.kills, clean.dmg, clean.waves.length, JSON.stringify(clean.boons), payload],
  };
}

/* P2P 房主上报：只收匿名摘要（不含昵称、不含玩家 IP），落 access_logs 的 mp_summary 事件。
   官服到期后只剩 P2P 形态，没有这条通道就等于联机侧完全没有数据。 */
function sanitizeMp(j) {
  const pickInput = v => (['touch', 'pad', 'kbm'].includes(v) ? v : '');
  const players = Array.isArray(j.players) ? j.players.slice(0, MAX_PLAYERS).map(p => ({
    cls: soloStr(p && p.cls, 16), bot: p && p.bot ? 1 : 0, input: pickInput(p && p.input),
    kills: soloNum(p && p.kills, 0, 999, 0), deaths: soloNum(p && p.deaths, 0, 999, 0),
    dmg: soloNum(p && p.dmg, 0, 100000000, 0),
  })) : [];
  const humans = players.filter(p => !p.bot);
  return {
    room: soloStr(j.room, 12).toUpperCase(),
    detail: {
      mode: 'p2p', diff: BOT_DIFF[j.diff] ? j.diff : 'normal', build: soloStr(j.build, 24),
      bots: players.length - humans.length, humans: humans.length,
      durSec: soloNum(j.durSec, 0, 3600, 0), round: soloNum(j.round, 0, 999, 0),
      kills: soloNum(j.kills, 0, 9999, 0), input: pickInput(j.input),
      reason: soloStr(j.reason, 16) || 'end',
      killTarget: soloNum(j.killTarget, 0, 999, 0), players,
    },
  };
}

const onRequest = (req, res) => {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (p.includes('\0')) { res.writeHead(400); return res.end(); }
  const ip = clientIp(req), ua = clientUa(req);
  if (HONEYPOT_RE.test(p)) return handleHoneypot(req, res, p, ip, ua);
  if (req.method === 'POST' && p === '/auth') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 512) req.destroy(); });
    req.on('end', () => {
      let pass = '', tok = '';
      try { const j = JSON.parse(body); pass = String(j.pass || ''); tok = String(j.token || ''); } catch (e) {}
      let st = authState(ip, tok, pass);
      if (st === 'ok' && !authOkAllow(ip)) st = 'limited';
      const ok = st === 'ok', status = ok ? 200 : st === 'limited' ? 429 : 401;
      logAccess({ ip, ua, event: ok ? 'auth_ok' : st === 'limited' ? 'rate_limit' : st === 'expired' ? 'token_expired' : 'auth_fail', method: 'POST', path: '/auth', status });
      if (st === 'bad') { recordAuthFail(ip); logDebug('WARN', 'auth', '口令验证失败', { ip }); }
      else if (st === 'limited') logDebug('WARN', 'auth', 'IP 触发口令频率限制', { ip });
      else if (ok) logDebug('INFO', 'auth', '口令验证通过', { ip });
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(ok ? { ok: true, token: verifySessionToken(tok) ? tok : issueSessionToken(), ...(DEV_START_WAVE > 1 ? { startWave: DEV_START_WAVE } : {}) } : { ok: false, code: st, msg: AUTH_MSG[st] }));
    });
    return;
  }
  if (req.method === 'POST' && p === '/telemetry/solo') {      // 单人难度遥测：一局一包
    if (!soloAllow(ip)) { res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"ok":false,"code":"limited"}'); }
    let body = '', over = false;
    req.on('data', chunk => {
      if (over) return;
      body += chunk;
      if (body.length > 65536) {
        over = true; body = '';
        res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end('{"ok":false,"code":"too_large"}');
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return;
      let j; try { j = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"ok":false,"code":"bad_json"}'); }
      const r = sanitizeSolo(j, ip);
      try { db.insertSolo(r.cols); } catch (e) {}
      logAccess({ ip, ua, event: 'solo_run', method: 'POST', path: '/telemetry/solo', status: 204, cls: r.cls,
        detail: { wave: r.endWave, reason: r.reason, dur: r.dur, kills: r.kills, resumed: r.resumed, input: r.input || '' } });
      res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end();
    });
    return;
  }
  if (req.method === 'POST' && p === '/telemetry/mp') {        // P2P 房主上报：一局一包（匿名）
    if (!soloAllow(ip)) { res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"ok":false,"code":"limited"}'); }
    let body = '', over = false;
    req.on('data', chunk => {
      if (over) return;
      body += chunk;
      if (body.length > 16384) {
        over = true; body = '';
        res.writeHead(413, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end('{"ok":false,"code":"too_large"}');
        req.destroy();
      }
    });
    req.on('end', () => {
      if (over) return;
      let j; try { j = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"ok":false,"code":"bad_json"}'); }
      const r = sanitizeMp(j);
      if (!r.room) { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"ok":false,"code":"bad_room"}'); }
      logAccess({ ip, ua, event: 'mp_summary', method: 'POST', path: '/telemetry/mp', status: 204, room: r.room, detail: r.detail });
      res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end();
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  if (p === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, v: APP_VERSION }));
  }
  if (p === '/healthz') {
    const st = getLoadStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: st.humans, load: st }));
  }
  if (p === '/rooms') {                                // 对战大厅的房间列表（需口令或短期令牌校验）
    const rs = authState(ip, req.headers['x-demo-token'], req.headers['x-demo-pass']);
    if (rs !== 'ok') {
      if (rs === 'bad') recordAuthFail(ip);
      logAccess({ ip, ua, event: rs === 'expired' ? 'token_expired' : 'rooms_denied', method: req.method, path: '/rooms', status: 401 });
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify([]));
    }
    const list = [...rooms.values()].map(r => ({ code: r.code, lock: r.pwd ? 1 : 0, fun: r.fun ? 1 : 0, n: humans(r), bots: r.players.length - humans(r), diff: r.diff || 'normal', max: MAX_PLAYERS, ph: r.phase === 'end' ? 1 : 0,
      rt: Math.max(0, Math.ceil(r.phase === 'end' ? r.phaseT : r.roundT)), top: r.players.reduce((m, q) => Math.max(m, q.kills), 0) })).sort((a, b) => b.n - a.n || (a.code < b.code ? -1 : 1));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(list));
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    const etag = 'W/"' + st.size.toString(16) + '-' + Math.floor(st.mtimeMs).toString(16) + '"', ext = path.extname(file), canGz = GZ_TYPES.has(ext);
    const cached = req.headers['if-none-match'] === etag;
    if (p === '/index.html' && req.method === 'GET') {         // 缓存命中（304）的回访也算一次访问
      logAccess({ ip, ua, event: 'http_visit', method: 'GET', path: '/', status: cached ? 304 : 200 });
      logDebug('DEBUG', 'http', '访问首页', { ip, ua });
    }
    const isImm = p.startsWith('/vendor/') || p.startsWith('/assets/') || ext === '.mp3';
    const head = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'ETag': etag, 'Cache-Control': isImm ? 'public, max-age=31536000, immutable' : 'no-cache', 'Accept-Ranges': 'bytes' };
    if (canGz) head['Vary'] = 'Accept-Encoding';
    if (cached) { res.writeHead(304, head); return res.end(); }
    const plain = () => {
      res.writeHead(200, Object.assign(head, { 'Content-Length': st.size }));
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    };
    const rg = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (rg && (rg[1] || rg[2])) {                              // 单段 Range：iOS Safari 播放音频需要
      let start, end;
      if (rg[1] === '') { start = Math.max(0, st.size - Number(rg[2])); end = st.size - 1; }
      else { start = Number(rg[1]); end = rg[2] === '' ? st.size - 1 : Math.min(Number(rg[2]), st.size - 1); }
      if (!(start <= end) || start >= st.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + st.size }); return res.end(); }
      res.writeHead(206, Object.assign(head, { 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Content-Length': end - start + 1 }));
      if (req.method === 'HEAD') return res.end();
      return void fs.createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    }
    if (canGz && st.size > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      return gzipped(file, st, (e, buf) => {
        if (e || res.destroyed) return e ? plain() : undefined;
        res.writeHead(200, Object.assign(head, { 'Content-Encoding': 'gzip', 'Content-Length': buf.length }));
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
    }
    plain();
  });
};
const server = (SSL_CERT && SSL_KEY)
  ? https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, onRequest)
  : http.createServer(onRequest);

/* ---------------- rooms ---------------- */
const rooms = new Map();
function makeRoom(code, botCount = Math.max(0, BOT_FILL - 1), diff = 'normal', pwd = '', fun = false) {
  const dKey = BOT_DIFF[diff] ? diff : 'normal';
  const room = { code, pwd: cleanRoomPwd(pwd), fun: !!fun, botCount: clamp(botCount, 0, MAX_PLAYERS - 1), diff: dKey, players: [], proj: [], zones: [], picks: [], bombs: [], critters: [], critterTimers: [], ev: [], time: 0, phase: 'play', phaseT: 0, roundT: ROUND_TIME, humanAct: Date.now(), lastRealAct: 0,
    nextId: 1, nextObj: 1, pickT: fun ? 3 : 6, botT: 0, rosterDirty: true, hasFb: false };
  initCritters(room);
  rooms.set(code, room); return room;
}
function freshFun() {
  return { item: '', itemT: 0, itemCd: 0, star: 0, giant: 0, mini: 0, haste: 0, boom: 0, dizzy: 0, snail: 0, boomAng: 0, boomHit: new Map(), starHit: new Map(), pullT: 0, pullX: 0, pullZ: 0 };
}
const FUN_ABILITY_CFG = {
  grip:  { dur: 40, cd: 5 },
  boom:  { dur: 40, cd: 9 },
  star:  { dur: 40, cd: 11 },
  giant: { dur: 40, cd: 11 },
  haste: { dur: 40, cd: 11 },
};
function randomCode() { const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s; do { s = ''; for (let i = 0; i < 4; i++) s += abc[Math.random() * abc.length | 0]; } while (rooms.has(s)); return s; }
function humans(room) { let n = 0; for (const p of room.players) if (!p.bot) n++; return n; }

function makePlayer(room, name, cls, ws) {
  const p = { id: room.nextId++, name, cls, ws, bot: !ws, lastAct: Date.now(), afkWarn: 0, x: 0, z: 0, y: 0, vy: 0, air: false, jx: 0, jz: 0, face: 0, hp: CLS[cls].hp, res: 0, calm: 0, kx: 0, kz: 0,
    cd: { atk: 0, q: 0, e: 0, u: 0, dodge: 0 }, dashT: 0, dashX: 0, dashZ: 1, dashSp: 0, charging: false, rolling: false, chargeHit: null, chargeTarget: null, chargeTgId: 0, chargeDist: 0,
    cast: 0, castX: 0, castZ: 0, ux: 0, uz: 0,
    inv: 0, prot: 0, stun: 0, stunDR: 0, freeze: 0, slow: 0, dead: false, respawnT: 0, moving: false,
    fun: freshFun(),
    mx: 0, mz: 0, a: 0, ax: 0, az: 0, pend: 0, seq: 0, kills: 0, deaths: 0, dmg: 0, totalKills: 0, totalDeaths: 0, totalDmg: 0, streak: 0, maxStreak: 0, mk: 0, mkT: 0,
    ai: ws ? null : { t: 0, gcd: 0, err: 0, tx: 0, tz: 0, strafe: 1, fire: false, q: false, e: false, u: false, roll: false, jump: false, target: null } };
  room.players.push(p); respawn(room, p); room.rosterDirty = true;
  return p;
}
function removePlayer(room, p) {
  const i = room.players.indexOf(p); if (i < 0) return;
  room.players.splice(i, 1); room.rosterDirty = true;
  if (!humans(room)) rooms.delete(room.code);
}
// 整间关停：先摘出 rooms 表，再逐个通知真人并断开。关掉的房间不再进 tick，bot 也随之消失。
function closeRoom(room, why) {
  if (!rooms.has(room.code)) return;
  rooms.delete(room.code);
  const hs = room.players.filter(p => !p.bot && p.ws);
  const idleSec = Math.round((Date.now() - (room.humanAct || 0)) / 1000);
  logAccess({ ip: hs.length ? hs[0].ip : null, event: 'room_closed', room: room.code, detail: { why, humans: hs.length, idleSec } });
  logDebug('INFO', 'room', '房间 ' + room.code + ' 已关闭（' + why + '，空闲 ' + idleSec + 's）', { room: room.code, why, humans: hs.length, idleSec });
  for (const p of hs) {
    const ws = p.ws; p.ws = null;
    try { send(ws, JSON.stringify({ t: 'closed', why })); } catch (e) {}
    try { ws.close(4003, why); } catch (e) {}
  }
  room.players.length = 0;
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
    dashT: 0, charging: false, rolling: false, chargeTarget: null, chargeTgId: 0, chargeDist: 0, cast: 0, inv: 0, prot: SPAWN_PROT, stun: 0, stunDR: 0, freeze: 0, slow: 0, fun: freshFun() });
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
  const c = CLS[p.cls], u = ULT[p.cls];
  if (u.self) {
    p.cd.u = c.u; p.res = Math.max(0, p.res - c.cost[3]); p.prot = 0; p.stun = p.freeze = p.slow = 0;
    p.spinUltT = u.dur || 3.2; p.spinTickT = 0; p.spinHealed = 0;
    room.ev.push({ e: 'atk', id: p.id, k: 'ult', a: r2(p.face) });
    return;
  }
  const t = aimPoint(p, c.range, p.ux, p.uz);   // ux / uz：按下大招键那一刻鼠标选定的位置
  p.cast = c.cast; p.castX = t.x; p.castZ = t.z; p.prot = 0;
  if (Math.hypot(t.x - p.x, t.z - p.z) > 0.2) p.face = Math.atan2(t.x - p.x, t.z - p.z);
  if (c.chan) {
    p.cd.u = c.u; p.res = Math.max(0, p.res - c.cost[3]);
    addZone(room, p, u.k, t.x, t.z, Object.assign({ chan: 1 }, u.zone));
  }
  room.ev.push({ e: 'cs', id: p.id, x: r2(t.x), z: r2(t.z), d: c.cast, r: u.zone.r, ...(c.chan ? { ch: 1 } : {}) });
}
function finishCast(room, p) {
  const c = CLS[p.cls], u = ULT[p.cls];
  p.cast = 0;
  if (c.chan) { room.ev.push({ e: 'atk', id: p.id, k: 'ult', a: r2(p.face) }); return; }
  p.cd.u = c.u; p.res = Math.max(0, p.res - c.cost[3]);
  room.ev.push({ e: 'atk', id: p.id, k: 'ult', a: r2(p.face) });
  addZone(room, p, u.k, p.castX, p.castZ, u.zone);
}
function damage(room, t, amt, by, o) {
  if (t.dead || t.inv > 0 || t.prot > 0 || (t.fun && t.fun.star > 0) || room.phase !== 'play') return false;
  const mul = by && by.bot ? (BOT_DIFF[room.diff] || BOT_DIFF.normal).dmg : 1;
  const funDmg = by && by.fun ? (by.fun.giant > 0 ? 1.45 : by.fun.mini > 0 ? 0.75 : 1) : 1;
  let v = amt * mul * funDmg * (0.92 + Math.random() * 0.16);
  const crit = Math.random() < 0.08; if (crit) v *= 1.6;
  v = Math.max(1, Math.round(v * CLS[t.cls].armor * (t.wallT > 0 ? 0.45 : 1)));
  t.hp -= v;
  if (by && by !== t) { by.dmg = (by.dmg || 0) + v; by.totalDmg = (by.totalDmg || 0) + v; }
  if (by && by !== t && by.cls === 'knight' && !(o && o.sk)) { gain(by, RES.rage.hit); by.calm = RES.rage.calm; }
  if (t.cls === 'knight') { gain(t, v * RES.rage.hurt); t.calm = RES.rage.calm; }
  if (o && o.kb) {
    const kMul = by && by.fun && by.fun.giant > 0 ? 1.5 : 1;
    const dx = t.x - o.fx, dz = t.z - o.fz, d = Math.hypot(dx, dz) || 1, kb = o.kb * kMul * (t.cls === 'knight' ? 0.6 : 1);
    t.kx += dx / d * kb; t.kz += dz / d * kb;
  }
  if (o && o.slow && !(t.spinUltT > 0)) t.slow = Math.max(t.slow, o.slow);
  if (o && (o.stun || o.freeze) && !(t.spinUltT > 0)) {
    if (o.stun) { const s = t.stunDR > 0 ? o.stun * 0.5 : o.stun; t.stun = Math.max(t.stun, s); t.stunDR = 3.5; }
    else t.freeze = Math.max(t.freeze, o.freeze);
    t.dashT = 0; t.charging = t.rolling = false; t.chargeTarget = null; cancelCast(room, t);      // 被控制会打断读条
  }
  room.ev.push({ e: 'hit', id: t.id, by: by ? by.id : 0, d: v, c: crit ? 1 : 0, s: o && o.sk ? 1 : 0 });   // s：技能伤害（客户端显示成黄字）
  if (t.hp <= 0) kill(room, t, by, o);
  return true;
}
function kill(room, t, by, o) {
  const prevSt = t.streak || 0;
  t.hp = 0; t.dead = true; t.respawnT = RESPAWN; t.deaths++; t.totalDeaths = (t.totalDeaths || 0) + 1; t.streak = 0; t.mk = 0; t.mkT = 0; t.dashT = 0; t.charging = t.rolling = false; t.cast = 0; t.spinUltT = 0; t.wallT = 0;
  const credit = by && by !== t && room.players.includes(by);
  let st = 0, mk = 0, fb = 0, sd = 0;
  if (credit) {
    if (!room.hasFb) { room.hasFb = true; fb = 1; }
    if (prevSt >= 3) sd = prevSt;
    by.kills++; by.totalKills = (by.totalKills || 0) + 1; by.streak = (by.streak || 0) + 1; st = by.streak;
    if (st > (by.maxStreak || 0)) by.maxStreak = st;
    by.mk = (by.mkT > 0 ? (by.mk || 0) : 0) + 1; by.mkT = 10; mk = by.mk;
    if (!by.dead) { const max = CLS[by.cls].hp, got = Math.min(30, max - by.hp); if (got > 0) { by.hp += got; room.ev.push({ e: 'heal', id: by.id, v: Math.round(got) }); } }
  }
  // 击杀明细：只要有一方是真人就全量记录；bot 打 bot 只按 1/20 采样。
  // 挂机房里 7 个 bot 互杀曾经把 access_logs 刷到 99.6%，还会把真人数据从 5 万条滚动窗口里挤掉。
  const humanInvolved = credit ? (!by.bot || !t.bot) : !t.bot;
  if (humanInvolved || Math.random() < 0.05) logAccess({ ip: credit ? (by.bot ? 'bot' : 'human') : 'env', event: 'combat_kill', room: room.code, name: credit ? by.name : null, cls: credit ? by.cls : null,
    detail: { src: o && o.sk ? 'skill' : 'atk', killerBot: credit ? (by.bot ? 1 : 0) : 0, victimCls: t.cls, victimBot: t.bot ? 1 : 0, diff: room.diff, sampled: humanInvolved ? 0 : 1,
      killerIp: credit && !by.bot ? (by.ip || '') : '', victimIp: t.bot ? '' : (t.ip || '') } });
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
  room.ev.push({ e: 'z', k, o: p.id, x: r2(x), z: r2(z), r: o.r, d: o.delay, n: o.ticks || 1, iv: o.iv || 0, ...(o.chan ? { ch: 1 } : {}) });
}
function foes(room, p) { return room.players.filter(o => o !== p && !o.dead); }

function attack(room, p) {
  const a = p.face; p.cd.atk = CLS[p.cls].atkCd; p.prot = 0;
  if (p.cls === 'knight') {
    room.ev.push({ e: 'atk', id: p.id, k: 'slash', a: r2(a) });
    let best = null, bd = Infinity;
    for (const o of foes(room, p)) {
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
      if (d < 3.3 + PR && (d < 1.35 || Math.abs(angDiff(Math.atan2(dx, dz), a)) < 0.95) && d < bd) { bd = d; best = o; }
    }
    if (best) damage(room, best, 23, p, { kb: 2.2, fx: p.x, fz: p.z });
    else if (hitCrittersInArc(room, p.x, p.z, a, 3.3, 0.95, p)) { gain(p, RES.rage.hit); p.calm = RES.rage.calm; }
  } else if (p.cls === 'ranger') {
    room.ev.push({ e: 'atk', id: p.id, k: 'shoot', a: r2(a) });
    shoot(room, p, 'arrow', a, { speed: 30, dmg: 14, life: 1.0, pierce: 1 });
  } else {
    room.ev.push({ e: 'atk', id: p.id, k: 'cast', a: r2(a) });
    shoot(room, p, 'fire', a, { speed: 24.5, dmg: MAGE_FIRE_DMG, life: 1.25, splash: 2.35 });
  }
}
function skill(room, p, slot) {
  const c = CLS[p.cls], a = p.face; if (slot < 2) p.cd[slot ? 'e' : 'q'] = slot ? c.e : c.q; p.prot = 0;
  if (p.cls === 'knight' && !slot) {                   // 顺劈斩：消耗 18 怒气，面前扇形群伤
    room.ev.push({ e: 'atk', id: p.id, k: 'cleave', a: r2(a) });
    for (const o of foes(room, p)) {
      const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
      if (d < 3.6 + PR && (d < 1.35 || Math.abs(angDiff(Math.atan2(dx, dz), a)) < 1.25)) damage(room, o, 34, p, { kb: 3.5, fx: p.x, fz: p.z, sk: 1 });
    }
    hitCrittersInArc(room, p.x, p.z, a, 3.6, 1.25, p);
  } else if (slot === 2) {                             // 冲锋（骑士的 5 号位移技能）
    // 有目标就朝它冲（不限距离，太远就冲到 maxDist 停）：近身(< lockGap)锁定撞停，远距离贯穿
    const tg = p.chargeTgId ? ((foes(room, p).find(o => o.id === p.chargeTgId)
      || (room.critters || []).find(c => c.id === p.chargeTgId)) || null) : null;
    const gap = tg ? Math.hypot(tg.x - p.x, tg.z - p.z) : Infinity;
    const ca = tg ? Math.atan2(tg.x - p.x, tg.z - p.z) : a;
    const lock = !!tg && gap < CHARGE.lockGap;
    const dur = !tg ? CHARGE.dur : (lock ? 0.6 : Math.min(gap, CHARGE.maxDist) / CHARGE.sp);
    p.chargeTarget = lock ? tg : null; p.chargeTgId = 0; p.chargeDist = 0;
    p.dashT = dur; p.dashSp = CHARGE.sp; p.dashX = Math.sin(ca); p.dashZ = Math.cos(ca); p.charging = true; p.rolling = false; p.chargeHit = new Set(); p.inv = Math.max(p.inv, 0.45);
    gain(p, RES.rage.charge); p.calm = RES.rage.calm;                       // 冲锋不耗怒气，反而攒怒气（每跳 25，只给一次）
    room.ev.push({ e: 'atk', id: p.id, k: 'charge', a: r2(ca), dur: r2(dur) });
  } else if (p.cls === 'knight') {                     // 破釜沉舟：80% 减伤 3.0s
    p.wallT = 3.0;
    room.ev.push({ e: 'atk', id: p.id, k: 'wall', a: r2(a) });
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
    hitCrittersInRadius(room, p.x, p.z, 5.8, p);
  } else {
    const t = aimPoint(p, 17);
    room.ev.push({ e: 'atk', id: p.id, k: 'call', a: r2(a) });
    addZone(room, p, 'meteor', t.x, t.z, { r: 4.6, delay: 0.58, dmg: MAGE_METEOR_DMG, kb: 9 });
  }
}

function updatePlayer(room, p) {
  if (p.bot) botThink(room, p);
  const b = p.pend; p.pend = 0;
  if (p.dead) { p.respawnT -= DT; if (p.respawnT <= 0) respawn(room, p); return; }
  const fn = p.fun || (p.fun = freshFun());
  if (fn.itemT > 0) {
    fn.itemT -= DT;
    if (fn.itemT <= 0) { fn.item = ''; fn.itemT = 0; fn.itemCd = 0; }
  }
  if (fn.itemCd > 0) fn.itemCd = Math.max(0, fn.itemCd - DT);
  if (fn.star > 0) fn.star -= DT;
  if (fn.giant > 0) fn.giant -= DT;
  if (fn.mini > 0) fn.mini -= DT;
  if (fn.haste > 0) { fn.haste -= DT; p.slow = 0; }
  if (fn.boom > 0) { fn.boom -= DT; fn.boomAng = (fn.boomAng + 4.8 * DT) % TAU; }
  if (fn.dizzy > 0) fn.dizzy -= DT;
  if (fn.snail > 0) fn.snail -= DT;
  const c = CLS[p.cls], rs = RES[c.res], cd = p.cd, cdStep = fn.haste > 0 ? DT * 2 : DT;
  cd.atk -= cdStep; cd.q -= cdStep; cd.e -= cdStep; cd.u -= cdStep; cd.dodge -= cdStep;
  if (p.inv > 0) p.inv -= DT; if (p.prot > 0) p.prot -= DT; if (p.slow > 0) p.slow -= DT; if (p.stunDR > 0) p.stunDR -= DT; if (p.mkT > 0) p.mkT -= DT;
  if (p.wallT > 0) p.wallT -= DT;
  if (p.spinUltT > 0) {
    p.spinUltT -= DT; p.spinTickT -= DT;
    if (p.spinTickT <= 0) {
      p.spinTickT += 0.3;
      room.ev.push({ e: 'atk', id: p.id, k: 'spin', a: r2(p.face) });
      let hits = 0;
      for (const o of foes(room, p)) if (Math.hypot(o.x - p.x, o.z - p.z) < 3.4 + PR) { if (damage(room, o, 9, p, { kb: 0.8, fx: p.x, fz: p.z, sk: 1 })) hits++; }
      hitCrittersInRadius(room, p.x, p.z, 3.4, p);
      if (hits && !p.dead && p.spinHealed < 16) {
        const max = CLS.knight.hp, got = Math.min(16 - p.spinHealed, hits * 2, max - p.hp);
        if (got > 0) { p.spinHealed += got; p.hp += got; room.ev.push({ e: 'heal', id: p.id, v: Math.round(got) }); }
      }
    }
  }
  if (rs.regen) p.res = Math.min(RES_MAX, p.res + rs.regen * DT);
  else if ((p.calm -= DT) <= 0) p.res = Math.max(0, p.res - rs.decay * DT);
  if (fn.pullT > 0) {
    const k = Math.min(1, DT / fn.pullT);
    p.x += (fn.pullX - p.x) * k; p.z += (fn.pullZ - p.z) * k;
    fn.pullT -= DT; p.kx = p.kz = 0; p.dashT = 0; p.charging = p.rolling = false; p.moving = false;
    confine(p); return;
  }
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
      const aliveTg = room.players.includes(tg) ? !tg.dead : (room.critters || []).includes(tg);
      if (!aliveTg) p.chargeTarget = null;
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
        if (o === p.chargeTarget) p.dashT = 0;                              // 撞到锁定目标即停，但本帧其余敌人照样结算
      }
      for (const c of (room.critters || []).slice()) if (!p.chargeHit.has(c) && Math.hypot(c.x - p.x, c.z - p.z) < PR + CRITTER_R + 0.95) {
        p.chargeHit.add(c); killCritter(room, c, p);
        if (c === p.chargeTarget) p.dashT = 0;
      }
      if (p.chargeDist >= CHARGE.maxDist) p.dashT = 0;
    } else if (p.rocket) {
      p.face = Math.atan2(p.dashX, p.dashZ);
      for (const o of foes(room, p)) if (!p.rocketHit.has(o) && Math.hypot(o.x - p.x, o.z - p.z) < PR * 2 + 1.0) {
        p.rocketHit.add(o); damage(room, o, 28, p, { kb: 12, fx: p.x - p.dashX, fz: p.z - p.dashZ, stun: 0.5, sk: 1 });
      }
      hitCrittersInRadius(room, p.x, p.z, PR + 1.0, p);
    }
    if (p.dashT <= 0) { if (p.charging) p.inv = Math.min(p.inv, 0.08); p.charging = p.rolling = p.rocket = false; p.chargeTarget = null; }
  } else {
    const dmx = fn.dizzy > 0 ? -p.mx : p.mx, dmz = fn.dizzy > 0 ? -p.mz : p.mz;
    const funSpd = (fn.haste > 0 ? 1.45 : fn.snail > 0 ? 0.58 : fn.mini > 0 ? 1.25 : 1) * (fn.star > 0 ? 1.25 : 1);
    const ml = Math.hypot(dmx, dmz), sp = c.speed * (p.spinUltT > 0 ? 0.82 : 1) * (p.slow > 0 ? SLOW_K : 1) * funSpd * (p.bot ? (BOT_DIFF[room.diff] || BOT_DIFF.normal).spd : 1);
    if (p.cast > 0) {                                  // 读条：必须站定，移动 / 跳跃 / 翻滚 / 主动取消都会打断
      if (ml > 0.15 || (b & 88)) cancelCast(room, p);
      else if ((p.cast -= DT) <= 0) finishCast(room, p);
    }
    if (p.cast > 0) { confine(p); return; }
    if (p.air) { p.x += p.jx * DT; p.z += p.jz * DT; }  // 空中保持起跳时的水平速度，不能变向
    else { p.x += dmx * sp * DT; p.z += dmz * sp * DT; p.moving = ml > 0.15; }
    p.face = p.a;
    if ((b & 16) && !p.air) {
      p.air = true; p.vy = JUMP.v; p.jx = dmx * sp; p.jz = dmz * sp; p.moving = false;
      room.ev.push({ e: 'atk', id: p.id, k: 'jump', a: r2(p.face) });
    }
    if (!(p.spinUltT > 0) && (b & 1) && cd.atk <= 0 && pay(p, 0)) attack(room, p);
    if (!(p.spinUltT > 0) && (b & 2) && cd.q <= 0 && !p.dead && pay(p, 1)) skill(room, p, 0);
    if ((b & 4) && cd.e <= 0 && !p.dead && pay(p, 2)) skill(room, p, 1);
    if ((b & 128) && !p.dead && fn.item) dropFunItem(room, p);
    if ((b & 32) && !p.dead && fn.item) useFunItem(room, p);
    else if ((b & 32) && cd.u <= 0 && !p.dead && !p.air && (ULT[p.cls].self || ml <= 0.15) && p.res >= c.cost[3]) startCast(room, p);
    if ((b & 8) && cd.dodge <= 0 && p.dashT <= 0 && !p.dead && mv.k !== 'roll') {
      cd.dodge = mv.cd; p.prot = 0;
      if (mv.k === 'charge') skill(room, p, 2);
      else {                                           // 闪现：朝移动方向（没在移动就朝面向）瞬移，并解除减速
        const dx = ml > 0.15 ? dmx / ml : Math.sin(p.face), dz = ml > 0.15 ? dmz / ml : Math.cos(p.face), fx = p.x, fz = p.z;
        p.x += dx * mv.dist; p.z += dz * mv.dist; confine(p); p.kx = p.kz = 0; p.slow = 0; p.inv = Math.max(p.inv, 0.35);
        room.ev.push({ e: 'atk', id: p.id, k: 'blink', a: r2(Math.atan2(dx, dz)), x: r2(fx), z: r2(fz), tx: r2(p.x), tz: r2(p.z) });
      }
    } else if ((b & 8) && cd.dodge <= 0 && p.dashT <= 0 && !p.dead) {
      cd.dodge = ROLL.cd; p.dashT = ROLL.dur; p.dashSp = ROLL.sp; p.rolling = true; p.charging = false; p.slow = 0;
      if (p.moving) { p.dashX = dmx / ml; p.dashZ = dmz / ml; } else { p.dashX = Math.sin(p.face); p.dashZ = Math.cos(p.face); }
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
      if (!gone) for (const c of (room.critters || []).slice()) {
        if (Math.hypot(c.x - pr.x, c.z - pr.z) > 0.4 + CRITTER_R) continue;
        killCritter(room, c, pr.o);
        hit = 1;
        if (pr.splash || pr.pierce-- <= 0) gone = true;
        break;
      }
    }
    pr.life -= DT; if (pr.life <= 0) gone = true;
    if (gone) {
      if (pr.splash) {
        for (const t of room.players) {
          if (t === pr.o || t.dead || pr.hit.has(t)) continue;
          if (Math.hypot(t.x - pr.x, t.z - pr.z) < pr.splash + PR) damage(room, t, pr.dmg * 0.6, pr.o, { kb: 4, fx: pr.x, fz: pr.z });
        }
        hitCrittersInRadius(room, pr.x, pr.z, pr.splash, pr.o);
      }
      room.ev.push({ e: 'p-', id: pr.id, x: r2(pr.x), z: r2(pr.z), h: hit });
      ps.splice(i, 1);
    }
  }
}
function blast(room, z) {
  for (const t of room.players) {
    if (t === z.o || t.dead) continue;
    if (Math.hypot(t.x - z.x, t.z - z.z) < z.r + PR) {
      let dmg = z.dmg;
      if (z.ramp) { if (!z.hits) z.hits = new Map(); const n = z.hits.get(t) || 0; z.hits.set(t, n + 1); dmg = Math.round(dmg * (z.ramp[Math.min(n, z.ramp.length - 1)] || 1)); }
      damage(room, t, dmg, z.o, { kb: z.kb, fx: z.x, fz: z.z, slow: z.slow, stun: z.stun, sk: 1 });
    }
  }
  hitCrittersInRadius(room, z.x, z.z, z.r, z.o);
}
function updateZones(room) {
  const zs = room.zones;
  for (let i = zs.length - 1; i >= 0; i--) {
    const z = zs[i]; z.t += DT;
    if (z.chan && (z.o.dead || z.o.cast <= 0)) { zs.splice(i, 1); continue; }
    if (z.done === 0) { if (z.t >= z.delay) { blast(room, z); z.done = 1; z.next = z.delay + z.iv; } }
    else if (z.done < z.ticks && z.t >= z.next) { blast(room, z); z.done++; z.next += z.iv; }
    if (z.done >= z.ticks) zs.splice(i, 1);
  }
}
function triggerGrip(room, p) {
  let tg = null, bestScore = -1;
  const ax = p.ux !== undefined ? p.ux : p.ax, az = p.uz !== undefined ? p.uz : p.az;
  const hasAim = Math.hypot(ax - p.x, az - p.z) > 0.3;
  const aimA = hasAim ? Math.atan2(ax - p.x, az - p.z) : p.face;
  for (const o of foes(room, p)) {
    if (o.inv > 0 || (o.fun && o.fun.star > 0)) continue;
    const dx = o.x - p.x, dz = o.z - p.z, d = Math.hypot(dx, dz);
    if (d > 22) continue;
    const da = Math.abs(angDiff(Math.atan2(dx, dz), aimA));
    const inCone = da < 0.78 ? 120 : 0;
    const score = inCone + (d >= 3.5 ? 60 + d : 20 - d) - da * 18;
    if (score > bestScore) { bestScore = score; tg = o; }
  }
  if (!tg) return false;
  const dx = tg.x - p.x, dz = tg.z - p.z, d = Math.hypot(dx, dz) || 1;
  const dest = { x: p.x + dx / d * 1.75, z: p.z + dz / d * 1.75 };
  confine(dest);
  p.face = Math.atan2(dx, dz);
  tg.fun.pullT = 0.28; tg.fun.pullX = dest.x; tg.fun.pullZ = dest.z;
  tg.dashT = 0; tg.charging = tg.rolling = false; tg.chargeTarget = null; cancelCast(room, tg);
  tg.stun = Math.max(tg.stun, 0.95);
  damage(room, tg, 18, p, { sk: 1 });
  room.ev.push({ e: 'grip', id: p.id, tg: tg.id, x1: r2(p.x), z1: r2(p.z), x2: r2(tg.x), z2: r2(tg.z) });
  return true;
}
function grantFunSlot(p, it) {
  const fn = p.fun, ab = FUN_ABILITY_CFG[it];
  fn.item = it;
  fn.itemT = ab ? ab.dur : 0;
  fn.itemCd = 0;
}
function dropFunItem(room, p) {
  const fn = p.fun, it = fn && fn.item;
  if (!it) return;
  fn.item = ''; fn.itemT = 0; fn.itemCd = 0;
  room.picks.push({ id: room.nextObj++, x: p.x, z: p.z, k: it, owner: p.id, grace: room.time + 1.6 });
  room.ev.push({ e: 'dropit', id: p.id, it });
}
function useFunItem(room, p) {
  const fn = p.fun, it = fn && fn.item;
  if (!it) return;
  const ab = FUN_ABILITY_CFG[it];
  if (ab) {
    if (fn.itemCd > 0) return;
    fn.itemCd = ab.cd;
  } else {
    fn.item = ''; fn.itemT = 0; fn.itemCd = 0;
  }
  const ax = p.ux !== undefined ? p.ux : p.ax, az = p.uz !== undefined ? p.uz : p.az;
  switch (it) {
    case 'grip':
      if (!triggerGrip(room, p)) room.ev.push({ e: 'grip', id: p.id, tg: 0, x1: r2(p.x), z1: r2(p.z), x2: r2(p.x + Math.sin(p.face) * 10), z2: r2(p.z + Math.cos(p.face) * 10) });
      break;
    case 'boom': fn.boom = 6; break;
    case 'star': fn.star = 4; fn.snail = fn.dizzy = 0; p.slow = 0; break;
    case 'giant': fn.giant = 7; fn.mini = 0; break;
    case 'haste': fn.haste = 7; fn.snail = 0; p.slow = 0; break;
    case 'bomb': {
      const pt = aimPoint(p, 15, ax, az);
      room.bombs.push({ id: room.nextObj++, o: p, x: pt.x, z: pt.z, t: 0, air: 0.45, fuse: 0.72 });
      room.ev.push({ e: 'toss', k: 'bomb', id: p.id, x1: r2(p.x), z1: r2(p.z), x2: r2(pt.x), z2: r2(pt.z), air: 0.45, fuse: 0.72 });
      break;
    }
    case 'btrap': {
      const dist = Math.hypot(ax - p.x, az - p.z);
      const pt = dist > 1.2 ? aimPoint(p, 12, ax, az) : (() => {
        const a = p.face + Math.PI, pos = { x: p.x + Math.sin(a) * 1.6, z: p.z + Math.cos(a) * 1.6 };
        confine(pos); return pos;
      })();
      room.picks.push({ id: room.nextObj++, x: pt.x, z: pt.z, k: 'banana', owner: p.id, armAt: room.time + 0.34, grace: room.time + 0.9 });
      room.ev.push({ e: 'toss', k: 'banana', id: p.id, x1: r2(p.x), z1: r2(p.z), x2: r2(pt.x), z2: r2(pt.z), air: 0.34, fuse: 0 });
      break;
    }
    case 'rocket': {
      const aa = Math.hypot(ax - p.x, az - p.z) > 0.3 ? Math.atan2(ax - p.x, az - p.z) : p.face;
      p.face = aa;
      p.dashT = 0.40; p.dashSp = 34; p.dashX = Math.sin(aa); p.dashZ = Math.cos(aa);
      p.charging = p.rolling = false; p.rocket = true; p.rocketHit = new Set();
      p.inv = Math.max(p.inv, 0.42); p.slow = 0;
      room.ev.push({ e: 'atk', id: p.id, k: 'rocket', a: r2(aa) });
      break;
    }
  }
  room.ev.push({ e: 'useit', id: p.id, it });
}
function applyMysteryRoll(room, p) {
  const rolls = ['grip', 'boom', 'star', 'giant', 'haste', 'bomb', 'btrap', 'rocket', 'snail', 'dizzy', 'mini'];
  const weights = [11, 11, 10, 10, 10, 11, 10, 11, 6, 5, 5];
  let r = Math.random() * 100, eff = rolls[0];
  for (let i = 0; i < rolls.length; i++) { r -= weights[i]; if (r <= 0) { eff = rolls[i]; break; } }
  const fn = p.fun;
  if (eff === 'snail') { if (fn.star <= 0) { fn.snail = 5.5; fn.haste = 0; } }
  else if (eff === 'dizzy') { if (fn.star <= 0) fn.dizzy = 4.5; }
  else if (eff === 'mini') { fn.mini = 6; fn.giant = 0; }
  else grantFunSlot(p, eff);
  room.ev.push({ e: 'pk', id: p.id, k: 'box', eff, v: 0 });
}
function pickFunKind() {
  const r = Math.random();
  return r < 0.28 ? 'box' : r < 0.42 ? 'grip' : r < 0.54 ? 'boom' : r < 0.68 ? 'bomb' : r < 0.80 ? 'btrap' : r < 0.90 ? 'rocket' : 'heal';
}
function updateFunCombat(room) {
  if (!room.fun) return;
  const t = room.time;
  if (room.bombs && room.bombs.length) {
    for (let i = room.bombs.length - 1; i >= 0; i--) {
      const bm = room.bombs[i]; bm.t += DT;
      if (bm.t >= bm.air + bm.fuse) {
        for (const o of room.players) {
          if (o.dead || (o.fun && o.fun.star > 0)) continue;
          if (Math.hypot(o.x - bm.x, o.z - bm.z) > 4.6 + PR) continue;
          if (o === bm.o) { const dx = o.x - bm.x, dz = o.z - bm.z, d = Math.hypot(dx, dz) || 1; o.kx += dx / d * 8; o.kz += dz / d * 8; }
          else damage(room, o, 54, bm.o, { kb: 14, fx: bm.x, fz: bm.z, stun: 0.75, sk: 1 });
        }
        room.ev.push({ e: 'bombx', x: r2(bm.x), z: r2(bm.z), r: 4.6 });
        hitCrittersInRadius(room, bm.x, bm.z, 4.6, bm.o);
        room.bombs.splice(i, 1);
      }
    }
  }
  for (const p of room.players) {
    if (p.dead || !p.fun) continue;
    const fn = p.fun;
    if (fn.star > 0) {
      for (const o of foes(room, p)) {
        if (Math.hypot(o.x - p.x, o.z - p.z) > PR * 2 + 0.7) continue;
        const last = fn.starHit.get(o.id) || -9;
        if (t - last < 0.55) continue;
        fn.starHit.set(o.id, t);
        damage(room, o, 24, p, { kb: 12, fx: p.x, fz: p.z, sk: 1 });
      }
      hitCrittersInRadius(room, p.x, p.z, PR + 0.7, p);
    }
    if (fn.boom > 0) {
      for (let b = 0; b < 3; b++) {
        const a = fn.boomAng + b * (TAU / 3), bx = p.x + Math.sin(a) * 2.9, bz = p.z + Math.cos(a) * 2.9;
        for (const o of foes(room, p)) {
          if (Math.hypot(o.x - bx, o.z - bz) > PR + 0.7) continue;
          const last = fn.boomHit.get(o.id) || -9;
          if (t - last < 0.65) continue;
          fn.boomHit.set(o.id, t);
          if (damage(room, o, 22, p, { kb: 8.5, fx: p.x, fz: p.z, stun: 0.32, sk: 1 })) {
            room.ev.push({ e: 'boomhit', id: o.id, by: p.id });
          }
        }
        hitCrittersInRadius(room, bx, bz, 0.7, p);
      }
    }
  }
}
const CRITTER_R = 0.25;
function confineCritter(c) {
  for (const p of PILLARS) {
    const dx = c.x - p.x, dz = c.z - p.z, d = Math.hypot(dx, dz), min = p.r + CRITTER_R;
    if (d < min) { if (d > 0.001) { c.x = p.x + dx * min / d; c.z = p.z + dz * min / d; } else c.x = p.x + min; return true; }
  }
  const d = Math.hypot(c.x, c.z), max = R - CRITTER_R;
  if (d > max) { c.x *= max / d; c.z *= max / d; return true; }
  return false;
}
function spawnChicken(room, edge = false) {
  let x = 0, z = 0;
  for (let n = 0; n < 8; n++) {
    const a = Math.random() * TAU, r = edge ? R - 2 : 4 + Math.random() * (R - 8);
    x = Math.sin(a) * r; z = Math.cos(a) * r;
    if (PILLARS.every(p => Math.hypot(x - p.x, z - p.z) > p.r + CRITTER_R + 0.4)) break;
  }
  const c = { id: room.nextObj++, x, z, face: Math.random() * TAU, a: Math.random() * TAU, waitT: 0.5 + Math.random() * 1.7, walkT: 1 + Math.random() * 1.4, spd: 0 };
  confineCritter(c);
  room.critters.push(c);
  return c;
}
function initCritters(room) {
  room.critters = []; room.critterTimers = [];
  for (let i = 0; i < 4; i++) spawnChicken(room, false);
}
function killCritter(room, c, by) {
  const idx = room.critters ? room.critters.indexOf(c) : -1;
  if (idx < 0) return;
  room.critters.splice(idx, 1);
  room.critterTimers.push(15);
  room.ev.push({ e: 'ck', x: r2(c.x), z: r2(c.z), by: by ? by.id : 0 });
}
function hitCrittersInRadius(room, x, z, r, by) {
  if (!room.critters || !room.critters.length) return 0;
  let n = 0;
  for (const c of room.critters.slice()) if (Math.hypot(c.x - x, c.z - z) < r + CRITTER_R) { killCritter(room, c, by); n++; }
  return n;
}
function hitCrittersInArc(room, x, z, fa, range, half, by) {
  if (!room.critters || !room.critters.length) return 0;
  let n = 0;
  for (const c of room.critters.slice()) {
    const dx = c.x - x, dz = c.z - z, dd = Math.hypot(dx, dz);
    if (dd < range + CRITTER_R && (dd < CRITTER_R + 0.85 || Math.abs(angDiff(Math.atan2(dx, dz), fa)) < half)) { killCritter(room, c, by); n++; }
  }
  return n;
}
function updateCritters(room) {
  if (!room.critters) initCritters(room);
  for (let i = room.critterTimers.length - 1; i >= 0; i--) {
    room.critterTimers[i] -= DT;
    if (room.critterTimers[i] <= 0) { room.critterTimers.splice(i, 1); if (room.critters.length < 4) spawnChicken(room, true); }
  }
  for (const c of room.critters) {
    let near = null, bd = 3.2;
    for (const p of room.players) {
      if (p.dead) continue;
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < bd) { bd = d; near = p; }
    }
    let spd = 0;
    if (near) {
      c.a = Math.atan2(c.x - near.x, c.z - near.z); c.walkT = 0.7; c.waitT = 0; spd = 4.2;
    } else if (c.walkT > 0) {
      c.walkT -= DT; spd = 1.65;
      if (c.walkT <= 0) c.waitT = 1.0 + Math.random() * 1.8;
    } else {
      c.waitT -= DT;
      if (c.waitT <= 0) { c.a = Math.random() * TAU; c.walkT = 1.2 + Math.random() * 1.8; }
    }
    c.spd = spd;
    if (spd > 0) {
      c.x += Math.sin(c.a) * spd * DT; c.z += Math.cos(c.a) * spd * DT;
      if (confineCritter(c)) c.a += Math.PI * 0.75;
      c.face += angDiff(c.a, c.face) * Math.min(1, DT * 10);
    }
  }
}
function updatePicks(room) {
  room.pickT -= DT;
  const maxP = room.fun ? 6 : 4;
  if (room.pickT <= 0) {
    room.pickT = room.fun ? 3.8 : 7;
    if (room.picks.length < maxP) {
      const kind = room.fun ? pickFunKind() : 'heal';
      const k = { id: room.nextObj++, x: 0, z: 0, k: kind };
      for (let n = 0; n < 8; n++) {
        const a = Math.random() * TAU, d = 3 + Math.random() * 16; k.x = Math.sin(a) * d; k.z = Math.cos(a) * d;
        if (PILLARS.every(c => Math.hypot(k.x - c.x, k.z - c.z) > c.r + 1.2)) break;
      }
      room.picks.push(k);
    }
  }
  for (let i = room.picks.length - 1; i >= 0; i--) {
    const k = room.picks[i], kind = k.k || 'heal';
    if (kind === 'banana' && k.armAt && room.time < k.armAt) continue;
    for (const p of room.players) {
      if (p.dead || Math.hypot(p.x - k.x, p.z - k.z) > 1.1) continue;
      if (kind !== 'banana' && kind !== 'heal' && k.owner === p.id && room.time < (k.grace || 0)) continue;
      if (kind === 'heal') {
        const max = CLS[p.cls].hp;
        if (p.hp >= max) continue;
        const got = Math.min(max - p.hp, Math.round(max * 0.35)); p.hp += got;
        room.ev.push({ e: 'pk', id: p.id, k: 'heal', v: got }); room.picks.splice(i, 1); break;
      }
      if (kind === 'banana') {
        if ((p.fun && p.fun.star > 0) || (k.owner === p.id && room.time < (k.grace || 0))) continue;
        p.stun = Math.max(p.stun, 1.35);
        p.kx += Math.sin(p.face) * 16; p.kz += Math.cos(p.face) * 16;
        p.dashT = 0; p.charging = p.rolling = p.rocket = false; cancelCast(room, p);
        room.ev.push({ e: 'slip', id: p.id, x: r2(p.x), z: r2(p.z) }); room.picks.splice(i, 1); break;
      }
      if (kind === 'box') {
        applyMysteryRoll(room, p);
        room.picks.splice(i, 1); break;
      }
      grantFunSlot(p, kind);
      room.ev.push({ e: 'pk', id: p.id, k: kind, eff: kind, v: 0 }); room.picks.splice(i, 1); break;
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
  if (room.picks.length && (p.hp < CLS[p.cls].hp * 0.35 || (room.fun && d > 4.5))) {
    let bk = null, bd = 12;
    for (const k of room.picks) {
      if (k.k === 'banana') continue;
      if (k.k === 'heal' && p.hp >= CLS[p.cls].hp * 0.85) continue;
      const kd = Math.hypot(k.x - p.x, k.z - p.z); if (kd < bd) { bd = kd; bk = k; }
    }
    if (bk) { mx = (bk.x - p.x) / (bd || 1); mz = (bk.z - p.z) / (bd || 1); }
  }
  const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
  p.mx = mx; p.mz = mz;
  const wantA = Math.atan2(ai.tx - p.x, ai.tz - p.z) + ai.err * (melee ? 0.5 : 0.75);
  p.a += clamp(angDiff(wantA, p.a), -df.turn * DT, df.turn * DT);
  p.ax = ai.tx + ai.err * 2.5; p.az = ai.tz - ai.err * 2.5;
  const aimed = Math.abs(angDiff(wantA, p.a)) < 0.85;
  let b = 0;
  if (p.fun && p.fun.item && !(p.fun.itemCd > 0) && ai.gcd <= 0 && ((p.fun.item === 'grip' && d > 4 && d < 20) || (p.fun.item === 'bomb' && d < 14) || (p.fun.item !== 'grip' && p.fun.item !== 'bomb' && d < 12))) {
    ai.gcd = df.gcd; b |= 32;
  }
  if (ai.fire && aimed && d < (melee ? 3.2 : 15.5)) b |= 1;
  if (ai.gcd <= 0 && aimed) {
    const c = CLS[p.cls];
    if (ai.u && p.cd.u <= 0 && !p.air && p.res >= c.cost[3] && (melee ? d < 4.2 : (d > 3.5 && d < c.range))) {
      ai.u = false; ai.gcd = df.gcd + 0.4; if (!melee) p.mx = p.mz = 0; p.ux = p.ax; p.uz = p.az; b = 32;
    } else if (melee && d > 4.2 && d < 14 && ai.roll && p.cd.dodge <= 0) {
      ai.roll = false; ai.gcd = df.gcd; p.chargeTgId = t.id; b |= 8;
    } else if (!melee && p.cd.dodge <= 0 && ((ai.roll && d < 5.5) || d < 3.4 || p.stun > 0.2 || p.freeze > 0.2)) {
      ai.roll = false; ai.gcd = df.gcd; p.mx = -dx; p.mz = -dz; b |= 8;
    } else if (ai.q && p.cd.q <= 0 && (melee ? d < 3.6 : p.cls === 'ranger' ? d < 9.5 : d < 5.6)) {
      ai.q = false; ai.gcd = df.gcd; b |= 2;
    } else if (ai.e && p.cd.e <= 0 && (melee ? (p.hp < c.hp * 0.78 && d < 5.5) : d < 14)) {
      ai.e = false; ai.gcd = df.gcd; b |= 4;
    }
  }
  if (ai.jump && ml > 0.3) { b |= 16; ai.jump = false; }
  p.pend = b;
}

/* ---------------- rounds & tick ---------------- */
function endRound(room) {
  if (room.phase !== 'play') return;
  room.phase = 'end'; room.phaseT = END_TIME; room.rosterDirty = true;
  logAccess({ ip: 'room', event: 'round_end', room: room.code, detail: { diff: room.diff, bots: room.botCount,
    ips: [...new Set(room.players.filter(p => !p.bot && p.ip).map(p => p.ip))].slice(0, MAX_PLAYERS),
    players: room.players.map(p => ({ input: p.input || '', id: p.id, name: p.name, cls: p.cls, bot: p.bot ? 1 : 0, kills: p.kills, deaths: p.deaths, dmg: Math.round(p.dmg) })) } });
}
function startRound(room) {
  room.phase = 'play'; room.roundT = ROUND_TIME; room.proj.length = room.zones.length = room.picks.length = 0; if (room.bombs) room.bombs.length = 0; room.pickT = room.fun ? 3 : 6; room.hasFb = false;
  initCritters(room);
  for (const p of room.players) { p.kills = p.deaths = p.dmg = p.streak = p.maxStreak = p.mk = p.mkT = 0; p.dead = false; p.cd.u = 0; p.spinUltT = 0; p.wallT = 0; }
  for (const p of room.players) respawn(room, p);
  room.rosterDirty = true;
}
function tickRoom(room) {
  const prev2s = Math.floor(room.time / 2);
  room.time += DT;
  if (Math.floor(room.time / 2) !== prev2s) room.rosterDirty = true;
  room.botT -= DT; if (room.botT <= 0) { room.botT = 1; manageBots(room); }
  // 回合闸：真人长时间没有有效输入时不再自动开下一局，避免 7 个 bot 自己把房间一直续下去
  if (room.phase === 'end') {
    const idle = !room.humanAct || Date.now() - room.humanAct > AFK_IDLE_MS;
    if (idle) room.phaseT = 0;
    else {
      if (room.phaseT <= 0) room.phaseT = END_TIME;
      room.phaseT -= DT; if (room.phaseT <= 0) startRound(room);
    }
  }
  else {
    if (room.players.length >= 2) { room.roundT -= DT; if (room.roundT <= 0) endRound(room); }
    for (const p of room.players.slice()) updatePlayer(room, p);
    separate(room); updateFunCombat(room); updateProj(room); updateZones(room); updatePicks(room); updateCritters(room);
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
    p: room.players.map(p => {
      const fn = p.fun || {};
      return [p.id, r2(p.x), r2(p.z), r2(p.face), Math.max(0, Math.round(p.hp)),
        (p.dead ? 1 : 0) | (p.inv > 0 ? 2 : 0) | (p.dashT > 0 && p.rolling ? 4 : 0) | (p.dashT > 0 && p.charging ? 8 : 0) | (p.freeze > 0 ? 16 : 0) |
        (p.stun > 0 ? 32 : 0) | (p.slow > 0 ? 64 : 0) | (p.prot > 0 ? 128 : 0) | (p.moving ? 256 : 0) | (p.air ? 512 : 0) | (p.cast > 0 ? 1024 : 0) |
        (fn.star > 0 ? 2048 : 0) | (fn.giant > 0 ? 4096 : 0) | (fn.mini > 0 ? 8192 : 0) | (fn.haste > 0 ? 16384 : 0) |
        (fn.boom > 0 ? 32768 : 0) | (fn.dizzy > 0 ? 65536 : 0) | (fn.snail > 0 ? 131072 : 0) | (p.wallT > 0 ? 262144 : 0) |
        (p.spinUltT > 0 ? 524288 : 0),
        CLS_IDS.indexOf(p.cls), r2(p.y)];
    }),
    k: room.picks.map(k => [k.id, r2(k.x), r2(k.z), k.k || 'heal']),
    cr: (room.critters || []).map(c => [c.id, r2(c.x), r2(c.z), r2(c.face), c.spd > 0 ? 1 : 0]),
    ev: room.ev,
  });
  room.ev = [];
  const cdv = v => v > 0 ? Math.round(v * 20) / 20 : 0;
  // 每个人自己的部分：冷却 [2 号, 3 号, 翻滚, 4 号, 普攻]、资源、读条剩余、重生倒计时
  for (const p of room.players) if (p.ws) send(p.ws, '{"t":"s","ack":' + p.seq + ',"cd":[' + cdv(p.cd.q) + ',' + cdv(p.cd.e) + ',' + cdv(p.cd.dodge) + ',' + cdv(p.cd.u) + ',' + cdv(p.cd.atk) +
    '],"res":' + Math.round(p.res) + ',"ct":' + cdv(p.cast) + ',"rs":' + cdv(p.dead ? p.respawnT : 0) + ',"it":' + JSON.stringify((p.fun && p.fun.item) || '') + ',"itt":' + cdv((p.fun && p.fun.itemT) || 0) + ',"itc":' + cdv((p.fun && p.fun.itemCd) || 0) + ',"w":' + shared + '}');
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
    recentTickMs = recentTickMs * 0.9 + dtMs * 0.1;
    tickSumMs += dtMs; if (dtMs > tickMaxMs) tickMaxMs = dtMs; tickCount++;
  }
}, 5);

/* ---------------- connections ---------------- */
function admitJoin(ws, ip, ua, m) {
  if (ws.readyState !== 1 || ws.player) return;
  const cls = CLS_IDS.includes(m.cls) ? m.cls : 'knight';
  const code = cleanRoomCode(m.room);
  const bots = Number.isFinite(Number(m.bots)) ? clamp(Math.floor(Number(m.bots)), 0, MAX_PLAYERS - 1) : Math.max(0, BOT_FILL - 1);
  const diff = typeof m.diff === 'string' && BOT_DIFF[m.diff] ? m.diff : 'normal';
  const roomPwd = cleanRoomPwd(m.roomPwd);
  const fun = !!m.fun;
  const input = ['touch', 'pad', 'kbm'].includes(m.input) ? m.input : '';
  let room, created = false;
  if (m.create) {                                    // DEMO 禁止自定义房间号：创建房间一律由服务器随机生成 4 位房间号
    // 版本闸：只拦「创建新房间」。加入已有房间不受限，避免旧页面玩家被直接踢出游戏
    const vc = verCmp(m.ver, MIN_CREATE_VER);
    if (vc === null || vc < 0) {
      logAccess({ ip, ua, event: 'ver_stale', status: 4003, detail: { ver: cleanText(m.ver, 32) || '', min: MIN_CREATE_VER } });
      send(ws, JSON.stringify({ t: 'denied', code: 'verold', ver: APP_VERSION, min: 'v' + MIN_CREATE_VER, msg: '版本过旧，请刷新页面后重新创建房间' }));
      ws.close(4003);
      return;
    }
    if (rooms.size >= MAX_ROOMS) { send(ws, '{"t":"full"}'); ws.close(1013); return; }
    room = makeRoom(randomCode(), bots, diff, roomPwd, fun); created = true;
  } else if (code) {                                 // 仅允许加入已存在的房间，不允许通过自定义房间号新建房间
    room = rooms.get(code);
    if (!room) { send(ws, '{"t":"noroom","code":"noroom","msg":"该房间不存在或已结束，请检查房间号"}'); ws.close(1000); return; }
    if (room.pwd && roomPwd !== room.pwd) {
      send(ws, JSON.stringify({ t: 'roompass', code: 'roompass', need: !roomPwd, msg: roomPwd ? '房间密码错误' : '该房间已加密，请输入密码' }));
      ws.close(1000); return;
    }
  } else {
    for (const r of rooms.values()) if (!r.pwd && !!r.fun === fun && r.diff === diff && humans(r) < MAX_PLAYERS && (!room || humans(r) > humans(room))) room = r;
    if (!room) for (const r of rooms.values()) if (!r.pwd && !!r.fun === fun && humans(r) < MAX_PLAYERS && (!room || humans(r) > humans(room))) room = r;
    if (!room) {
      if (rooms.size >= MAX_ROOMS) { send(ws, '{"t":"full"}'); ws.close(1013); return; }
      room = makeRoom(randomCode(), bots, diff, '', fun); created = true;
    }
  }
  if (room.players.length >= MAX_PLAYERS) {
    const bot = room.players.find(p => p.bot);
    if (!bot) { send(ws, '{"t":"full"}'); ws.close(1013); return; }
    removePlayer(room, bot);
    if (!rooms.has(room.code)) rooms.set(room.code, room);
  }
  const used = new Set(room.players.map(q => q.name));
  const freeNames = PLAYER_NAMES.filter(n => !used.has(n));
  const autoName = freeNames.length ? freeNames[Math.random() * freeNames.length | 0] : ('勇士' + room.nextId);
  const p = makePlayer(room, autoName, cls, ws);
  ws.player = p; ws.room = room; ws.joinAt = Date.now(); p.input = input; p.ip = ip;
  logAccess({ ip, ua, event: 'ws_join', room: room.code, name: p.name, cls: p.cls, detail: { created, bots: room.botCount, diff: room.diff, fun: room.fun ? 1 : 0, humans: humans(room), input: p.input || '' } });
  logDebug('INFO', 'room', (created ? '创建并加入房间 ' : '加入房间 ') + room.code, { ip, room: room.code, name: p.name, cls: p.cls, bots: room.botCount, diff: room.diff, fun: !!room.fun });
  send(ws, JSON.stringify({ t: 'welcome', id: p.id, name: p.name, cls: p.cls, room: room.code, diff: room.diff, fun: room.fun ? 1 : 0, x: r2(p.x), z: r2(p.z),
    cfg: { cls: CLS, res: RES, resMax: RES_MAX, ult: ULT, move: MOVE, rollCd: ROLL.cd, rollDur: ROLL.dur, rollSp: ROLL.sp, chargeDur: CHARGE.dur, chargeSp: CHARGE.sp,
      jumpV: JUMP.v, jumpG: JUMP.g, slowK: SLOW_K, target: KILL_TARGET, max: MAX_PLAYERS } }));
}
setInterval(() => {
  for (let i = loginQueue.length - 1; i >= 0; i--) if (loginQueue[i].ws.readyState !== 1) loginQueue.splice(i, 1);
  if (loginQueue.length && !getLoadStatus().overloaded) {
    const entry = loginQueue.shift();
    entry.ws.queued = false;
    admitJoin(entry.ws, entry.ip, entry.ua, entry.m);
  }
  for (let i = 0; i < loginQueue.length; i++) sendQueueMsg(loginQueue[i].ws, i + 1);
}, 1500);

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 });
const ipConns = new Map();
wss.on('connection', (ws, req) => {
  const ip = clientIp(req), ua = clientUa(req), curIp = ipConns.get(ip) || 0;
  if (wss.clients.size > MAX_CONNECTIONS || curIp >= MAX_CONN_PER_IP) {
    logAccess({ ip, ua, event: 'ws_rejected', status: 1013, detail: { conns: wss.clients.size, curIp } });
    ws.close(1013);
    return;
  }
  ipConns.set(ip, curIp + 1);
  ws.alive = true; ws.player = null; ws.room = null; ws.queued = false; ws.msgN = 0; ws.joinAt = 0;
  const joinTimer = setTimeout(() => { if (!ws.player && !ws.queued) ws.terminate(); }, 5000);
  ws.on('pong', () => { ws.alive = true; });
  ws.on('error', err => { logDebug('WARN', 'ws', 'WebSocket 错误', { ip, err: String(err && err.message || err) }); });
  ws.on('close', () => {
    clearTimeout(joinTimer);
    if (ws.queued) {
      ws.queued = false;
      const qi = loginQueue.findIndex(e => e.ws === ws);
      if (qi >= 0) loginQueue.splice(qi, 1);
    }
    const n = (ipConns.get(ip) || 1) - 1;
    if (n <= 0) ipConns.delete(ip); else ipConns.set(ip, n);
    if (ws.room && ws.player) {
      const p = ws.player, durSec = ws.joinAt ? Math.round((Date.now() - ws.joinAt) / 1000) : 0;
      logAccess({ ip, ua, event: 'ws_leave', room: ws.room.code, name: p.name, cls: p.cls, detail: { durSec, kills: p.totalKills, deaths: p.totalDeaths, dmg: Math.round(p.totalDmg), roundKills: p.kills, roundDeaths: p.deaths, input: p.input || '' } });
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
      const a0 = p.a || 0, a1 = num(m.a) % TAU;
      p.mx = mx; p.mz = mz; p.a = a1; p.ax = clamp(num(m.ax), -R, R); p.az = clamp(num(m.az), -R, R);
      const b = (m.b | 0) & 255;                        // 1 普攻 2/4 技能 8 翻滚 16 跳跃 32 大招/道具 64 取消读条 128 丢弃道具
      // AFK：只有真实操作才续命。空包（无位移、无按键、视角不动）不算，否则挂机客户端每帧发空包就能永久保活
      if (Math.abs(mx) > 0.05 || Math.abs(mz) > 0.05 || Math.abs(a1 - a0) > 0.02 || b) {
        p.lastAct = Date.now(); if (p.afkWarn) p.afkWarn = 0;
        if (ws.room) ws.room.humanAct = p.lastAct;
      }
      if (b & 32) { p.ux = p.ax; p.uz = p.az; }         // 记住选定的位置，免得被后面的输入包覆盖
      if (b & 8) p.chargeTgId = m.tg | 0;
      p.pend |= b;
    } else if (m.t === 'join' && !ws.player && !ws.queued) {
      const js = authState(ip, m.token, m.pass);
      if (js !== 'ok') {
        if (js === 'bad') { recordAuthFail(ip); logDebug('WARN', 'ws', 'WebSocket join 口令错误', { ip }); }
        logAccess({ ip, ua, event: js === 'expired' ? 'token_expired' : 'ws_auth_fail', status: 4001 });
        send(ws, JSON.stringify({ t: 'denied', code: js, msg: AUTH_MSG[js] }));
        ws.close(4001);
        return;
      }
      clearTimeout(joinTimer);
      const st = getLoadStatus();
      if (st.overloaded || loginQueue.length > 0) {
        ws.queued = true;
        loginQueue.push({ ws, ip, ua, m, joinedAt: Date.now() });
        logDebug('INFO', 'queue', '高负载进入排队', { ip, pos: loginQueue.length, load: st });
        sendQueueMsg(ws, loginQueue.length);
        return;
      }
      admitJoin(ws, ip, ua, m);
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
// AFK 巡检：真人长时间无有效输入就踢出。进入预警窗口后每秒推一次剩余秒数，前端据此显示倒计时。
// 这里只处理真人；bot 的 lastAct 不刷新，但 bot 不参与判断。
setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    const p = ws.player;
    if (!p || p.bot) continue;
    const idle = now - (p.lastAct || now);
    const left = Math.ceil((AFK_IDLE_MS - idle) / 1000);
    if (left <= 0) {
      logAccess({ ip: p.ip, event: 'afk_kick', room: ws.room ? ws.room.code : null, name: p.name, cls: p.cls, detail: { idleSec: Math.round(idle / 1000) } });
      send(ws, JSON.stringify({ t: 'afk', left: 0, sec: AFK_IDLE_SEC, kicked: 1 }));
      try { ws.close(4002, 'afk'); } catch (e) {}
      continue;
    }
    if (left <= AFK_WARN_SEC && left !== p.afkWarn) {
      p.afkWarn = left;
      send(ws, JSON.stringify({ t: 'afk', left, sec: AFK_IDLE_SEC }));
    }
  }
}, 1000);
setInterval(() => { sampleLoad(); }, 30000);
// 房间回收巡检：
//   1. 先清「僵尸真人」——已经断线但 close 回调没跑到（移动端切后台、进程被杀）的玩家对象，
//      它会让 humans() 恒为 1，房间因此永远不删；
//   2. 一个真人都不剩 → 立刻关房；
//   3. 还有人在线但整间超过 ROOM_IDLE_MS 没有有效输入 → 一样关房，避免 7 个 bot 自己续局。
setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    for (const p of room.players.slice()) {
      if (p.bot) continue;
      const ws = p.ws;
      if (!ws || ws.readyState !== 1) removePlayer(room, p);
    }
    if (!rooms.has(room.code)) continue;
    if (humans(room) === 0) { closeRoom(room, 'nohuman'); continue; }
    if (now - (room.humanAct || 0) >= ROOM_IDLE_MS) closeRoom(room, 'idle');
  }
}, 5000);
setInterval(() => {
  try {
    db.exec(`
      -- 分事件保留：combat_kill 量大且价值低，单独限 2 万条；其余事件（访问/进房/回合/安全）保留 5 万条。
      -- 以前按总量 5 万滚动，挂机房的击杀明细会把真人访问数据整段挤掉。
      DELETE FROM access_logs WHERE IFNULL(event,'') = 'combat_kill'
        AND id NOT IN (SELECT id FROM access_logs WHERE IFNULL(event,'') = 'combat_kill' ORDER BY id DESC LIMIT 20000);
      DELETE FROM access_logs WHERE IFNULL(event,'') <> 'combat_kill'
        AND id NOT IN (SELECT id FROM access_logs WHERE IFNULL(event,'') <> 'combat_kill' ORDER BY id DESC LIMIT 50000);
      DELETE FROM load_metrics WHERE id NOT IN (SELECT id FROM load_metrics ORDER BY id DESC LIMIT 20000);
      DELETE FROM debug_logs WHERE id NOT IN (SELECT id FROM debug_logs ORDER BY id DESC LIMIT 20000);
      DELETE FROM solo_runs WHERE substr(ts,1,10) < date('now','-180 days');  -- 单人遥测只留 180 天
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

const listenServer = (SSL_CERT && SSL_KEY) ? net.createServer({ pauseOnConnect: true }, socket => {
  socket.on('error', () => {});
  socket.once('readable', () => {
    const chunk = socket.read(1);
    if (!chunk) return socket.destroy();
    socket.unshift(chunk);
    if (chunk[0] === 0x16) {
      server.emit('connection', socket);
    } else {
      const rest = socket.read() || Buffer.alloc(0);
      const m = rest.toString('latin1').match(/^[A-Z]+\s+(\S+)/);
      const pathPart = (m && m[1] && m[1].startsWith('/')) ? m[1] : '/';
      socket.end('HTTP/1.1 302 Found\r\nLocation: ' + HTTP_REDIRECT_URL + pathPart + '\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });
}) : server;

listenServer.listen(PORT, HOST, () => {
  sampleLoad();
  logDebug('INFO', 'server', '烬冠竞技场 DEMO 服务器已启动', { port: PORT, adminPort: (ADMIN_PORT > 0 && ADMIN_HASH) ? ADMIN_PORT : 0, adminHost: ADMIN_HOST, host: HOST, db: DB_PATH, maxPlayers: MAX_PLAYERS, botFill: BOT_FILL, tls: !!(SSL_CERT && SSL_KEY) });
  if (DEMO_AUTH && DEMO_PASS_AUTO) console.log('[WARN:auth] 未配置 DEMO_PASS 环境变量，本次启动已生成临时随机口令: ' + DEMO_PASS);   // 只打印，不写入数据库
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) console.log('  局域网： ' + (SSL_CERT && SSL_KEY ? 'https://' : 'http://') + i.address + ':' + PORT);
});
if (ADMIN_PORT > 0 && ADMIN_HASH) adminServer.listen(ADMIN_PORT, ADMIN_HOST);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  logDebug('INFO', 'server', '收到退出信号 ' + sig + '，正在关闭服务器');
  for (const ws of wss.clients) ws.close(1001);
  try { adminServer.close(); } catch (e) {}
  listenServer.close(() => { try { db.close(); } catch (e) {} process.exit(0); });
  setTimeout(() => { try { db.close(); } catch (e) {} process.exit(0); }, 500);
});
