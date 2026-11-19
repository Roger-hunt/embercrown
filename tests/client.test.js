'use strict';
const { startServer, launch, openGame, enter, sleep, gameWait, frames, pickClass } = require('./lib');
const audioInit = require('./audio-init');
let fail = 0; const check = (n, ok, d) => { if (!ok) fail++; console.log((ok ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };
(async () => {
  const srv = await startServer(3987, { BOT_FILL: '0' });
  const browser = await launch();
  try {
    // --- gate message in English, wrong passcode
    { const { ctx, page } = await openGame(browser, srv.url, { gate: false, context: { locale: 'en-US' } });
      await page.evaluate(() => { try { localStorage.setItem('ec_lang', 'en'); } catch (e) {} }); await page.reload();
      await page.fill('#inPass', 'nope'); await page.click('#btnGate'); await sleep(600);
      const msg = await page.textContent('#gateErr'); check('English UI shows English wrong-passcode message', /Wrong passcode/.test(msg), msg); await ctx.close(); }
    // --- audio + crowd in multiplayer
    const { ctx, page, errors } = await openGame(browser, srv.url, { init: audioInit });
    await pickClass(page, 'mage');
    await page.click('#btnOnline'); await page.click('#btnOpenCreate');
    await page.evaluate(() => { document.getElementById('inBots').value = '2'; });
    await page.click('#btnCreateGo'); await page.click('#btnDiffGo');
    await page.waitForFunction(() => window.__arena.game.state === 'mp' && window.__arena.net.me && window.__arena.net.ents.size >= 3, null, { timeout: 15000 });
    await page.evaluate(() => { const n = window.__arena.net, h = n.ws.onmessage; n.ws.onmessage = ev => { try { const m = JSON.parse(ev.data); if (m.t === 's') window.__lastS = m; } catch (e) {} if (!window.__hold) h(ev); }; window.__inject = evs => { const m = JSON.parse(JSON.stringify(window.__lastS)); m.w.ev = evs; m.ack = 0; h({ data: JSON.stringify(m) }); }; });
    await sleep(1500);
    const ids = await page.evaluate(() => { const n = window.__arena.net; return { me: n.id, o: [...n.ents.keys()].filter(i => i !== n.id) }; });
    await page.evaluate(() => { window.__hold = true; }); await sleep(1800);
    const run = async ev => { await page.evaluate(() => { window.__audio.starts.length = 0; }); const m = page.evaluate(() => window.__measure(1800)); await page.evaluate(e => window.__inject([e]), ev); const r = await m; r.voice = (await page.evaluate(() => window.__audio.starts)).filter(s => s.k === 'buf' && !s.loop).map(s => s.dur); await sleep(700); return r; };
    const plain = await run({ e: 'kill', id: ids.o[0], by: ids.me });
    const god = await run({ e: 'kill', id: ids.o[0], by: ids.me, st: 7 });
    const godOther = await run({ e: 'kill', id: ids.o[1], by: ids.o[0], st: 7 });
    check('godlike plays a decoded voice clip', god.voice.length === 1 && god.voice[0] > 1, 'voice buffers ' + JSON.stringify(god.voice));
    check('godlike is much louder than a plain kill', god.rms > plain.rms * 3, 'rms plain ' + plain.rms + ' vs godlike ' + god.rms + ' (peak ' + god.peak + ')');
    check('godlike by another player is just as loud', godOther.rms > god.rms * 0.8 && godOther.voice.length === 1, 'rms ' + godOther.rms);
    check('output does not clip', god.peak < 1, 'peak ' + god.peak);
    // boss voice through Web Audio, triggered outside any user gesture
    await page.evaluate(() => { window.__audio.starts.length = 0; window.__audio.plays.length = 0; });
    const mm = page.evaluate(() => window.__measure(2500));
    await page.evaluate(() => setTimeout(() => window.__playVoiceTest && window.__playVoiceTest(), 0));
    await mm;
    // crowd toggle
    const crowd = () => page.evaluate(() => { let v = 0, n = 0; window.__lastScene.traverse(o => { if (o.isInstancedMesh && o.count > 100 && o.count < 600) { n++; if (o.visible) v++; } }); return v + '/' + n; });
    await page.evaluate(() => { window.__hold = false; }); await page.keyboard.press('Escape'); await sleep(400);
    const before = await crowd(); await page.click('#btnCrowd'); await frames(page, 3); const off = await crowd();
    const label = await page.textContent('#btnCrowd span');
    check('crowd switch hides the crowd', before === '2/2' && off === '0/2', before + ' -> ' + off + ', label "' + label + '"');
    await page.reload(); await enter(page); await frames(page, 3);          // 已登录：不再出现口令页，只过登录加载页
    check('crowd setting and login survive a reload', (await crowd()) === '0/2', await crowd());
    await page.evaluate(() => { try { localStorage.removeItem('ec_crowd'); } catch (e) {} });
    check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
    await ctx.close();
    // --- boss voice in single-player: real bossYell path via the black knight
    { const { ctx, page, errors } = await openGame(browser, srv.url, { init: audioInit });
      await pickClass(page, 'knight'); await page.click('#btnStart');
      await page.waitForFunction(() => window.__arena.game.state === 'playing');
      await page.evaluate(() => { const a = window.__arena; a.player.maxHp = a.player.hp = 1e9; });
      const w = await page.evaluate(() => window.__arena.game.wave);
      check('single-player starts at wave 1 (debug jump off)', w === 1, 'wave ' + w);
      await sleep(1500);
      await page.evaluate(() => { window.__audio.starts.length = 0; window.__audio.plays.length = 0; const a = window.__arena; a.game.spawnQ.length = 0; a.spawnEnemy('blackKnight', 0, 20); });
      await gameWait(page, 6);
      const st = await page.evaluate(() => ({ bufs: window.__audio.starts.filter(s => s.k === 'buf' && !s.loop && s.dur > 4).length, el: window.__audio.plays.length }));
      check('boss voice plays through Web Audio, not <audio>.play()', st.bufs === 1 && st.el === 0, JSON.stringify(st));
      check('no page errors (boss)', errors.length === 0, errors.slice(0, 2).join(' | ')); await ctx.close(); }
  } finally { await browser.close(); await srv.stop(); }
  console.log(fail ? fail + ' FAILED' : 'ALL PASSED'); process.exit(fail ? 1 : 0);
})().catch(e => { if (e && e.code === 'EC_NO_TOOL') { console.log('SKIP ' + e.message); process.exit(77); } console.error('测试崩溃', e); process.exit(2); });
