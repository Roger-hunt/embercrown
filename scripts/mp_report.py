#!/usr/bin/env python3
"""多人对战（房间模式）报表：读 access_logs 里的 ws_join / ws_leave / round_end / combat_kill。

多人侧没有独立的对局表，数据都在 access_logs 的 detail JSON 里：
  ws_join    {created, bots, diff, fun, humans}
  ws_leave   {durSec, kills, deaths, dmg, roundKills, roundDeaths}
  round_end  {diff, bots, players:[{id,name,cls,bot,kills,deaths,dmg}]}
  combat_kill{src, killerBot, victimCls, victimBot, diff}

用法：
    python3 scripts/mp_report.py /tmp/tel/telemetry.db
    python3 scripts/mp_report.py /tmp/tel/telemetry.db --exclude-ip 203.0.113.10

注意：access_logs 里的 room 会复用（同一房打多局），所以对局时长必须按
「上一次 round_end 之后到本次 round_end」的击杀切分，不能直接拿房间全部击杀算。
"""
import argparse
import json
import sqlite3
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

KILL_TARGET = 15   # 与服务端 KILL_TARGET 默认值一致


def load_ip_list(path):
    """读自玩/测试 IP 清单，格式与 solo_report.py 一致：`IP` 或 `IP@YYYY-MM-DD`。

    裸 IP 只适合固定 IP 的测试机；动态 IP 必须带日期，否则以后同一个 IP
    落到真人手里会被永久误剔，而且报表不会报错。
    """
    if not path:
        return []
    p = Path(path)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        ip, _, day = line.partition("@")
        out.append((ip.strip(), day.strip() or None))
    return out


def ip_hit(ip, ts, entries):
    for e_ip, day in entries:
        if e_ip != ip:
            continue
        if day is None or (ts or "")[:10] == day:
            return True
    return False


def pt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def bar(n, top, width=24):
    return "" if not top else "█" * max(0, int(round(n / top * width)))


def q(vals, p):
    if not vals:
        return 0.0
    s = sorted(vals)
    return s[min(len(s) - 1, max(0, int(round((len(s) - 1) * p))))]


