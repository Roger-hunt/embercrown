# 素材与第三方组件声明 · Credits & Third-Party Notices

适用版本：`v1.7.0patch2` 及之后 · 最后更新：2026-11-20

本项目（烬冠竞技场 / Embercrown Arena）的代码为原创，采用 MIT 许可证（`LICENSE`，
Copyright (c) 2026 Roger-hunt@github）；**高画质模型与整套音效来自第三方免费素材包**。
本文逐包、逐文件列出作者、许可证与落地位置，供分发（在线版 / 单机离线包 / GitHub Release）时随附。

> 一句话结论：**模型全部 CC0，音效除「Spell Sounds Starter Pack」外均为 CC0；该音效包是 CC-BY-SA 3.0，
> 必须署名并以同协议提供其派生音频文件**（详见第五节）。游戏本体代码的许可不受影响。

---

## 一、总览

| 类别 | 素材包 | 作者 | 许可证 | 是否必须署名 | 落地位置 |
|---|---|---|---|---|---|
| 角色模型 | KayKit Adventurers 2.0 | Kay Lousberg | CC0 1.0 | 否（致谢） | `public/assets/models/` |
| 角色模型 | KayKit Skeletons 1.1 | Kay Lousberg | CC0 1.0 | 否（致谢） | `public/assets/models/` |
| 武器/道具 | KayKit Fantasy Weapons Bits 1.0 | Kay Lousberg | CC0 1.0 | 否（致谢） | `public/assets/models/` |
| 怪物模型 | Ultimate Monsters | Quaternius | CC0 1.0 | 否（致谢） | `public/assets/models/` |
| 音效 | Kenney RPG Audio / Impact Sounds / Interface Sounds / Music Jingles | Kenney Vleugels | CC0 1.0 | 否（致谢） | `public/assets/sfx/` |
| 音效 | Spell Sounds Starter Pack | p0ss (OpenGameArt) | **CC-BY-SA 3.0**／GPL 2.0／GPL 3.0 | **是** | `public/assets/sfx/` |
| 运行时库 | three.js r128 | Three.js Authors | MIT | 是（保留版权声明） | `public/vendor/three.min.js` |
| 运行时库 | gltf-lite.js | 本项目自研 | 同项目 | — | `public/vendor/gltf-lite.js` |

许可证原文见 `third_party/licenses/`。

---

## 二、3D 模型（高画质档）

全部模型经 `scripts/build-assets.py` 从 `AssetsFree/*.zip` 抽取、`.gltf` + `.bin` + `.png` 合并为自包含 `.glb`，
并在运行时做统一缩放、骨骼姿态修正与材质替换（`MeshToonMaterial`）。几何与贴图未做重制，仅格式转换与引擎适配。

### 2.1 KayKit Adventurers 2.0 — Kay Lousberg（CC0 1.0）

- 来源：<https://www.kaylousberg.com>（itch.io: KayKit）
- 落地：`Knight.glb` `Ranger.glb` `Mage.glb` `Rogue.glb` `Rogue_Hooded.glb` `Barbarian.glb`
- 同包道具：`sword_1handed.glb` `sword_2handed_color.glb` `shield_badge_color.glb` `shield_spikes_color.glb`
  `bow_withString.glb` `staff.glb` `dagger.glb` `spellbook_open.glb` `axe_2handed.glb`

### 2.2 KayKit Skeletons 1.1 — Kay Lousberg（CC0 1.0）

- 落地：`Skeleton_Minion.glb` `Skeleton_Rogue.glb` `Skeleton_Mage.glb` `Skeleton_Warrior.glb` `Skeleton_Staff.glb`

### 2.3 KayKit Fantasy Weapons Bits 1.0 — Kay Lousberg（CC0 1.0）

- 落地：`hammer_C.glb` `spear_A.glb`

### 2.4 Ultimate Monsters — Quaternius（CC0 1.0）

- 来源：<https://www.patreon.com/quaternius>（quaternius.com 免费包）
- 落地：`UM_Alien.glb` `UM_Chicken.glb` `UM_Fish.glb` `UM_Ghost_Skull.glb` `UM_GreenBlob.glb` `UM_Orc.glb` `UM_Yeti.glb`

