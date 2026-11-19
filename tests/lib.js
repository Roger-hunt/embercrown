'use strict';
// 测试公共部分：在临时端口 + 临时数据目录上起一个隔离的服务器实例，用无头 Chromium 打开页面。
// 不碰线上进程、不碰 data/ 下的真实数据库。
//
// 依赖（都不进 package.json，按下面顺序查找）：
//   playwright-core：环境变量 EC_PLAYWRIGHT（模块目录）→ 本项目 node_modules → EC_MODULE_DIRS / 常见位置
//   Chromium：        环境变量 EC_CHROME（可执行文件）→ playwright 自带 → ~/.cache/ms-playwright 里已有的版本
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = process.env.EC_ROOT || path.resolve(__dirname, '..');
const PASS = 'test-pass-1';
const HOME = os.homedir();
const MODULE_DIRS = (process.env.EC_MODULE_DIRS || '').split(path.delimiter).filter(Boolean).concat([
  path.join(ROOT, 'node_modules'),
  path.join(HOME, 'homestore/frontend/node_modules'), path.join(HOME, 'jave/node_modules'), path.join(HOME, 'salesman2/frontend/node_modules'),
]);
function findModule(name, envVar) {
  const tried = [];
  if (envVar && process.env[envVar]) { try { return require(process.env[envVar]); } catch (e) { tried.push(process.env[envVar]); } }
  for (const d of MODULE_DIRS) { const p = path.join(d, name); if (fs.existsSync(p)) { try { return require(p); } catch (e) { tried.push(p); } } }
  try { return require(name); } catch (e) {}
  const err = new Error('找不到模块 ' + name + '。用环境变量 ' + (envVar || 'EC_MODULE_DIRS') + ' 指定它所在的位置（EC_MODULE_DIRS 填 node_modules 目录，可用 ' + path.delimiter + ' 分隔多个）。');
  err.code = 'EC_NO_TOOL'; throw err;
}
function findChrome() {
  if (process.env.EC_CHROME) return process.env.EC_CHROME;
  const base = path.join(HOME, '.cache/ms-playwright');
  let dirs = []; try { dirs = fs.readdirSync(base).sort().reverse(); } catch (e) {}
  for (const d of dirs) {
    for (const rel of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const p = path.join(base, d, rel); if (fs.existsSync(p)) return p;
    }
  }
  return undefined;                                    // 交给 playwright 自己找
}
function get(url) { return new Promise((res, rej) => { http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej); }); }

