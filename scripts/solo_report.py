#!/usr/bin/env python3
"""单人难度实测报表：读取 solo_runs 表，输出可直接和 BALANCE-SOLO.md / balance_model.py 对照的指标。

用法：
    # 从服务器拉一份库（只读副本，别在线上库上跑分析）
    scp user@your-server:~/wow/data/telemetry.db* /tmp/tel/
    python3 scripts/solo_report.py /tmp/tel/telemetry.db
    python3 scripts/solo_report.py /tmp/tel/telemetry.db --model /tmp/bal.csv --csv /tmp/solo_wave.csv

--model 接 balance_model.py --csv 的输出，用来比对「模型预测清波耗时」与「实测波内时长」。
"""
import argparse
import csv
import json
import statistics
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


def pct(vals, q):
    if not vals:
        return 0.0
    s = sorted(vals)
    k = min(len(s) - 1, max(0, int(round((len(s) - 1) * q))))
    return s[k]


def bar(n, top, width=28):
    if not top:
        return ""
    return "█" * max(0, int(round(n / top * width)))


def load(db_path):
    con = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id, ts, ip, build, cls, start_wave, end_wave, resumed, reason, dur_sec, kills, dmg, waves_n, boons, payload "
        "FROM solo_runs ORDER BY ts"
    ).fetchall()
    runs = []
    for r in rows:
        try:
            p = json.loads(r["payload"])
        except Exception:
            continue
        p["_id"] = r["id"]
        p["_ts"] = r["ts"]
        p["_ip"] = r["ip"] or "?"
        p["_wave_col"] = r["end_wave"]
        p["_rows"] = r["waves_n"]
        p["_kills"] = r["kills"] or 0
        p["_dur"] = r["dur_sec"] or 0
        runs.append(p)
    return runs