---

## 三、音效

处理方式：Kenney 原生 OGG 直接取用；Spell Sounds 包内实为 RIFF/WAV（后缀标成 `.ogg`）的片段，
由 `scripts/build-assets.py` 去首尾静音、按上限截断 + 淡入淡出、峰值归一化，转码为单声道 AAC 64 kbps `.m4a`。

### 3.1 Spell Sounds Starter Pack — p0ss（CC-BY-SA 3.0）

- 来源：<https://opengameart.org/content/spell-sounds-starter-pack>（2011-03-03）
- 许可证：CC-BY-SA 3.0（同时标注 GPL 3.0 / GPL 2.0）
- **署名：p0ss，OpenGameArt.org，CC-BY-SA 3.0**

| 项目内文件 | 包内原始文件 | 用途 |
|---|---|---|
| `swing.m4a` | `forcepush-old1.ogg` | 挥砍 |
| `cleave.m4a` | `forcepulse.ogg` | 重击 |
| `volley.m4a` | `forcepush-old1.ogg` | 齐射 |
| `dash.m4a` | `forcepulse.ogg` | 冲刺 |
| `fire.m4a` | `shot2.ogg` | 火球 |
| `inferno.m4a` | `flamethrower.ogg` | 烈焰 |
| `meteor.m4a` | `explode1.ogg` | 陨石 |
| `boom.m4a` | `explode2.ogg` | 爆炸 |
| `freeze.m4a` | `freeze2.ogg` | 冰霜 |
| `storm.m4a` | `wind2.ogg` | 风暴 |
| `wall.m4a` | `magicshield.ogg` | 护盾墙 |
| `cast.m4a` | `spell.ogg` | 施法 |
| `blink.m4a` | `teleport.ogg` | 闪烁 |
| `shoot.m4a` | `shot.ogg` | 远程射击 |
| `boon.m4a` | `blessing3.ogg` | 祝福 |
| `pickup.m4a` | `heal.ogg` | 拾取/治疗 |
| `box.m4a` | `enchant.ogg` | 宝箱 |
| `curse.m4a` | `curse4.ogg` | 诅咒 |
| `confusion.m4a` | `confusion.ogg` | 混乱 |
| `dead.m4a` | `magicfail2.ogg` | 阵亡 |
| `horn.m4a` | `entrance.ogg` | 首领登场 |
| `cheer.m4a` | `cheer-crowd.ogg` | 观众欢呼 |

### 3.2 Kenney 音效包 — Kenney Vleugels（CC0 1.0）
- 来源：<https://kenney.nl>（CC0 1.0）

| 项目内文件 | 来源包 | 包内路径 |
|---|---|---|
| `door.ogg` | RPG Audio | `Audio/doorOpen_1.ogg` |
| `hit.ogg` | Impact Sounds | `Audio/impactPlate_medium_000.ogg` |
| `thud.ogg` | Impact Sounds | `Audio/impactSoft_heavy_000.ogg` |
| `hurt.ogg` | Impact Sounds | `Audio/impactPunch_heavy_001.ogg` |
| `ui.ogg` | Interface Sounds | `Audio/click_002.ogg` |
| `fb.ogg` | Music Jingles | `Audio/Steel jingles/jingles_STEEL00.ogg` |
| `streak.ogg` | Music Jingles | `Audio/Steel jingles/jingles_STEEL02.ogg` |
| `shutdown.ogg` | Music Jingles | `Audio/Hit jingles/jingles_HIT04.ogg` |

代码内另有大量程序化音效（Web Audio 振荡器实时合成，如各类命中/暴击/连杀提示），属本项目原创，不含第三方素材。

### 3.3 项目自制语音（TTS）

`public/godlike.mp3`（「神级」播报）与 `public/greta_yell.mp3`（首领「黑暗骑士」格雷塔台词）由作者使用 TTS 合成后剪辑而成，
**属本项目原创，不含第三方录音素材**，随项目按 MIT 许可分发。

---

## 四、运行时代码

