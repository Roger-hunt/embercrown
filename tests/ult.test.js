'use strict';
// Regression test for "ultimate gets stuck until page reload".
// Presses the ultimate while it is (a) short on resource and (b) on cooldown, in single-player and multiplayer,
// with keyboard key 4 and with a simulated gamepad RB. Passes when rendering keeps running and the player can still move.
const { startServer, launch, openGame, sleep, gameWait, frames, pickClass } = require('./lib');
const results = [];
function check(name, ok, detail) { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : '')); }
const PAD_INIT = () => {
  // fake standard gamepad controllable from the test
  const pad = { id: 'Test Pad (STANDARD GAMEPAD)', index: 0, connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })) };
  window.__pad = pad; window.__padOn = false;
  navigator.getGamepads = () => (window.__padOn ? [pad, null, null, null] : [null, null, null, null]);
  window.__padBtn = (i, down) => { pad.buttons[i] = { pressed: down, touched: down, value: down ? 1 : 0 }; pad.timestamp = performance.now(); };
};
(async () => {
    const srv = await startServer(3987, { BOT_FILL: '0' });
  const browser = await launch();
  const stat = page => page.evaluate(() => { const a = window.__arena, mp = a.game.state === 'mp', p = mp ? a.net.lp : a.player; return { fr: window.__frames, x: p ? p.x : 0, z: p ? p.z : 0, t: a.game.time, aiming: window.__arenaCtl.aiming, err: document.getElementById('errs').textContent }; });
  async function alive(page, label, errors) {
    const n0 = errors.length;
    let s0 = await stat(page), s1 = s0, rendered = 0, moved = 0;
    /* 无头软件渲染在机器有其他负载时，700ms 内可能只出 5—8 帧。掉帧不等于卡死，
       所以给两轮：第一轮够就不重跑（正常情况无额外开销），两轮都出不来才算真卡死。 */
    for (let i = 0; i < 2 && (rendered <= 10 || moved <= 0.8); i++) {
      s0 = await stat(page);
      await page.keyboard.down('KeyW'); await sleep(700); await page.keyboard.up('KeyW');
      s1 = await stat(page);
      rendered = s1.fr - s0.fr; moved = Math.hypot(s1.x - s0.x, s1.z - s0.z);
    }
    const newErr = errors.slice(n0).filter(e => e.startsWith('PAGEERROR'));
    check(label, rendered > 10 && moved > 0.8 && !newErr.length, 'frames rendered=' + rendered + ', moved=' + moved.toFixed(1) + ', hint="' + s1.err + '"' + (newErr.length ? ', page errors=' + newErr.length + ' e.g. ' + newErr[0].slice(0, 110) : ''));
  }
  async function pressUlt(page, how) {
    if (how === 'key') { await page.keyboard.press('Digit4'); }
    else { await page.evaluate(() => { window.__padOn = true; window.__padBtn(5, true); }); await frames(page, 3); await page.evaluate(() => window.__padBtn(5, false)); }
    await frames(page, 4);
  }
  try {
    for (const how of ['key', 'pad']) {
      // ---------- single-player ----------
      {
        const { ctx, page, errors } = await openGame(browser, srv.url, { init: PAD_INIT });
        await pickClass(page, 'knight');
        await page.click('#btnStart');
        await page.waitForFunction(() => window.__arena.game.state === 'playing');
        if (how === 'pad') { await page.evaluate(() => { window.__padOn = true; window.__padBtn(0, true); }); await frames(page, 3); await page.evaluate(() => window.__padBtn(0, false)); await frames(page, 3); }
        await gameWait(page, 0.4);
        await page.evaluate(() => { window.__arena.player.res = 0; });               // (a) not enough rage
        await pressUlt(page, how);
        await alive(page, 'SP ' + how + ': ult with too little resource does not freeze the game', errors);
        await page.evaluate(() => { const p = window.__arena.player; p.res = 100; p.cds.u = p.cdMax.u = 20; });   // (b) on cooldown
        await pressUlt(page, how);
        await alive(page, 'SP ' + how + ': ult on cooldown does not freeze the game', errors);
        await page.evaluate(() => { const p = window.__arena.player; p.res = 100; p.cds.u = 0; });                // (c) ready: instant moving whirlwind on 1st press
        await gameWait(page, 0.3);
        await pressUlt(page, how);
        const aimed = (await stat(page)).aiming;
        const cast = await page.evaluate(() => { const p = window.__arena.player; return { cd: p.cds.u, res: p.res, spin: p.spinUltT }; });
        check('SP ' + how + ': ready knight ult casts immediately on 1st press', !aimed && cast.cd > 10 && cast.spin > 0, 'aiming=' + aimed + ', cooldown=' + cast.cd.toFixed(1) + ', spinUltT=' + cast.spin.toFixed(2));
        await alive(page, 'SP ' + how + ': game still responsive and movable during whirlwind ult', errors);
        await ctx.close();
      }
      // ---------- multiplayer ----------
      {
        const { ctx, page, errors } = await openGame(browser, srv.url, { init: PAD_INIT });
        await pickClass(page, 'knight');                                             // knights spawn with 20 rage, the ult needs 35
        await page.click('#btnOnline'); await page.click('#btnOpenCreate');
        await page.evaluate(() => { document.getElementById('inBots').value = '0'; });
        await page.click('#btnCreateGo'); await page.click('#btnDiffGo');
        await page.waitForFunction(() => window.__arena.game.state === 'mp' && window.__arena.net.me, null, { timeout: 10000 });
        if (how === 'pad') { await page.evaluate(() => { window.__padOn = true; window.__padBtn(0, true); }); await frames(page, 3); await page.evaluate(() => window.__padBtn(0, false)); await frames(page, 3); }
        await gameWait(page, 0.8);
        await pressUlt(page, how);
        await alive(page, 'MP ' + how + ': ult with too little rage does not freeze the game', errors);
        await ctx.close();
      }
      {
        const { ctx, page, errors } = await openGame(browser, srv.url, { init: PAD_INIT });
        await pickClass(page, 'mage');
        await page.click('#btnOnline'); await page.click('#btnOpenCreate');
        await page.evaluate(() => { document.getElementById('inBots').value = '0'; });
        await page.click('#btnCreateGo'); await page.click('#btnDiffGo');
        await page.waitForFunction(() => window.__arena.game.state === 'mp' && window.__arena.net.me, null, { timeout: 10000 });
        if (how === 'pad') { await page.evaluate(() => { window.__padOn = true; window.__padBtn(0, true); }); await frames(page, 3); await page.evaluate(() => window.__padBtn(0, false)); await frames(page, 3); }
        await gameWait(page, 0.8);
        await pressUlt(page, how); const aimed = (await stat(page)).aiming;
        await pressUlt(page, how); await gameWait(page, 2.2);
        const cd = await page.evaluate(() => window.__arena.net.cd[3]);
        check('MP ' + how + ': ready ult aims on 1st press and casts on 2nd', aimed && cd > 10, 'aiming after 1st=' + aimed + ', server cooldown=' + cd);
        await gameWait(page, 0.9);
        const barHidden = await page.evaluate(() => document.getElementById('castBar').hidden);
        check('MP ' + how + ': channel castBar hides after completion', barHidden, 'hidden=' + barHidden);
        if (how === 'pad') {
          const pos = await page.evaluate(() => {
            document.body.classList.add('touch');
            const p = getComputedStyle(document.getElementById('castBar')).position;
            document.body.classList.remove('touch');
            return p;
          });
          check('MP pad: body.pad.touch #castBar stays position:relative', pos === 'relative', 'position=' + pos);
        }
        await pressUlt(page, how);                                                   // now on cooldown
        await alive(page, 'MP ' + how + ': ult on cooldown does not freeze the game', errors);
        await ctx.close();
      }
    }
  } finally { await browser.close(); await srv.stop(); }
  const failed = results.filter(r => !r.ok).length;
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { if (e && e.code === 'EC_NO_TOOL') { console.log('SKIP ' + e.message); process.exit(77); } console.error('测试崩溃', e); process.exit(2); });
