'use strict';
// 烬冠竞技场 — PvP 核心战斗参数单一事实源
// 被 server.js 直接 require，并由 scripts/build.mjs 注入 public/index.html (P2PHost)

const ROLL = { cd: 2.8, dur: 0.26, sp: 22, inv: 0.34 };
const CHARGE = { dur: 0.28, sp: 30, maxDist: 18, maxGap: 20 };
const MOVE = {
  knight: { k: 'charge', cd: 5 },
  ranger: { k: 'roll', cd: ROLL.cd },
  mage:   { k: 'blink', cd: 6.5, dist: 7.2 },
};
const CLS_IDS = ['knight', 'ranger', 'mage'];
const CLS = {
  knight: { hp: 215, speed: 6.8, atkCd: 0.41, armor: 0.74, q: 2.2, e: 14.0, u: 20, cast: 0, range: 3.4, res: 'rage', cost: [0, 18, 0, 35] },
  ranger: { hp: 140, speed: 7.1, atkCd: 0.37, armor: 0.90, q: 6.5, e: 8.5, u: 21, cast: 1.05, range: 19, res: 'energy', cost: [0, 25, 30, 45] },
  mage:   { hp: 136, speed: 6.6, atkCd: 0.46, armor: 0.90, q: 7.5, e: 9.2, u: 24, cast: 1.8, chan: 1, range: 19, res: 'mana', cost: [0, 20, 30, 45] },
};
const RES = {
  rage:   { start: 20, regen: 0, decay: 2, calm: 6.5, hit: 14, hurt: 0.65, charge: 25 },
  energy: { start: 100, regen: 9.0 },
  mana:   { start: 100, regen: 6.5 },
};
const ULT = {
  knight: { k: 'spin', self: 1, dur: 2.4, iv: 0.3, r: 3.4, dmg: 9, zone: { r: 3.4, delay: 0, dmg: 9 } },
  ranger: { k: 'storm', zone: { r: 6, delay: 0.4, ticks: 8, iv: 0.3, dmg: 13, slow: 1.3 } },
  mage:   { k: 'inferno', zone: { r: 6.2, delay: 0.15, ticks: 4, iv: 0.55, dmg: 30, kb: 1.5, slow: 0.9, ramp: [0.55, 0.85, 1.15, 1.45] } },
};
const MAGE_FIRE_DMG = 20;
const MAGE_METEOR_DMG = 64;

module.exports = { ROLL, CHARGE, MOVE, CLS_IDS, CLS, RES, ULT, MAGE_FIRE_DMG, MAGE_METEOR_DMG };