| 文件 | 组件 | 许可证 | 说明 |
|---|---|---|---|
| `public/vendor/three.min.js` | three.js **r128** | MIT，Copyright 2010-2021 Three.js Authors | 文件头保留原始 `@license` 与 SPDX 标识，未修改 |
| `public/vendor/gltf-lite.js` | 轻量 GLB 加载 / 蒙皮网格克隆 | 本项目原创 | 为零依赖自研实现，非 three.js 官方 `GLTFLoader` 拷贝 |

---

## 五、署名与合规要点

1. **CC0 素材（KayKit、Quaternius、Kenney）**：法律上无署名义务，本项目仍在此致谢。
   若二次分发或改作他用，可直接沿用 CC0 条款，无需再向本项目申请。
2. **Spell Sounds Starter Pack 为 CC-BY-SA 3.0，不是 CC0**，这是全套素材里唯一的「有义务」项：
   - 必须**署名** `p0ss`（OpenGameArt.org）并给出版本/链接；
   - 由其派生的音频（即上表 22 个 `.m4a`：裁剪、淡出、归一化、转码后仍属改编）**须以 CC-BY-SA 3.0 提供**；
   - 该义务只覆盖这些音频文件本身，**不传染**游戏其余代码与资源（本项目按「汇编/合集」使用，
     游戏整体许可不因此改变）；但因为音频本身以 CC-BY-SA 分发，接收方再分发这些音频时需同样署名并保持同协议。
3. **该包已确认保留**（作者定调：音色最贴合奇幻施法手感，按现行署名 + CC-BY-SA 3.0 提供）。
   若后续想回到「全项目素材零署名义务」，把这 22 个音效换为 Kenney / freesound CC0 素材并删除本节 3.1 即可。
4. **分发要求**：在线版页面底部/「关于」、单机离线包与 GitHub Release 附件中均需能查到本文
   （单机包已随包附带 `CREDITS.md` 与 `third_party/licenses/`）。

---

## 六、未使用 / 未随包分发的素材

以下包已下载评估但**未进入 `public/`，也不随任何产物分发**，故不构成分发义务：

- KayKit Dungeon Pack 1.1（CC0）、KayKit Forest Nature Pack 1.0（CC0）
- KayKit Medieval Hexagon Pack 1.0（CC0）、KayKit RPGTools Bits 1.0（CC0）
- `西式奇幻巨龙.glb`（来源与许可证待确认，当前**未被任何代码引用**，请勿直接分发）

---

## 七、待补齐项

| 项 | 现状 | 处理建议 |
|---|---|---|
| 在线版「关于」面板 | 目前只链到 GitHub 仓库，未单列素材署名 | 恢复发版时在「关于」加一行指向 `CREDITS.md` 的链接 |
| 高画质分层（`HQ_CFG`） | 仍在开发，未上线 | 上线前若新增素材，须在此追加登记 |
| 高画质分层（`HQ_CFG`） | 仍在开发，未上线 | 上线前若新增素材，须在此追加登记 |

---

## English Summary

Embercrown Arena ships third-party free assets. **Models** (KayKit Adventurers 2.0, KayKit Skeletons 1.1,
KayKit Fantasy Weapons Bits 1.0 — by Kay Lousberg, <https://www.kaylousberg.com>; Ultimate Monsters by Quaternius,
<https://www.patreon.com/quaternius>) are **CC0 1.0**. **Kenney** audio packs (RPG Audio, Impact Sounds,
Interface Sounds, Music Jingles — Kenney Vleugels, <https://kenney.nl>) are **CC0 1.0**.

The spell SFX derive from the **Spell Sounds Starter Pack by p0ss**
(<https://opengameart.org/content/spell-sounds-starter-pack>), licensed **CC-BY-SA 3.0**.
Those 22 converted `public/assets/sfx/*.m4a` files are derivative works and are distributed under
**CC-BY-SA 3.0** with attribution to p0ss; the rest of the project is unaffected.
Full license texts: `third_party/licenses/`.

`three.js` r128 is MIT (Copyright 2010-2021 Three.js Authors); `gltf-lite.js` is original code of this project.
