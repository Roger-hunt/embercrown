#!/usr/bin/env python3
"""从 index.html 里剥掉「单人难度遥测」（供单机离线包使用）。

单机包不需要遥测：file:// 下本来就只写 localStorage，留着只是多 6 KB 死代码
和一个没有意义（也无数据可披露）的「数据与隐私」tab。本脚本把遥测模块、
全部调用点、以及关于弹窗里的 tab / 隐私面板一并删除；任何一处锚点对不上就报错退出，
绝不产出一个「看起来干净但还偷偷上报」的包。

用法: python3 scripts/strip-telemetry.py <src/index.html> <dst/index.html>
"""
import re
import sys


def die(msg):
    sys.exit("strip-telemetry: " + msg)


def main():
    if len(sys.argv) != 3:
        die("用法: strip-telemetry.py <src> <dst>")
    src, dst = sys.argv[1], sys.argv[2]
    s = open(src, encoding="utf-8").read()
    before = len(s.encode())

    # 1) 遥测模块整块（从注释头到 visibilitychange 钩子，含尾部空行）
    a = s.find("/* ================= 单人难度遥测")
    if a < 0:
        die("找不到遥测模块起点")
    b = s.find("document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && tp.on) tpEndRun('hide'); });", a)
    if b < 0:
        die("找不到 visibilitychange 钩子")
    b = s.index("\n", b) + 1
    if s[b:b + 1] == "\n":
        b += 1
    s = s[:a] + s[b:]

    # 1b) G1 访问打卡块（eccf 源里存在，上游不存在）
    va = s.find("/* 访问打卡（G1）")
    if va >= 0:
        vb = s.find("})();", va)
        if vb < 0:
            die("找不到访问打卡块结尾")
        vb = s.index("\n", vb) + 1
        s = s[:va] + s[vb:]

    # 2) 全部调用点（都是独占一行的语句）
    s, n = re.subn(
        r"^[ \t]*tp(?:StartRun|WaveStart|Kill|Hurt|WaveEnd|Boons|EndRun)\([^\n]*\);[ \t]*\n",
        "", s, flags=re.M)
    if n != 7:
        die("调用点删除了 %d 处，期望 7 处" % n)

    # 3) 关于弹窗的 tab 栏 + 信息面板开标签
    a = s.find('      <div class="about-tabs"')
    if a < 0:
        die("找不到 tab 栏")
    b = s.find('aria-labelledby="aboutTabInfo">', a)
    if b < 0:
        die("找不到 aboutPaneInfo 开标签")
    b = s.index("\n", b) + 1
    s = s[:a] + s[b:]

    # 4) 信息面板收尾 </div> + 隐私面板整块
    a = s.find('      </div>\n      <div class="about-pane" id="aboutPanePriv"')
    if a < 0:
        die("找不到隐私面板")
    b = s.find('      <button type="button" class="go" id="btnAboutClose">', a)
    if b < 0:
        die("找不到关于弹窗的确定按钮")
    s = s[:a] + s[b:]

    # 5) tab / 面板样式（到 .gate-card 之前为止）
    a = s.find(".about-tabs{")
    b = s.find(".gate-card{", a) if a >= 0 else -1
    if a < 0 or b < 0:
        die("找不到 tab 样式块")
    s = s[:a] + s[b:]

    # 6) tab 交互逻辑
    a = s.find("/* ---- 「关于」弹窗 tab")
    tail = "$('btnAbout').addEventListener('click', syncPrivOpt);\n"
    b = s.find(tail, a) if a >= 0 else -1
    if a < 0 or b < 0:
        die("找不到 tab 交互逻辑")
    s = s[:a] + s[b + len(tail):]

    # 7) tab / 隐私面板的 i18n
    a = s.find("  setQ('#aboutTabInfo', '关于', 'About');")
    tail = "  syncPrivOpt();\n"
    b = s.find(tail, a) if a >= 0 else -1
    if a < 0 or b < 0:
        die("找不到 tab i18n")
    s = s[:a] + s[b + len(tail):]

    # 8) 残留检查：任何遥测痕迹都算失败
    leftovers = [
        "tpHurt", "tpKill", "tpWaveStart", "tpWaveEnd", "tpStartRun", "tpEndRun",
        "tpBoons", "tpUploadAllowed", "tpUrl", "TP_URL", "TP_KEY", "TP_BUILD", "TP_OPT_KEY",
        "telemetry/solo", "telemetry/visit", "ec_visit_v1", "单人难度遥测",
        "aboutTabPriv", "aboutPanePriv", "aboutPaneInfo", "about-tabs", "about-tab ",
        "privCollectL", "privNeverL", "privUsageL", "privLead", "privOpt", "syncPrivOpt",
        "privH1", "privH2", "privH3",
        "ec_tp_optout", "ec_solo_log_v1",
    ]
    hit = [w for w in leftovers if w in s]
    if hit:
        die("仍有残留: " + ", ".join(hit))

    open(dst, "w", encoding="utf-8").write(s)
    after = len(s.encode())
    print("  剥离遥测  -%d B（%d → %d），关于弹窗恢复为单面板" % (before - after, before, after))


if __name__ == "__main__":
    main()
