[中文](README.md) | **English**

# Embercrown Arena

A low-poly stylized 3D Western-fantasy arena ARPG built with **Three.js + Node.js (WebSocket)**, co-developed with **Claude Fable 5.2 + Gemini Argon**.

## Core Gameplay

- **Solo Waves**: Endless arena waves with boss encounters every 5 waves (**Crag Ogre** / **Withered Lich** / **Dark Knight**), plus pick-1-of-3 blessings between waves.
- **8-Player Online FFA**: 30Hz server-authoritative multiplayer supporting Quick Match, Custom Room Creation (configurable bot count & Easy/Normal/Hard difficulty), Active Room List, and 4-character Room Code joining.
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
| `DEMO_PASS` | `changeme` | Gate & lobby access passcode (**change for public deployments**) |
| `ADMIN_PORT` | `3001` | Admin telemetry/stats port (`0` to disable) |
| `ADMIN_TOKEN` | Empty (disabled) | Dedicated auth token for admin endpoints (`x-admin-token`, `Bearer`, or `?token=`) |
| `BOT_FILL` | `4` | Target player count filled by AI bots (`0` to disable) |
| `KILL_TARGET` | `15` | Kills required to win an online match |
| `ROUND_TIME` | `240` | Match duration in seconds |

## Controls

- **PC (Keyboard & Mouse)**: `WASD` Move · `Right-Drag` Turn · `1–5` Skills / Mobility · `Space` Jump · `Tab` / Click Target · `C` Stats · `O` Scoreboard · `Esc` Pause / Cancel
- **Mobile / Touch**: Left virtual stick to move · Right-screen drag to rotate camera / tap enemy to target · Bottom-right radial wheel for attacks, skills, dodge & jump
- **Bluetooth Gamepad (Standard Xbox)**: Automatically hides touch controls and switches to a compact cooldown bar on input: `L Stick` Move · `R Stick` Camera · `X`/`RT` Attack · `Y` Skill 1 · `B` Skill 2 · `RB` Ultimate · `LB` Mobility · `A` Jump · `LT` Cycle Target · `D-Pad ↑` Stats · `View` Scoreboard · `Menu` Pause · (`X` / `Y` / `B` to pick Solo blessings)

## Project Structure

- `server.js`: HTTP static server + `/ws` authoritative multiplayer server (30 tick/s physics, skills, AI bots, state sync) + SQLite telemetry
- `public/index.html`: Three.js 3D renderer, procedural low-poly character/boss models, Web Audio synthesized SFX, solo mode & client-side prediction/interpolation, i18n (`zh` / `en`)
- `public/vendor/three.min.js`: Three.js r128 (MIT)

## Recent Updates

- **i18n & Auto Language Detection**: Added full Chinese/English UI & skill localization (`zh` / `en`) with browser auto-detection and `中 / EN` toggle, plus English documentation ([README_EN.md](README_EN.md)).
- **Bluetooth Gamepad Support**: Added standard Xbox gamepad controls, multi-device input priority, automatic hiding of touch controls, pause-menu button guide, and `X`/`Y`/`B` blessing selection in Solo mode.
- **Combat Feedback & Audio**: Added First Blood, Multi-Kill, Godlike, and Shut Down synthesized fanfares; fixed full-viewport hit-flash edge coverage.
- **Security Separation**: Separated `DEMO_PASS` entry passcode from `ADMIN_TOKEN` admin telemetry authentication.

## License

Released under the [MIT License](LICENSE).
