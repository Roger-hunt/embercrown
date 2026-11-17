[中文](README.md) | **English**

# Embercrown Arena (v1.5.0patch1)

A low-poly stylized 3D Western-fantasy arena ARPG built with **Three.js + Node.js (WebSocket)**, co-developed with **Claude Fable 5.2 + Gemini Argon**.

## Core Gameplay

- **Solo Waves**: Endless arena waves (including **Deep One Scout** and other low-poly monsters) with boss encounters every 5 waves (**Crag Ogre** / **Withered Lich** / **Greta the Dark Knight**), plus pick-1-of-3 blessings between waves.
- **8-Player Online FFA (Standard & Fun Mode)**: 30Hz server-authoritative multiplayer supporting Quick Match, Custom Room Creation (configurable bot count, Easy/Normal/Hard difficulty, Standard / Fun Mode, and 6-digit room password), Active Room List, and 4-character Room Code joining.
  - **Fun Mode**: Spawns random Mystery Crates (random buffs / prank debuffs), 40s timed abilities (💀 Death Grip, 🪃 Boomerang, ⭐ Invincible Star, 🍄 Giant Rage, ⚡ Lightning Overload) with a dim-yellow perimeter progress ring on Slot `4`, and triggerable/throwable items (💣 Time Bomb, 🍌 Banana Peel Trap, 🚀 Rocket Boots). Press `4` to use/throw immediately toward aim, or press `G` / click the corner `×` badge to drop.
- **Three Playable Classes**:
  - **Ironvow Knight** (Melee · Rage): High armor mitigation, Shield Bash stun, Whirlwind lifesteal, target-locking Charge, and Skyfall Blade.
  - **Verdant Ranger** (Ranged · Energy): Piercing arrows, slowing Volley, Arrow Rain, invulnerable Dodge Roll, and Arrow Storm.
  - **Ember Mage** (Caster · Mana): Explosive Fireballs, Frost Nova freeze, Meteor burst, crowd-control-cleansing Blink, and Inferno.
- **Cross-Device Support**: PC keyboard & mouse, iOS/Android landscape fullscreen virtual joystick & radial skill wheel, standard Bluetooth Xbox gamepads, and native **2880×1260 (3K 16:7)** ultra-wide in-car display rendering.
- **Bilingual i18n**: Automatically detects browser language (`zh` / `en`) with manual `中 / EN` switching.

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:3000` (LAN players can connect via the LAN address printed in the server console).

> **Security Note**: Always set a custom `DEMO_PASS` environment variable in public deployments instead of relying on the default passcode.
>
> **HTTPS Reverse Proxy Requirement (Bluetooth Gamepads & Mobile)**: Mobile browsers (iOS Safari, modern Android Chrome / WebView) and in-car browsers restrict the W3C Gamepad API (`navigator.getGamepads()`) to **HTTPS secure contexts**. To use a Bluetooth gamepad on phones or in-car displays, configure an **HTTPS reverse proxy** (e.g. Nginx / Caddy) pointing to `PORT` (default `3000`), forward WebSocket `Upgrade` / `Connection` headers, and set `TRUST_PROXY=1` if needed.

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket server port |
| `DEMO_PASS` | Random | Gate & lobby access passcode (generated randomly & printed at startup if unset) |
| `ADMIN_PORT` | `3001` | Admin telemetry/stats port (`0` to disable) |
| `ADMIN_TOKEN` | Empty (disabled) | Dedicated auth token for admin endpoints (`x-admin-token`, `Bearer`, or `?token=`) |
| `BOT_FILL` | `4` | Target player count filled by AI bots (`0` to disable) |
| `KILL_TARGET` | `15` | Kills required to win an online match |
| `ROUND_TIME` | `240` | Match duration in seconds |

## Controls

- **PC (Keyboard & Mouse)**: `WASD` Move · `Right-Drag` Turn · `1–5` Skills / Mobility (`4` is Ultimate or temporary Fun Mode ability/item) · `G` Drop Fun Mode Item · `Space` Jump · `Tab` / Click Target · `C` Stats · `O` Scoreboard · `Esc` Pause / Cancel
- **Mobile / Touch**: Left virtual stick to move · Right-screen drag to rotate camera / tap enemy to target · Bottom-right radial wheel for attacks, skills, dodge & jump
- **Bluetooth Gamepad (Standard Xbox)**: Automatically hides touch controls and switches to a compact cooldown bar on input: `L Stick` Move · `R Stick` Camera · `X`/`RT` Attack · `Y` Skill 1 · `B` Skill 2 · `RB` Ultimate · `LB` Mobility · `A` Jump · `LT` Cycle Target · `D-Pad ↑` Stats · `View` Scoreboard · `Menu` Pause · (`X` / `Y` / `B` to pick Solo blessings)

## Project Structure

- `server.js`: HTTP static server + `/ws` authoritative multiplayer server (30 tick/s physics, skills, AI bots, Fun Mode crates/items, state sync) + SQLite telemetry
- `public/index.html`: Three.js 3D renderer, Deep One gatehouse login fly-through, procedural low-poly character/boss models, Web Audio synthesized SFX, solo mode & client-side prediction/interpolation, i18n (`zh` / `en`)
- `public/vendor/three.min.js`: Three.js r128 (MIT)
- `public/greta_yell.mp3`, `public/godlike.mp3`: Boss yell & Godlike announcement audio

## Recent Updates (v1.5.0patch1)

- **Multiplayer Neutral Chickens**: Added synced neutral chickens to multiplayer rooms; clickable/gamepad-targetable, hittable by skills/projectiles/Charge, and grant Knight Rage on Charge or Slash hits.
- **Mobile Touch & Auto-Attack Improvements**: Moved Skill 2 to the bottom-right core touch slot and Attack to the outer rim with long-press `AUTO` toggle; Ult enters aiming on press (drag out to cast, quick tap keeps tap-to-cast); Auto Attack triggers only in range and auto-faces locked targets.
- **UI & Gatehouse Polish**: Compacted mobile Mode & Difficulty modal, fixed portrait login rotate hint z-index, framed both Deep One guards, and removed redundant language toggle from the main menu.

### Previous (v1.5.0)

- **PVP Fun Mode**: Added Mystery Crates, 40s timed abilities (Death Grip, Boomerang, Invincible Star, Giant Rage, Lightning Overload) with an outer dim-yellow cooldown border ring on Slot `4`, throwable/triggerable items (Time Bomb, Banana Peel Trap, Rocket Boots), `G` / corner `×` drop, and server-side movement sync.
- **Deep One Login Gatehouse & New Monster**: Added a 3D gatehouse login screen guarded by twin Deep One sentries with asset preloading, door-opening fly-through transition, and the Deep One Scout enemy in Solo waves.
- **Bluetooth Gamepad, i18n & Security**: Full Chinese/English localization (`zh` / `en`), standard Xbox controller support, and separated `DEMO_PASS` / `ADMIN_TOKEN` auth.

## License

Released under the [MIT License](LICENSE).

## Acknowledgments

Thanks to the [linux.do](https://linux.do/) community.
