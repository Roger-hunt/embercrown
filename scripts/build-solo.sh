#!/usr/bin/env bash
# 打包「单机离线版」ZIP（双击 index.html 即玩单人无尽波次，无需 Node 服务器）。
#
#   bash scripts/build-solo.sh v1.5.0patch2
#   SOLO_SRC=/path/to/public bash scripts/build-solo.sh v1.5.0patch2   # 指定源目录
#
# 源目录默认取 cf 的 public/（含 REALMS 与 P2PHost，使单机版也能直连配置的服务器与 CF P2P）。
# 产物落在 <repo>/dist/<NAME>.zip，目录结构与历史 release 保持一致。
set -euo pipefail

VER="${1:-${VER:-}}"
if [ -z "$VER" ]; then
  echo "用法: bash scripts/build-solo.sh v1.5.0patch2" >&2
  exit 2
fi
VER="${VER#v}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${SOLO_SRC:-$REPO/public}"
CF_ORIGIN="${SOLO_CF_ORIGIN:-https://game.needcoffee.icu}"
OUT_DIR="$REPO/dist"
NAME="embercrown-solo-v$VER"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

[ -d "$SRC" ] || { echo "源目录不存在: $SRC" >&2; exit 1; }
for f in index.html vendor/three.min.js greta_yell.mp3 godlike.mp3; do
  [ -f "$SRC/$f" ] || { echo "缺少文件: $SRC/$f" >&2; exit 1; }
done

# 硬前提：版本串必须已经 bump，避免打出旧版本号的面板
if ! grep -q "版本 v$VER" "$SRC/index.html"; then
  echo "错误: $SRC/index.html 里没有「版本 v${VER}」，先把版本号改好再打包" >&2
  exit 1
fi

DEST="$STAGE/$NAME"
mkdir -p "$DEST/vendor"
# 单机包不带遥测：剥掉 tp 模块 / 调用点 / 关于弹窗里的「数据与隐私」tab
python3 "$REPO/scripts/strip-telemetry.py" "$SRC/index.html" "$DEST/index.html"
# 若源页面带口令门（demoToken = ''），单机离线包自动改为免口令初始值（'offline'）
python3 - "$DEST/index.html" <<'PY'
import sys, re
p = sys.argv[1]
with open(p, 'r', encoding='utf-8') as f:
    s = f.read()
s = re.sub(r"\bdemoToken = ''", "demoToken = 'offline'", s, count=1)
with open(p, 'w', encoding='utf-8') as f:
    f.write(s)
PY
# 硬前提：剥完必须没有 telemetry 端点引用，且保留 APP_VER / probeVersion / inpMode
if grep -q "telemetry/" "$DEST/index.html"; then
  echo "错误: 剥完仍残留 telemetry/ 引用" >&2
  exit 1
fi
for sym in "const APP_VER" "function probeVersion" "function inpMode"; do
  if ! grep -q "$sym" "$DEST/index.html"; then
    echo "错误: 剥离误删了必需符号: $sym" >&2
    exit 1
  fi
done
# 若存在 cf_p2p 配置则注入绝对域名，使 file:// 打开的包可直连 CF P2P；纯开源版无此段则跳过
python3 - "$DEST/index.html" "$CF_ORIGIN" <<'PY'
import sys, re
path, cf_origin = sys.argv[1], sys.argv[2].rstrip('/')
with open(path, 'r', encoding='utf-8') as f:
    s = f.read()
pat = r"(id:\s*'cf_p2p'[\s\S]*?origin:\s*)''"
out, n = re.subn(pat, rf"\1'{cf_origin}'", s, count=1)
if n == 1:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(out)
PY
cp "$SRC/vendor/three.min.js" "$DEST/vendor/three.min.js"
[ -f "$SRC/vendor/gltf-lite.js" ] && cp "$SRC/vendor/gltf-lite.js" "$DEST/vendor/gltf-lite.js"
[ -d "$SRC/assets" ] && cp -R "$SRC/assets" "$DEST/assets"
cp "$SRC/greta_yell.mp3" "$DEST/greta_yell.mp3"
cp "$SRC/godlike.mp3" "$DEST/godlike.mp3"
# 素材声明：音效含 CC-BY-SA 3.0 素材，分发时必须随包附带署名与许可证原文
cp "$REPO/LICENSE" "$DEST/LICENSE"
cp "$REPO/CREDITS.md" "$DEST/CREDITS.md"
if [ -d "$REPO/third_party/licenses" ]; then
  cp -R "$REPO/third_party/licenses" "$DEST/licenses"
fi

cat > "$DEST/README.txt" <<EOF
烬冠竞技场 (Embercrown Arena) v$VER · 单机离线版
============================================================

启动方式：
1. 完整解压本压缩包（保持 index.html、vendor/、*.mp3 在同一目录）。
2. 直接使用现代浏览器（Chrome / Edge / Safari / Firefox）双击打开 index.html 即可游玩单人无尽波次模式。
3. 如需完整音频解码或蓝牙手柄支持，可通过任意静态 HTTP/HTTPS 服务（例如 python3 -m http.server）访问。

操作说明：
- WASD 移动（A/D 左右平移）· 右键拖动转向 · 空格跳跃 · Tab 选目标 · C 属性 · Esc 菜单
- 1-5 技能；轻点 1 切换自动普攻（PC 默认开启），按住 1 照常普攻
- 暂停菜单里可关闭音效/观众（提升帧率），也可开关「视角跟随」（默认关闭）
- 支持蓝牙 Xbox 手柄与移动端触控轮盘

版本说明：
- 本版为 v${VER}，更新内容见游戏登录页左下角「版本 v${VER}（最近更新）」。

素材声明：
- 3D 模型与多数音效来自 CC0 免费素材包（KayKit / Quaternius / Kenney）；
  部分施法音效来自 p0ss 的 Spell Sounds Starter Pack，按 CC-BY-SA 3.0 使用。
- 完整署名与许可证见包内 CREDITS.md 与 licenses/ 目录。

GitHub: https://github.com/Roger-hunt/embercrown
在线版: https://game.needcoffee.icu
EOF

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/$NAME.zip"
( cd "$STAGE" && zip -qrX "$OUT_DIR/$NAME.zip" "$NAME" -x "*.DS_Store" )

SIZE="$(wc -c < "$OUT_DIR/$NAME.zip" | tr -d ' ')"
SHA="$(shasum -a 256 "$OUT_DIR/$NAME.zip" | cut -d' ' -f1)"

echo "打包完成"
echo "  产物   $OUT_DIR/$NAME.zip"
echo "  体积   $SIZE bytes"
echo "  sha256 $SHA"
echo "  源     $SRC/index.html"
echo
echo "接下来（发布 release 时才需要）："
echo "  1. GitHub 新建 tag v${VER}，附件名必须是 $NAME.zip"
echo "  2. 把 index.html 里的 aboutDownload 链接改成"
echo "     https://github.com/Roger-hunt/embercrown/releases/download/v$VER/$NAME.zip"