def load_ip_list(path):
    """读自玩/测试 IP 清单。

    每行 `IP` 或 `IP@YYYY-MM-DD`（# 开头为注释）。带日期的只排除当天的局 ——
    IP 是动态分配的，不加日期限制的话，将来同一个 IP 落到真人手里会被误剔。
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
    """该局是否落在清单里（日期限定项只匹配当天，ts 为 UTC 串）。"""
    day = ts[:10]
    for e_ip, e_day in entries:
        if e_ip != ip:
            continue
        if e_day is None or e_day == day:
            return True
    return False


def is_noise(r, max_dur=15.0):
    """误触/秒退：0 击杀且在 max_dur 秒内结束，不代表一次真实尝试。"""
    return (r.get("_kills") or 0) == 0 and (r.get("_dur") or 0) < max_dur


def parse_ts(s):
    """库里 ts 是 UTC 的 ISO 串（…Z）。带 +08:00 的界会自动换算成 UTC。"""
    s = s.strip().replace("Z", "+00:00")
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def in_range(ts, rng):
    """rng 为 (lo, hi) 的 datetime 元组，任一端可为 None。"""
    if not rng:
        return False
    lo, hi = rng
    t = parse_ts(ts)
    return (lo is None or t >= lo) and (hi is None or t < hi)


def fmt_local(ts, tz_hours=8):
    """把 UTC 串转成带偏移的本地时间，方便人肉对照。"""
    dt = parse_ts(ts) + timedelta(hours=tz_hours)
    return dt.strftime("%m-%d %H:%M")


def load_model(path):
    out = {}
    if not path:
        return out
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                out[int(row["wave"])] = row
            except (KeyError, ValueError):
                pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("db")
    ap.add_argument("--model", help="balance_model.py --csv 的输出")
    ap.add_argument("--csv", help="把逐波聚合结果导出成 CSV")
    ap.add_argument("--min-waves", type=int, default=0, help="只看推进到至少 N 波的局")
    ap.add_argument("--exclude-ip", action="append", default=[], metavar="IP",
                    help="排除该 IP 的局（可重复）；IP 是动态时不可靠，优先用 --exclude-range")
    ap.add_argument("--exclude-id", action="append", default=[], type=int, metavar="ID",
                    help="排除指定 id 的局（可重复），id 见 --list")
    ap.add_argument("--exclude-range", action="append", default=[], metavar="LO~HI",
                    help="排除该时间窗内的局，可重复。例：2026-11-17T21:00+08:00~2026-11-17T21:40+08:00；"
                         "任一端可省略（~HI / LO~）")
    ap.add_argument("--list", action="store_true", help="只列出每局的 id/时间/IP，便于挑选要排除的局")
    ap.add_argument("--self-ips", default=str(Path(__file__).resolve().parent / "self_ips.txt"),
                    metavar="FILE", help="默认读取的自玩/测试 IP 清单，可用 --no-self-ips 关闭")
    ap.add_argument("--no-self-ips", action="store_true", help="不读默认清单")
    ap.add_argument("--no-noise", action="store_true", help="剔除 0 击杀且 <15s 的误触局")
    a = ap.parse_args()

    raw = load(a.db)
    if a.list:
        print("  id   UTC 时间         本机时间(+08:00)  IP               职业      波次  时长    结束")
        for r in raw:
            print("  %-4d %s  %s        %-17s %-8s w%-4d %6.0fs  %s" % (
                r["_id"], r["_ts"][:19].replace("T", " "), fmt_local(r["_ts"]),
                r["_ip"], r.get("cls") or "?", r.get("_wave_col") or 0,
                r.get("_dur") or 0, r.get("reason") or "?"))
        return

    exclude_ip = set(a.exclude_ip)
    self_entries = [] if a.no_self_ips else load_ip_list(a.self_ips)
    exclude_id = set(a.exclude_id)
    ranges = []
    for spec in a.exclude_range:
        if "~" not in spec:
            sys.exit("--exclude-range 需要 LO~HI 形式，例如 2026-11-17T21:00+08:00~2026-11-17T21:40+08:00")
        lo_s, hi_s = spec.split("~", 1)
        ranges.append((parse_ts(lo_s) if lo_s.strip() else None,
                       parse_ts(hi_s) if hi_s.strip() else None))

    runs = []
    n_self = n_noise = 0
    for r in raw:
        if (r["_ip"] in exclude_ip or ip_hit(r["_ip"], r["_ts"], self_entries)
                or r["_id"] in exclude_id or any(in_range(r["_ts"], g) for g in ranges)):
            n_self += 1
            continue
        if a.no_noise and is_noise(r):
            n_noise += 1
            continue
        if (r.get("_wave_col") or 0) < a.min_waves:
            continue
        runs.append(r)
    if not runs:
        sys.exit("solo_runs 里没有数据（先让玩家打几局，或检查上报端点是否通）")

    model = load_model(a.model)
    days = Counter(r["_ts"][:10] for r in runs)
    cls = Counter(r.get("cls") or "?" for r in runs)
    reason = Counter(r.get("reason") or "?" for r in runs)
    endw = [r.get("_wave_col") or 0 for r in runs]
    durs = [r.get("durSec") or 0 for r in runs]

    print("=" * 74)
    print("单人难度实测 · %d 局  (%s ~ %s)" % (len(runs), min(days), max(days)))
    print("=" * 74)
    if n_self or n_noise:
        bits = []
        if n_self:
            bits.append("排除自玩/测试局 %d 局" % n_self)
        if n_noise:
            bits.append("剔除误触 %d 局" % n_noise)
        print("筛选: " + "  ".join(bits) + "  （--no-self-ips / --no-noise 可关闭）")
    print("按天: " + "  ".join("%s:%d" % (d, days[d]) for d in sorted(days)))
    print("职业: " + "  ".join("%s:%d" % (k, v) for k, v in cls.most_common()))
    print("结束: " + "  ".join("%s:%d" % (k, v) for k, v in reason.most_common()))
    print("时长: 中位 %.0fs  均值 %.0fs  最长 %.0fs" % (pct(durs, .5), statistics.mean(durs), max(durs)))
    print("推进: 中位 P50 第 %.0f 波  P90 第 %.0f 波  最高 第 %d 波" % (pct(endw, .5), pct(endw, .9), max(endw)))

    # 死亡/退出波次分布
    print("\n-- 结束波次分布 " + "-" * 55)
    hist = Counter(endw)
    top = max(hist.values())
    for w in sorted(hist):
        mark = "首领波" if w % 5 == 0 else ""
        print("  第%3d波 %3d 局 %s %s" % (w, hist[w], bar(hist[w], top), mark))
    boss_death = sum(v for k, v in hist.items() if k % 5 == 0)
    print("  → 卡在首领波: %d 局 (%.0f%%)" % (boss_death, boss_death / len(runs) * 100))

    # 逐波聚合
    per = defaultdict(lambda: {"dur": [], "dmg": [], "hp": [], "k": [], "boss": [], "fail": 0, "n": 0})
    kills_type = Counter()
    kills_by_wave = defaultdict(Counter)
    boss_ttk = defaultdict(list)
    boss_seen = Counter()
    boss_clear = Counter()
    for r in runs:
        last = r.get("_wave_col") or 0
        for w in r.get("waves") or []:
            n = int(w.get("n") or 0)
            if n <= 0:
                continue
            d = per[n]
            d["n"] += 1
            d["dur"].append(float(w.get("dur") or 0))
            d["dmg"].append(float(w.get("dmg") or 0))
            d["hp"].append(float(w.get("hpPct") if w.get("hpPct") is not None else 100))
            d["k"].append(float(w.get("k") or 0))
            for t, c in (w.get("by") or {}).items():
                kills_type[t] += c
                kills_by_wave[n][t] += c
            if w.get("boss"):
                b = w["boss"]
                boss_ttk[b.get("t") or "?"].append(float(b.get("ttk") or 0))
                boss_seen[b.get("t") or "?"] += 1
            # 该波之后还有波 → 视为通过
            if last > n:
                if w.get("boss"):
                    boss_clear[w["boss"].get("t") or "?"] += 1
            else:
                d["fail"] += 1

    print("\n-- 逐波实测（vs 模型） " + "-" * 46)
    head = "  波次  样本  实测时长  模型清波  比值   受伤   残血%"
    print(head)
    rows_out = []
    for n in sorted(per):
        d = per[n]
        if not d["dur"]:
            continue
        md = pct(d["dur"], .5)
        row = {"wave": n, "runs": d["n"], "dur_med": round(md, 1),
               "dmg_med": round(pct(d["dmg"], .5), 1), "hp_med": round(pct(d["hp"], .5), 1),
               "k_med": round(pct(d["k"], .5), 1), "boss": 1 if n % 5 == 0 else 0}
        m = model.get(n)
        ratio = ""
        if m:
            try:
                mc = float(m["clear_s"])
                row["model_clear"] = round(mc, 1)
                row["ratio"] = round(md / mc, 2) if mc else ""
                ratio = "%6.2f" % (md / mc) if mc else "     -"
            except (KeyError, ValueError):
                ratio = "     -"
        else:
            ratio = "     -"
        print("  %4d  %4d  %7.1fs %8s %6s %6.0f %6.0f%s" % (
            n, d["n"], md, (("%.1fs" % row["model_clear"]) if "model_clear" in row else "-"),
            ratio, pct(d["dmg"], .5), pct(d["hp"], .5), "   ← 首领" if n % 5 == 0 else ""))
        rows_out.append(row)

    print("\n-- 小怪击杀构成 " + "-" * 55)
    tot = sum(kills_type.values()) or 1
    for t, c in kills_type.most_common(12):
        print("  %-12s %6d  %5.1f%%  %s" % (t, c, c / tot * 100, bar(c, kills_type.most_common(1)[0][1], 20)))

    if boss_seen:
        print("\n-- 首领表现 " + "-" * 59)
        print("  首领          遭遇  通过  通过率   TTK 中位")
        for t, n in boss_seen.most_common():
            ok = boss_clear.get(t, 0)
            print("  %-12s %5d %5d  %5.0f%%  %6.1fs" % (t[:12], n, ok, ok / n * 100, pct(boss_ttk[t], .5)))

    boon_pick = Counter()
    boon_reach = defaultdict(list)
    for r in runs:
        for b in r.get("boons") or []:
            boon_pick[b.get("n") or b.get("r") or "?"] += int(b.get("c") or 1)
        for b in r.get("boons") or []:
            boon_reach[b.get("n") or b.get("r") or "?"].append(r.get("_wave_col") or 0)
    if boon_pick:
        print("\n-- 祝福选择与推进 " + "-" * 51)
        print("  祝福              次数  选后平均推进波次")
        for name, c in boon_pick.most_common(10):
            print("  %-16s %5d  %8.1f" % (name[:16], c, statistics.mean(boon_reach[name])))

    if a.csv:
        with open(a.csv, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["wave", "runs", "dur_med", "model_clear", "ratio", "dmg_med", "hp_med", "k_med", "boss"])
            w.writeheader()
            w.writerows(rows_out)
        print("\n逐波聚合已导出: %s" % a.csv)


if __name__ == "__main__":
    main()
