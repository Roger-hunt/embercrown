'use strict';
// CPU profile + render statistics of the real client (real WebGL rendering through SwiftShader).
// usage: node prof.js <dir> <sp|mp> [seconds] [label]
const { startServer, launch, openGame, sleep, gameWait, frames, pickClass } = require('../lib');
(async () => {
  const mode = process.argv[3] || 'sp', secs = +(process.argv[4] || 6);   // 用法：node tests/tools/profile.js - <sp|mp> [秒]
  const srv = await startServer(3987, { BOT_FILL: '8' });
  const browser = await launch();
  try {
    const { ctx, page, errors } = await openGame(browser, srv.url, { render: true, context: { viewport: { width: 960, height: 540 } } });
    const sceneStats = () => page.evaluate(() => {
      const a = window.__arena, info = a.info;
      return { calls: info.render.calls, tris: info.render.triangles, geoms: info.memory.geometries, tex: info.memory.textures, programs: info.programs ? info.programs.length : -1 };
    });
    console.log('menu      ', JSON.stringify(await sceneStats()));
    if (mode === 'sp') {
      await pickClass(page, 'mage');
      await page.click('#btnStart');
      await page.waitForFunction(() => window.__arena.game.state === 'playing');
      // make the scene busy and keep the hero alive: spawn a typical late-wave crowd
      await page.evaluate(() => { const a = window.__arena; a.player.maxHp = a.player.hp = 1e9; a.game.wave = 8; a.game.waveHp = 30; });
      await gameWait(page, 3);
      await page.evaluate(() => { const a = window.__arena; const kinds = ['goblin', 'slime', 'skeleton', 'orc', 'cultist']; for (let i = 0; i < 18; i++) { const ang = i / 18 * Math.PI * 2; a.spawnEnemy(kinds[i % kinds.length], Math.sin(ang) * 9, Math.cos(ang) * 9); } });
      await page.keyboard.down('Digit1');
    } else {
      await pickClass(page, 'mage');
      await page.click('#btnOnline'); await page.click('#btnOpenCreate');
      await page.evaluate(() => { document.getElementById('inBots').value = '7'; });
      await page.click('#btnCreateGo'); await page.click('#btnDiffGo');
      await page.waitForFunction(() => window.__arena.game.state === 'mp' && window.__arena.net.me, null, { timeout: 10000 });
      await sleep(4000);
      await page.keyboard.down('Digit1');
    }
    await sleep(1500);
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    const f0 = await page.evaluate(() => { window.__ft = []; let last = performance.now(); (function tick() { const n = performance.now(); window.__ft.push(n - last); last = n; requestAnimationFrame(tick); })(); return window.__arena.info.render.frame; });
    await cdp.send('Profiler.start');
    await sleep(secs * 1000);
    const { profile } = await cdp.send('Profiler.stop');
    const f1 = await page.evaluate(() => window.__arena.info.render.frame);
    const ft = await page.evaluate(() => window.__ft.slice(5));
    console.log('in-game   ', JSON.stringify(await sceneStats()), '| frames in', secs + 's:', f1 - f0, '| frame ms avg', (ft.reduce((a, b) => a + b, 0) / ft.length).toFixed(1), 'p95', ft.slice().sort((a, b) => a - b)[Math.floor(ft.length * 0.95)].toFixed(1));
    const objs = await page.evaluate(() => {
      // count scene objects through the camera's parent chain is not possible; use a probe mesh trick: find scene via any object attached to it
      const a = window.__arena; let scene = null;
      const probe = a.cam; scene = probe.parent;
      if (!scene) { // camera is not in the scene graph: locate the scene through the player / net entity root
        const r = a.player ? a.player.root : (a.net.me ? a.net.me.root : null); let o = r; while (o && o.parent) o = o.parent; scene = o; }
      if (!scene) return null;
      let meshes = 0, vis = 0, cast = 0, recv = 0, groups = 0, auto = 0, inst = 0; const mats = new Set(), geos = new Set(); let top = scene.children.length;
      scene.traverse(o => { if (o.isMesh) { meshes++; if (o.castShadow) cast++; if (o.receiveShadow) recv++; mats.add(o.material); geos.add(o.geometry); if (o.isInstancedMesh) inst++; } else groups++; if (o.matrixAutoUpdate) auto++; });
      scene.traverseVisible(o => { if (o.isMesh) vis++; });
      return { topLevel: top, meshes, visibleMeshes: vis, castShadow: cast, receiveShadow: recv, nonMesh: groups, matrixAutoUpdate: auto, materials: mats.size, geometries: geos.size, instanced: inst };
    });
    console.log('scene     ', JSON.stringify(objs));
    // aggregate self time by function
    const total = profile.endTime - profile.startTime, byId = new Map(profile.nodes.map(n => [n.id, n])), self = new Map();
    const dt = profile.timeDeltas, samples = profile.samples;
    for (let i = 0; i < samples.length; i++) { const n = byId.get(samples[i]); const cf = n.callFrame; const key = (cf.functionName || '(anonymous)') + ' ' + (cf.url.includes('three.min') ? '[three]' : cf.url ? '[game:' + (cf.lineNumber + 1) + ']' : '[native]'); self.set(key, (self.get(key) || 0) + dt[i]); }
    const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
    const frameCount = Math.max(1, f1 - f0);
    console.log('profile total ' + (total / 1000).toFixed(0) + ' ms over ' + frameCount + ' frames; top self-time (ms/frame):');
    for (const [k, v] of rows.slice(0, 34)) console.log('  ' + (v / 1000 / frameCount).toFixed(3).padStart(8) + '  ' + (v / total * 100).toFixed(1).padStart(5) + '%  ' + k);
    let game = 0, three = 0, idle = 0, gc = 0, prog = 0;
    for (const [k, v] of rows) { if (k.startsWith('(idle)')) idle += v; else if (k.startsWith('(garbage')) gc += v; else if (k.startsWith('(program)')) prog += v; else if (k.includes('[three]')) three += v; else if (k.includes('[game')) game += v; }
    console.log('per frame ms: game-js ' + (game / 1000 / frameCount).toFixed(2) + ' | three.js ' + (three / 1000 / frameCount).toFixed(2) + ' | gc ' + (gc / 1000 / frameCount).toFixed(2) + ' | (program/native) ' + (prog / 1000 / frameCount).toFixed(2) + ' | idle ' + (idle / 1000 / frameCount).toFixed(2));
    console.log('errors:', errors.length ? errors.slice(0, 3) : 'none');
    await ctx.close();
  } finally { await browser.close(); await srv.stop(); }
})().catch(e => { console.error('PROF FAILED', e); process.exit(1); });