// QUEUE_LOAD=99：机器负载高时服务器会让联机排队，测试实例里关掉
async function startServer(port, extraEnv = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-test-data-'));
  const env = Object.assign({}, process.env, { HOST: '127.0.0.1', PORT: String(port), ADMIN_PORT: '0', DEMO_PASS: PASS, QUEUE_LOAD: '99', QUEUE_HUMANS: '200', QUEUE_TICK_MS: '9999',
    DB_PATH: path.join(data, 't.db'), SEC_LOG: path.join(data, 'sec.log') }, extraEnv);
  for (const k of ['DEBUG', 'LOG_LEVEL', 'TRUST_PROXY', 'ADMIN_TOKEN', 'DEV_START_WAVE', 'QUEUE_FORCE']) if (!(k in extraEnv)) delete env[k];
  const logFile = path.join(data, 'out.log'), out = fs.openSync(logFile, 'a');
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', out, out] });
  const stop = () => new Promise(r => { const done = () => { try { fs.rmSync(data, { recursive: true, force: true }); } catch (e) {} r(); }; proc.once('exit', done); proc.kill('SIGTERM'); setTimeout(() => { try { proc.kill('SIGKILL'); } catch (e) {} }, 1500); });
  for (let i = 0; i < 80; i++) {
    try { const r = await get('http://127.0.0.1:' + port + '/healthz'); if (r.status === 200) return { proc, data, port, logFile, url: 'http://127.0.0.1:' + port + '/', stop }; } catch (e) {}
    await sleep(100);
  }
  const log = fs.readFileSync(logFile, 'utf8'); proc.kill('SIGKILL');
  throw new Error('测试服务器没有启动：\n' + log);
}
async function launch(opts = {}) {
  const { chromium } = findModule('playwright-core', 'EC_PLAYWRIGHT');
  return chromium.launch({ executablePath: findChrome(), headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--mute-audio'].concat(opts.args || []) });
}
// render: false（默认）= 跳过真正的 WebGL 绘制，逻辑照常逐帧运行（软件渲染每秒只有 2 帧，逻辑测试用不着画面）
// render: true        = 真实渲染，并暴露 window.__renderer / __scene / __cam
const SHIM_SKIP = ';(function(){var O=THREE.WebGLRenderer;THREE.WebGLRenderer=function(p){var r=new O(p);r.render=function(s,c){window.__frames=(window.__frames||0)+1;window.__lastScene=s;window.__lastCam=c;};return r;};})();';
const SHIM_REAL = ';(function(){var O=THREE.WebGLRenderer;THREE.WebGLRenderer=function(p){var r=new O(p);window.__renderer=r;var orig=r.render;r.render=function(s,c){window.__scene=window.__lastScene=s;window.__cam=c;var t0=performance.now();orig.call(r,s,c);window.__renderMs=(window.__renderMs||0)+(performance.now()-t0);window.__frames=(window.__frames||0)+1;};return r;};})();';
async function openGame(browser, url, opts = {}) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 960, height: 540 } }, opts.context || {}));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR ' + (e.stack || e.message).split('\n').slice(0, 3).join(' | ')));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 300)); });
  await page.route('**/vendor/three.min.js', async route => {
    const resp = await route.fetch(); const body = await resp.text();
    await route.fulfill({ response: resp, body: body + (opts.render === true ? SHIM_REAL : SHIM_SKIP) });
  });
  // 测试实例不该往外发遥测：拦掉单人统计上报
  await page.route('**/telemetry/**', route => route.fulfill({ status: 204, body: '' }));
  if (opts.init) await page.addInitScript(opts.init);
  await page.goto(url, { waitUntil: 'load' });
  if (opts.gate !== false) await enter(page, PASS, opts.render === true ? 120000 : 20000);   // 真实渲染很慢，多等一会
  return { ctx, page, errors };
}
// 输口令 → 过登录/加载页 → 等主菜单出现
async function enter(page, pass = PASS, timeoutMs = 20000) {
  const vis = id => page.evaluate(id => { const el = document.getElementById(id); return !!el && !el.hidden; }, id);
  if (await vis('gate')) { await page.fill('#inPass', pass); await page.click('#btnGate'); }
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await vis('menu')) return;
    if (await vis('login')) {                          // 登录页：资源加载完后点「进入」
      const clicked = await page.evaluate(() => { const b = document.getElementById('btnEnterGame'); if (b && !b.disabled && !b.hidden) { b.click(); return true; } return false; });
      if (clicked) await sleep(150);
    }
    await sleep(100);
  }
  throw new Error(Math.round(timeoutMs / 1000) + ' 秒内没有进入主菜单（口令页或登录加载页卡住）');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 等游戏时钟走过 sec 秒
async function gameWait(page, sec) {
  await page.evaluate(sec => new Promise(res => { const g = window.__arena.game, t0 = g.time, w0 = performance.now(); (function chk() { if (g.time - t0 >= sec || performance.now() - w0 > sec * 1000 + 15000) res(); else requestAnimationFrame(chk); })(); }), sec);
}
async function frames(page, n) { await page.evaluate(n => new Promise(res => { let i = 0; (function f() { if (++i > n) res(); else requestAnimationFrame(f); })(); }), n); }
async function pickClass(page, cls) { await page.click('#hero-' + cls); }
// 结果收集：check(名称, 是否通过, 细节)，最后 finish() 给退出码
function reporter(title) {
  const res = [];
  return {
    check(name, ok, detail) { res.push(!!ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')); },
    finish() { const bad = res.filter(x => !x).length; console.log('\n' + title + ': ' + (res.length - bad) + '/' + res.length + ' 通过'); return bad ? 1 : 0; },
  };
}
// 工具缺失时以 77 退出（run.sh 把它算作「跳过」）
function main(fn) {
  fn().then(code => process.exit(code || 0), e => {
    if (e && e.code === 'EC_NO_TOOL') { console.log('SKIP ' + e.message); process.exit(77); }
    console.error('测试崩溃', e); process.exit(2);
  });
}
module.exports = { ROOT, PASS, startServer, launch, openGame, enter, sleep, gameWait, frames, pickClass, get, reporter, main, findModule };
