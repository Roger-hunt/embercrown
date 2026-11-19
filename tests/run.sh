#!/bin/bash
# 一键回归：bash tests/run.sh [scope|server|ult|client ...]   不带参数 = 全部
# 每组都在隔离实例上跑（端口 3986 / 3987、临时数据目录），不碰线上进程和 data/。
# 退出码：0 全部通过（可含跳过）· 1 有失败。缺工具的组以「跳过」计，不算失败。
# 兼容：macOS 自带 bash 3.2 没有关联数组（declare -A），这里用 case 代替。
cd "$(dirname "$0")" || exit 2

cmd_of() {
  case "$1" in
    scope)  echo "node scope-check.js" ;;
    server) echo "bash server.test.sh" ;;
    ult)    echo "node ult.test.js" ;;
    client) echo "node client.test.js" ;;
    *)      echo "" ;;
  esac
}
what_of() {
  case "$1" in
    scope)  echo "静态检查：语法 + 先用后声明 + 遮蔽调用" ;;
    server) echo "服务器：口令/令牌/限流/蜜罐/代理/分段/压缩/重启" ;;
    ult)    echo "大招：键盘 4 与手柄 RB，单人与联机，不卡死" ;;
    client) echo "客户端：语音与超神音量、观众开关、英文门禁、首领语音" ;;
    *)      echo "" ;;
  esac
}

for p in 3986 3987; do (exec 3<>/dev/tcp/127.0.0.1/$p) 2>/dev/null && { echo "端口 $p 被占用，先停掉占用它的进程再跑测试"; exit 2; }; done

fail=0; skip=0; pass=0; summary=""
if [ $# -gt 0 ]; then ORDER="$@"; else ORDER="scope server ult client"; fi

for k in $ORDER; do
  c="$(cmd_of "$k")"
  [ -z "$c" ] && { echo "未知测试组: $k（可选 scope server ult client）"; exit 2; }
  echo; echo "=== $k — $(what_of "$k") ==="
  $c; rc=$?
  if [ $rc -eq 0 ]; then pass=$((pass+1)); summary="$summary  通过  $k
"
  elif [ $rc -eq 77 ]; then skip=$((skip+1)); summary="$summary  跳过  $k（缺工具，见上方 SKIP 行）
"
  else fail=$((fail+1)); summary="$summary  失败  $k（退出码 $rc）
"; fi
done
echo; echo "===== 汇总 ====="; printf '%s' "$summary"; echo "通过 $pass · 跳过 $skip · 失败 $fail"
[ $fail -eq 0 ]