def load(db_path):
    con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT ts, ip, room, player_name, cls, event, detail FROM access_logs "
        "WHERE event IN ('ws_join','ws_leave','round_end','combat_kill') ORDER BY ts"
    ).fetchall()
    out = []
    for r in rows:
        try:
            d = json.loads(r["detail"]) if r["detail"] else {}
        except Exception:
            d = {}
        out.append(dict(ts=r["ts"], ip=r["ip"] or "?", room=r["room"] or "?",
                        name=r["player_name"] or "?", cls=r["cls"] or "?", event=r["event"], d=d))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("--exclude-ip", action="append", default=[], metavar="IP",
                    help="排除该 IP 的局（可重复），例如剔除自玩")
    ap.add_argument("--self-ips", default=str(Path(__file__).resolve().parent / "self_ips.txt"),
                    metavar="FILE", help="自玩/测试 IP 清单，默认读 scripts/self_ips.txt")
    ap.add_argument("--no-self-ips", action="store_true", help="不读默认清单")
    a = ap.parse_args()

    ev = load(a.db)
    ex = set(a.exclude_ip)
    entries = [] if a.no_self_ips else load_ip_list(a.self_ips)
    n_self = 0
    kept = []
    for e in ev:
        if e["ip"] in ex or ip_hit(e["ip"], e["ts"], entries):
            n_self += 1
            continue
        kept.append(e)
    ev = kept
    joins = [e for e in ev if e["event"] == "ws_join"]
    leaves = [e for e in ev if e["event"] == "ws_leave"]
    rounds = [e for e in ev if e["event"] == "round_end"]
    kills = [e for e in ev if e["event"] == "combat_kill"]
    if not joins:
        sys.exit("access_logs 里没有 ws_join 记录")

    print("=" * 78)
    print("多人对战实测 · %d 次进房 / %d 局 / %d 次击杀  (%s ~ %s)"
          % (len(joins), len(rounds), len(kills), ev[0]["ts"][5:16], ev[-1]["ts"][5:16]))
    if n_self:
        print("  已排除自玩/测试 IP 命中 %d 条事件（--no-self-ips 可看原始口径）" % n_self)
    print("=" * 78)

    # ── 进房与房间完成率 ──────────────────────────────
    created = [j for j in joins if j["d"].get("created")]
    joined = [j for j in joins if not j["d"].get("created")]
    rooms_all = {j["room"] for j in joins}
    rooms_done = {r["room"] for r in rounds}
    ips = {j["ip"] for j in joins}
    print("\n-- 进房与房间完成率 " + "-" * 54)
    print("  进房 %d 次 / %d 个房间 / %d 个 IP" % (len(joins), len(rooms_all), len(ips)))
    print("  新建房间 %d 次（%.0f%%）  加入已有房间 %d 次（%.0f%%）"
          % (len(created), len(created) / len(joins) * 100,
             len(joined), len(joined) / len(joins) * 100))
    print("  打出至少一局的房间 %d 个 → 房间完成率 %.0f%%"
          % (len(rooms_done), len(rooms_done) / len(rooms_all) * 100))
    humans_in = Counter(j["d"].get("humans") for j in joins)
    print("  进房时房内真人数: " + "  ".join("%s人:%d" % (k, v) for k, v in sorted(humans_in.items(), key=lambda x: (x[0] is None, x[0]))))

    # ── 输入方式（touch / pad / kbm）──────────────────
    # 字段是 v1.5.0patch3 起才采的，老数据里没有，全为空就跳过这节。
    inp_join = Counter((j["d"].get("input") or "") for j in joins)
    if inp_join.get("") != len(joins) and any(inp_join.get(k) for k in ("touch", "pad", "kbm")):
        print("\n-- 输入方式 " + "-" * 62)
        lbl = {"touch": "触屏", "pad": "手柄", "kbm": "键鼠", "": "未上报"}
        tot = len(joins)
        for k in ("touch", "kbm", "pad", ""):
            if inp_join.get(k):
                print("  %-4s %4d 次进房  %5.1f%%" % (lbl[k], inp_join[k], inp_join[k] / tot * 100))
        by = defaultdict(lambda: dict(n=0, k=0, d=0, dur=0))
        for e in leaves:
            key = e["d"].get("input") or ""
            x = by[key]
            x["n"] += 1
            x["k"] += e["d"].get("kills") or 0
            x["d"] += e["d"].get("deaths") or 0
            x["dur"] += e["d"].get("durSec") or 0
        if by:
            print("  会话表现：")
            for k in ("touch", "kbm", "pad", ""):
                x = by.get(k)
                if not x or not x["n"]:
                    continue
                print("    %-4s %4d 会话  均杀 %4.1f  均死 %4.1f  K/D %4.2f  均停留 %4.0fs"
                      % (lbl[k], x["n"], x["k"] / x["n"], x["d"] / x["n"],
                         x["k"] / max(1, x["d"]), x["dur"] / x["n"]))
        # round_end 里每个选手也带了 input，可直接看各输入的真人战绩
        rr = defaultdict(lambda: dict(n=0, k=0, d=0))
        for r in rounds:
            for p in r["d"].get("players") or []:
                if p.get("bot"):
                    continue
                x = rr[p.get("input") or ""]
                x["n"] += 1
                x["k"] += p.get("kills") or 0
                x["d"] += p.get("deaths") or 0
        if rr:
            print("  对局内真人（round_end 逐选手）：")
            for k in ("touch", "kbm", "pad", ""):
                x = rr.get(k)
                if not x or not x["n"]:
                    continue
                print("    %-4s %4d 人次  均杀 %4.1f  均死 %4.1f  K/D %4.2f"
                      % (lbl[k], x["n"], x["k"] / x["n"], x["d"] / x["n"], x["k"] / max(1, x["d"])))

    # ── 停留时长 ──────────────────────────────────
    open_, durs = {}, []
    for e in sorted(ev, key=lambda x: x["ts"]):
        if e["event"] not in ("ws_join", "ws_leave"):
            continue
        k = (e["room"], e["name"])
        if e["event"] == "ws_join":
            open_[k] = e["ts"]
        elif k in open_:
            durs.append((pt(e["ts"]) - pt(open_[k])).total_seconds())
            del open_[k]
    if durs:
        print("\n-- 会话停留时长 " + "-" * 60)
        print("  配对 %d 段  中位 %.0fs  均值 %.0fs  最长 %.0fs"
              % (len(durs), statistics.median(durs), statistics.mean(durs), max(durs)))
        for lo, hi, lbl in [(0, 15, "<15s"), (15, 60, "15-60s"), (60, 180, "1-3min"),
                            (180, 300, "3-5min"), (300, 10 ** 9, ">5min")]:
            n = sum(1 for x in durs if lo <= x < hi)
            print("  %-7s %3d 段 %5.1f%% %s" % (lbl, n, n / len(durs) * 100, bar(n, len(durs))))

    # ── 对局 ────────────────────────────────────
    if rounds:
        kk = defaultdict(list)
        for k in kills:
            kk[k["room"]].append(k["ts"])
        last, recs = {}, []
        for r in rounds:
            pl = r["d"].get("players", [])
            if not pl:
                continue
            mx = max(x["kills"] for x in pl)
            lo = last.get(r["room"])
            ks = [t for t in kk[r["room"]] if (lo is None or t >= lo) and t <= r["ts"]]
            dur = (pt(ks[-1]) - pt(ks[0])).total_seconds() if len(ks) > 1 else 0
            last[r["room"]] = r["ts"]
            recs.append(dict(ts=r["ts"], diff=r["d"].get("diff"), n=len(pl),
                             humans=sum(1 for x in pl if not x["bot"]), mx=mx,
                             kills=len(ks), dur=dur, players=pl))
        tg = [x for x in recs if x["mx"] >= KILL_TARGET]
        print("\n-- 对局节奏 " + "-" * 64)
        print("  %d 局：击杀达标 %d（%.0f%%）  超时 %d"
              % (len(recs), len(tg), len(tg) / len(recs) * 100, len(recs) - len(tg)))
        print("  时长中位 %.0fs   达标局 %.0fs   超时局 %.0fs"
              % (statistics.median([x["dur"] for x in recs]),
                 statistics.median([x["dur"] for x in tg]) if tg else 0,
                 statistics.median([x["dur"] for x in recs if x["mx"] < KILL_TARGET]) or 0))
        print("  单局总击杀中位 %.0f   场均人数 %.1f   双真人局 %d"
              % (statistics.median([x["kills"] for x in recs]),
                 statistics.mean([x["n"] for x in recs]),
                 sum(1 for x in recs if x["humans"] >= 2)))
        print("  难度: " + "  ".join("%s:%d" % (k, v) for k, v in
                                     Counter(x["diff"] for x in recs).most_common()))

        # ── 职业 ────────────────────────────────
        agg = defaultdict(lambda: dict(n=0, k=0, d=0, dmg=0, hn=0, hk=0, hd=0, bnn=0, bk=0, bd=0))
        for x in recs:
            for p in x["players"]:
                t = agg[p["cls"]]
                t["n"] += 1; t["k"] += p["kills"]; t["d"] += p["deaths"]; t["dmg"] += p["dmg"]
                if p["bot"]:
                    t["bnn"] += 1; t["bk"] += p["kills"]; t["bd"] += p["deaths"]
                else:
                    t["hn"] += 1; t["hk"] += p["kills"]; t["hd"] += p["deaths"]
        print("\n-- 职业表现（全部选手）" + "-" * 52)
        print("  职业      人次  均杀   均死   K/D    均伤害  伤害/杀")
        for c, t in sorted(agg.items(), key=lambda x: -(x[1]["k"] / x[1]["n"])):
            print("  %-8s %5d %6.2f %6.2f %6.2f %7.0f %8.0f"
                  % (c, t["n"], t["k"] / t["n"], t["d"] / t["n"],
                     t["k"] / max(1, t["d"]), t["dmg"] / t["n"], t["dmg"] / max(1, t["k"])))
        print("\n-- 真人 vs 机器人（人次 / 均杀 / 均死）" + "-" * 38)
        for c, t in sorted(agg.items()):
            print("  %-8s 真人 %3d / %4.1f / %4.1f     机器人 %3d / %4.1f / %4.1f"
                  % (c, t["hn"], t["hk"] / max(1, t["hn"]), t["hd"] / max(1, t["hn"]),
                     t["bnn"], t["bk"] / max(1, t["bnn"]), t["bd"] / max(1, t["bnn"])))

        # ── 真人名次 ────────────────────────────
        solo_rank, duo_rank = Counter(), Counter()
        for x in recs:
            hs = [p for p in x["players"] if not p["bot"]]
            order = sorted(x["players"], key=lambda p: -p["kills"])
            for h in hs:
                (duo_rank if len(hs) >= 2 else solo_rank)[order.index(h) + 1] += 1
        print("\n-- 真人名次（按击杀）" + "-" * 53)
        print("  单真人局: " + "  ".join("#%d:%d" % (k, v) for k, v in sorted(solo_rank.items())))
        print("  双真人局: " + "  ".join("#%d:%d" % (k, v) for k, v in sorted(duo_rank.items())))

    # ── 击杀来源 ─────────────────────────────────
    if kills:
        print("\n-- 击杀构成 " + "-" * 64)
        print("  来源: " + "  ".join("%s:%d" % (k, v) for k, v in
                                     Counter(k["d"].get("src") for k in kills).most_common()))
        print("  受害者职业: " + "  ".join("%s:%d" % (k, v) for k, v in
                                          Counter(k["d"].get("victimCls") for k in kills).most_common()))


if __name__ == "__main__":
    main()
