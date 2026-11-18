#!/bin/bash
# 服务器端回归：口令/令牌/限流/蜜罐/代理信任/分段请求/压缩/重启。隔离实例（端口 3986、临时数据目录），不碰线上。
# 需要 curl、sqlite3、node。
ROOT="${EC_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
for t in curl sqlite3 node; do command -v $t >/dev/null || { echo "SKIP 缺少命令 $t"; exit 77; }; done
# macOS 自带没有 timeout / gtimeout（那是 GNU coreutils），用一个纯 bash 的替代：
# 只用于「起进程、跑几秒、再杀掉」这一种场景，够用且不引依赖。
if ! command -v timeout >/dev/null 2>&1; then
  timeout() {
    local dur="$1"; shift
    "$@" & local tp=$!
    ( sleep "$dur"; kill -TERM "$tp" 2>/dev/null; sleep 2; kill -KILL "$tp" 2>/dev/null ) & local wk=$!
    wait "$tp" 2>/dev/null; local rc=$?
    kill "$wk" 2>/dev/null
    return "$rc"
  }
fi
T=$(mktemp -d "${TMPDIR:-/tmp}/ec-test-data-XXXXXX"); A=http://127.0.0.1:3986; J='Content-Type: application/json'
start() { HOST=127.0.0.1 PORT=3986 ADMIN_PORT=0 DEMO_PASS=pp-1 TRUST_PROXY=127.0.0.1 DB_PATH=$T/a.db SEC_LOG=$T/sec.log env -u DEBUG "$@" node "$ROOT/server.js" >>$T/out 2>&1 & P=$!; for i in $(seq 60); do curl -s -o /dev/null $A/healthz && return; sleep 0.1; done; cat $T/out; exit 1; }
c() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
ok() { [ "$2" = "$3" ] && echo "PASS $1 ($2)" || { echo "FAIL $1: got $2 want $3"; F=1; }; }
F=0; start
TOK=$(curl -s -H 'X-Forwarded-For: 9.0.0.1' -H "$J" -d '{"pass":"pp-1"}' $A/auth | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
R=$(curl -s -H 'X-Forwarded-For: 9.0.0.1' -H "$J" -d '{"pass":"pp-1"}' $A/auth); case "$R" in *debug*|*startWave*) echo "FAIL auth leaks debug/startWave: $R"; F=1;; *) echo "PASS auth response has no debug/startWave";; esac
ok "wrong pass code" "$(curl -s -H 'X-Forwarded-For: 9.0.0.2' -H "$J" -d '{"pass":"x"}' $A/auth | node -pe 'JSON.parse(require("fs").readFileSync(0)).code')" bad
ok "honeypot /shell.php" "$(c -H 'X-Forwarded-For: 9.0.0.3' $A/shell.php)" 403
ok "honeypot /.env.local served decoy" "$(c -H 'X-Forwarded-For: 9.0.0.3' $A/.env.local)" 200
ok "/shellfish not honeypot" "$(c $A/shellfish)" 404
ok "after honeypot: correct pass still works" "$(c -H 'X-Forwarded-For: 9.0.0.3' -H "$J" -d '{"pass":"pp-1"}' $A/auth)" 200
for i in $(seq 11); do c -H 'X-Forwarded-For: 9.0.0.4' -H "$J" -d '{"pass":"x"}' $A/auth >/dev/null; done
ok "limited IP: correct pass blocked" "$(c -H 'X-Forwarded-For: 9.0.0.4' -H "$J" -d '{"pass":"pp-1"}' $A/auth)" 429
ok "limited IP: valid token /rooms allowed" "$(c -H 'X-Forwarded-For: 9.0.0.4' -H "X-Demo-Token: $TOK" $A/rooms)" 200
ok "limited IP: valid token /auth allowed" "$(c -H 'X-Forwarded-For: 9.0.0.4' -H "$J" -d "{\"token\":\"$TOK\"}" $A/auth)" 200
n0=$(wc -l < $T/sec.log)
ok "forged token /rooms" "$(c -H 'X-Forwarded-For: 9.0.0.5' -H "X-Demo-Token: 9999999999999.abc" $A/rooms)" 401
ok "forged token /auth code" "$(curl -s -H 'X-Forwarded-For: 9.0.0.5' -H "$J" -d '{"token":"9999999999999.abc"}' $A/auth | node -pe 'JSON.parse(require("fs").readFileSync(0)).code')" expired
ok "bad tokens write no fail2ban lines" "$(( $(wc -l < $T/sec.log) - n0 ))" 0
curl -s -o /dev/null -H 'Sec-Fetch-Site: cross-site' -H 'X-Forwarded-For: 9.0.0.6' $A/wp-admin; ok "cross-site honeypot not in fail2ban log" "$(grep -c 9.0.0.6 $T/sec.log)" 0
ok "XFF from trusted proxy used" "$(sqlite3 -readonly $T/a.db "select count(*)>0 from access_logs where ip='9.0.0.2'")" 1
kill $P; wait $P 2>/dev/null; start
ok "token survives restart" "$(c -H "X-Demo-Token: $TOK" $A/rooms)" 200
ok "range 206" "$(curl -s -o /dev/null -w '%{http_code}/%{size_download}' -H 'Range: bytes=0-1' $A/greta_yell.mp3)" 206/2
ok "range suffix" "$(curl -s -o /dev/null -w '%{http_code}/%{size_download}' -H 'Range: bytes=-100' $A/godlike.mp3)" 206/100
ok "range unsatisfiable" "$(c -H 'Range: bytes=99999999-' $A/godlike.mp3)" 416
ok "gzip body identical" "$(curl -s --compressed $A/vendor/three.min.js | md5sum | cut -c1-32)" "$(md5sum < "$ROOT"/public/vendor/three.min.js | cut -c1-32)"
echo "INFO gzip sizes: three $(curl -s -H 'Accept-Encoding: gzip' $A/vendor/three.min.js | wc -c) / index $(curl -s -H 'Accept-Encoding: gzip' $A/ | wc -c) bytes"
ET=$(curl -sI $A/ | tr -d '\r' | awk -F': ' 'tolower($1)=="etag"{print $2}'); ok "304" "$(c -H "If-None-Match: $ET" $A/)" 304
ok "304 visit logged" "$(sqlite3 -readonly $T/a.db "select count(*) from access_logs where event='http_visit' and status=304")" 1
kill $P; wait $P 2>/dev/null
# untrusted peer: TRUST_PROXY names another proxy, so XFF from 127.0.0.1 must be ignored; also DEV_START_WAVE
start TRUST_PROXY=10.9.9.9 DEV_START_WAVE=15
curl -s -o /dev/null -H 'X-Forwarded-For: 6.6.6.6' -H "$J" -d '{"pass":"x"}' $A/auth
ok "XFF from untrusted peer ignored" "$(sqlite3 -readonly $T/a.db "select ip from access_logs where event='auth_fail' order by id desc limit 1")" 127.0.0.1
ok "DEV_START_WAVE passed" "$(curl -s -H "$J" -d '{"pass":"pp-1"}' $A/auth | node -pe 'JSON.parse(require("fs").readFileSync(0)).startWave')" 15
kill $P; wait $P 2>/dev/null
HOST=127.0.0.1 PORT=3986 ADMIN_PORT=0 DB_PATH=$T/b.db SEC_LOG=$T/s2.log DEMO_PASS= DEBUG= timeout 3 node "$ROOT/server.js" > $T/b.out 2>&1
ok "random pass printed" "$(grep -c '临时随机口令' $T/b.out)" 1
# 用非 -readonly 打开：库是 WAL 模式，-readonly 需要写 -shm 才能打开，会报 CANTOPEN(14)
ok "random pass not in DB" "$(sqlite3 $T/b.db "select count(*) from debug_logs where msg like '%随机口令%'")" 0
rm -rf $T; exit $F
